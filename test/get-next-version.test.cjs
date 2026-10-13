const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const action = path.resolve("actions/get-next-version/dist/index.js");
const execFileAsync = promisify(execFile);

function outputsFrom(outputFile) {
  const lines = readFileSync(outputFile, "utf8").trimEnd().split("\n");
  const values = {};
  for (let index = 0; index < lines.length; index += 1) {
    const multiline = lines[index].match(/^([^<]+)<<(.+)$/);
    if (multiline) {
      const [_, name, delimiter] = multiline;
      const end = lines.indexOf(delimiter, index + 1);
      values[name] = lines.slice(index + 1, end).join("\n");
      index = end;
    } else {
      const separator = lines[index].indexOf("=");
      values[lines[index].slice(0, separator)] = lines[index].slice(
        separator + 1,
      );
    }
  }
  return values;
}

test("unconfigured branch outputs a short-SHA build version and non-publishable plan", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ default_branch: "main" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await execFileAsync(process.execPath, [action], {
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: outputFile,
        GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
        GITHUB_REPOSITORY: "gxmmx/testproject",
        GITHUB_REF: "refs/heads/feature/first-build",
        GITHUB_EVENT_NAME: "push",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_GITHUB_TOKEN: "test-token",
      },
    });
    const values = outputsFrom(outputFile);
    assert.equal(values.build_version, "sha-12345678");
    assert.equal(values.next_stable_version, "");
    assert.equal(values.next_release_version, "");
    assert.equal(values.next_release_tag, "");
    assert.equal(values.release_required, "false");
    assert.equal(values.reason, "unmatched-branch");
    assert.equal(values.commit_sha, "1234567890abcdef1234567890abcdef12345678");
    assert.equal(values.channel, "");
    assert.equal(values.bump, "none");
    const plan = JSON.parse(values.release_plan);
    assert.equal(plan.schema_version, 1);
    assert.deepEqual(plan.repository, { owner: "gxmmx", name: "testproject" });
    assert.equal(plan.source.sha, "1234567890abcdef1234567890abcdef12345678");
    assert.equal(plan.decision.reason, "unmatched-branch");
    assert.equal(plan.decision.release_required, false);
    assert.equal(plan.versions.build_version, "sha-12345678");
    assert.equal(plan.versions.next_release_version, null);
    assert.equal(plan.decision.bump, "none");
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("stable push plans the strongest bump across unreleased commits", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const sourceSha = "1234567890abcdef1234567890abcdef12345678";
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([
          { sha: sourceSha, commit: { message: "feat: add new endpoint" } },
          {
            sha: "bcdefabcdefabcdefabcdefabcdefabcdefabcde",
            commit: { message: "fix: handle empty request" },
          },
          {
            sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
            commit: { message: "docs: update readme" },
          },
        ]),
      );
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await execFileAsync(process.execPath, [action], {
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: outputFile,
        GITHUB_SHA: sourceSha,
        GITHUB_REPOSITORY: "gxmmx/testproject",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "push",
        GITHUB_API_URL: apiUrl,
        INPUT_GITHUB_TOKEN: "test-token",
      },
    });
    const values = outputsFrom(outputFile);
    assert.equal(values.build_version, "0.2.0");
    assert.equal(values.next_stable_version, "0.2.0");
    assert.equal(values.next_release_version, "0.2.0");
    assert.equal(values.next_release_tag, "v0.2.0");
    assert.equal(values.release_required, "true");
    assert.equal(values.commit_sha, sourceSha);
    assert.equal(values.channel, "stable");
    assert.equal(values.bump, "minor");
    assert.equal(values.reason, "release");
    const plan = JSON.parse(values.release_plan);
    assert.equal(plan.schema_version, 1);
    assert.deepEqual(plan.repository, { owner: "gxmmx", name: "testproject" });
    assert.equal(plan.source.sha, sourceSha);
    assert.equal(plan.source.target_branch, "main");
    assert.equal(plan.history.stable_base_version, "0.1.0");
    assert.equal(plan.decision.channel, "stable");
    assert.equal(plan.decision.bump, "minor");
    assert.equal(plan.versions.next_release_tag, "v0.2.0");
    assert.equal(JSON.stringify(plan).includes("test-token"), false);
    assert.ok(requests.includes("/repos/gxmmx/testproject"));
    assert.ok(
      requests.some((url) =>
        url.startsWith("/repos/gxmmx/testproject/commits"),
      ),
    );
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("stable planning starts after the latest reachable stable release", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const sourceSha = "1234567890abcdef1234567890abcdef12345678";
  const baselineSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end(
        JSON.stringify([
          { tag_name: "v1.4.2", prerelease: false, draft: false },
        ]),
      );
    } else if (request.url === "/repos/gxmmx/testproject/commits/v1.4.2") {
      response.end(JSON.stringify({ sha: baselineSha }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([
          { sha: sourceSha, commit: { message: "fix: repair timeout" } },
          { sha: baselineSha, commit: { message: "feat: already released" } },
        ]),
      );
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await execFileAsync(process.execPath, [action], {
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: outputFile,
        GITHUB_SHA: sourceSha,
        GITHUB_REPOSITORY: "gxmmx/testproject",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "push",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_GITHUB_TOKEN: "test-token",
      },
    });
    const values = outputsFrom(outputFile);
    assert.equal(values.next_stable_version, "1.4.3");
    assert.equal(values.bump, "patch");
    assert.equal(values.release_required, "true");
    const plan = JSON.parse(values.release_plan);
    assert.equal(plan.history.stable_base_version, "1.4.2");
    assert.equal(plan.history.stable_release_sha, baselineSha);
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("malformed Conventional Commit-like history fails planning", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([
          {
            sha: "1234567890abcdef1234567890abcdef12345678",
            commit: { message: "feat(scope: missing close" },
          },
        ]),
      );
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [action], {
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_OUTPUT: outputFile,
          GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
          GITHUB_REPOSITORY: "gxmmx/testproject",
          GITHUB_REF: "refs/heads/main",
          GITHUB_EVENT_NAME: "push",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          INPUT_GITHUB_TOKEN: "test-token",
        },
      }),
      (error) =>
        /Malformed Conventional Commit message/.test(
          error.stdout + error.stderr,
        ),
    );
    assert.equal(readFileSync(outputFile, "utf8"), "");
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
