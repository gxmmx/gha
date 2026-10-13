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

async function runPushPlan({
  sourceSha = "1234567890abcdef1234567890abcdef12345678",
  labels = [],
  statuses = [],
  versionFormat = "semver",
  noReleaseLabel = "no-release",
  messages = ["feat: add reusable release workflow"],
  previousStableVersion = null,
} = {}) {
  const previousSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const commits = [
    { sha: sourceSha, commit: { message: messages[0] } },
    ...messages.slice(1).map((message, index) => ({
      sha: `bcdefabcdefabcdefabcdefabcdefabcdefabc${index}`,
      commit: { message },
    })),
    ...(previousStableVersion
      ? [{ sha: previousSha, commit: { message: "chore: prior release" } }]
      : []),
  ];
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end(
        JSON.stringify(
          previousStableVersion
            ? [
                {
                  tag_name: `v${previousStableVersion}`,
                  draft: false,
                  prerelease: false,
                  body: "",
                },
              ]
            : [],
        ),
      );
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end(
        JSON.stringify(
          previousStableVersion
            ? [
                {
                  name: `v${previousStableVersion}`,
                  commit: { sha: previousSha },
                },
              ]
            : [],
        ),
      );
    } else if (
      request.url ===
      `/repos/gxmmx/testproject/commits/v${previousStableVersion}`
    ) {
      response.end(JSON.stringify({ sha: previousSha }));
    } else if (
      request.url.startsWith(
        `/repos/gxmmx/testproject/commits/${sourceSha}/statuses`,
      )
    ) {
      response.end(JSON.stringify(statuses));
    } else if (
      request.url.startsWith(
        `/repos/gxmmx/testproject/commits/${sourceSha}/pulls`,
      )
    ) {
      response.end(
        JSON.stringify([
          {
            number: 42,
            merged_at: "2026-10-13T12:00:00Z",
            merge_commit_sha: sourceSha,
            base: { ref: "main" },
            labels: labels.map((name) => ({ name })),
          },
        ]),
      );
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits?")) {
      response.end(JSON.stringify(commits));
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
        GITHUB_RUN_ID: "5678",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_GITHUB_TOKEN: "test-token",
        INPUT_VERSION_FORMAT: versionFormat,
        INPUT_NO_RELEASE_LABEL: noReleaseLabel,
      },
    });
    return outputsFrom(outputFile);
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test("merged PR suppression clears release outputs and keeps the selected build profile", async () => {
  const values = await runPushPlan({
    labels: ["skip-release"],
    versionFormat: "pep440",
    noReleaseLabel: "skip-release",
  });
  assert.equal(values.reason, "suppressed");
  assert.equal(values.release_required, "false");
  assert.equal(values.next_release_version, "");
  assert.equal(values.next_release_tag, "");
  assert.equal(values.build_version, "0.0.0.dev5678");
  const plan = JSON.parse(values.release_plan);
  assert.equal(plan.configuration.version_format, "pep440");
  assert.equal(plan.decision.bump, "none");
  assert.equal(plan.decision.reason, "suppressed");
});

test("recorded release decision takes precedence over a changed PR label", async () => {
  const values = await runPushPlan({
    labels: ["no-release"],
    statuses: [
      {
        context: "gha/release-decision/stable",
        state: "success",
        description: "v1;reason=release;bump=minor",
      },
    ],
  });
  assert.equal(values.reason, "release");
  assert.equal(values.release_required, "true");
  assert.equal(values.next_release_version, "0.1.0");
  assert.equal(values.next_release_tag, "v0.1.0");
});

test("first stable release uses 0.1.0 for every release-worthy signal", async () => {
  for (const message of [
    "fix: handle empty input",
    "feat: add reusable release workflow",
    "feat!: replace the release interface",
  ]) {
    const values = await runPushPlan({ messages: [message] });
    assert.equal(
      values.bump,
      message.startsWith("fix")
        ? "patch"
        : message.includes("!")
          ? "major"
          : "minor",
    );
    assert.equal(values.next_stable_version, "0.1.0");
    assert.equal(values.next_release_version, "0.1.0");
    assert.equal(values.next_release_tag, "v0.1.0");
    assert.equal(values.release_required, "true");
  }
});

test("first stable release still skips history without a release-worthy signal", async () => {
  const values = await runPushPlan({
    messages: ["docs: clarify action usage"],
  });
  assert.equal(values.bump, "none");
  assert.equal(values.reason, "no-changes");
  assert.equal(values.release_required, "false");
  assert.equal(values.next_stable_version, "");
  assert.equal(values.next_release_version, "");
  assert.equal(values.next_release_tag, "");
});

test("published stable release remains the baseline for subsequent bumps", async () => {
  const values = await runPushPlan({
    messages: ["fix: handle empty input"],
    previousStableVersion: "0.1.0",
  });
  assert.equal(values.bump, "patch");
  assert.equal(values.next_stable_version, "0.1.1");
  assert.equal(values.next_release_version, "0.1.1");
  assert.equal(values.next_release_tag, "v0.1.1");
});

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
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
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
    assert.equal(values.build_version, "0.1.0");
    assert.equal(values.next_stable_version, "0.1.0");
    assert.equal(values.next_release_version, "0.1.0");
    assert.equal(values.next_release_tag, "v0.1.0");
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
    assert.equal(plan.versions.next_release_tag, "v0.1.0");
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

test("stable planner reuses the recorded plan for a published source SHA retry", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const sourceSha = "1234567890abcdef1234567890abcdef12345678";
  const recordedPlan = {
    schema_version: 1,
    repository: { owner: "gxmmx", name: "testproject" },
    source: {
      event: "push",
      run_id: 1234,
      sha: sourceSha,
      target_branch: "main",
      pull_request: null,
    },
    configuration: {
      stable_branch: "main",
      alpha_branch: null,
      beta_branch: null,
      rc_branch: null,
      version_format: "semver",
    },
    history: {
      stable_base_version: "0.1.0",
      stable_release_tag: "v0.1.0",
      stable_release_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    decision: {
      channel: "stable",
      bump: "minor",
      reason: "release",
      release_required: true,
    },
    versions: {
      build_version: "0.2.0",
      next_stable_version: "0.2.0",
      next_release_version: "0.2.0",
      next_release_tag: "v0.2.0",
    },
  };
  const attempt = {
    schema_version: 1,
    attempt_id: "v0.2.0@1234567890ab",
    tag: "v0.2.0",
    version: "0.2.0",
    source_sha: sourceSha,
    plan: { ...recordedPlan, attempt_id: "v0.2.0@1234567890ab" },
  };
  const releaseBody = `## Features\n\n- add endpoint\n\n<!-- gxmmx-release-attempt:v1 -->\n${JSON.stringify(attempt)}`;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end(
        JSON.stringify([
          {
            id: 42,
            tag_name: "v0.2.0",
            draft: false,
            prerelease: false,
            body: releaseBody,
          },
        ]),
      );
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end(
        JSON.stringify([{ name: "v0.2.0", commit: { sha: sourceSha } }]),
      );
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([
          { sha: sourceSha, commit: { message: "feat: add endpoint" } },
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
        GITHUB_RUN_ID: "5678",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_GITHUB_TOKEN: "test-token",
      },
    });
    const values = outputsFrom(outputFile);
    assert.equal(values.release_required, "true");
    assert.equal(values.next_release_version, "0.2.0");
    assert.equal(values.next_release_tag, "v0.2.0");
    assert.deepEqual(JSON.parse(values.release_plan), attempt.plan);
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("stable planner advances past a version tag claimed by another source", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const sourceSha = "1234567890abcdef1234567890abcdef12345678";
  const occupiedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end(
        JSON.stringify([{ name: "v0.1.0", commit: { sha: occupiedSha } }]),
      );
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([
          { sha: sourceSha, commit: { message: "feat: add feature" } },
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
    assert.equal(values.next_stable_version, "0.1.1");
    assert.equal(values.next_release_version, "0.1.1");
    assert.equal(values.next_release_tag, "v0.1.1");
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("PEP 440 stable release values keep a canonical SemVer tag", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const sourceSha = "1234567890abcdef1234567890abcdef12345678";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([
          { sha: sourceSha, commit: { message: "feat: add new endpoint" } },
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
        INPUT_VERSION_FORMAT: "pep440",
      },
    });
    const values = outputsFrom(outputFile);
    assert.equal(values.build_version, "0.1.0");
    assert.equal(values.next_stable_version, "0.1.0");
    assert.equal(values.next_release_version, "0.1.0");
    assert.equal(values.next_release_tag, "v0.1.0");
    const plan = JSON.parse(values.release_plan);
    assert.equal(plan.configuration.version_format, "pep440");
    assert.equal(plan.versions.build_version, values.next_release_version);
    assert.equal(plan.versions.next_release_tag, "v0.1.0");
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
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end("[]");
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

test("candidate planning orders stable releases numerically", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const sourceSha = "1234567890abcdef1234567890abcdef12345678";
  const latestStableSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const olderStableSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end(
        JSON.stringify([
          { tag_name: "v1.9.0", prerelease: false, draft: false },
          { tag_name: "v1.10.0", prerelease: false, draft: false },
        ]),
      );
    } else if (request.url === "/repos/gxmmx/testproject/commits/v1.9.0") {
      response.end(JSON.stringify({ sha: olderStableSha }));
    } else if (request.url === "/repos/gxmmx/testproject/commits/v1.10.0") {
      response.end(JSON.stringify({ sha: latestStableSha }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end("[]");
    } else if (
      request.url.startsWith(
        `/repos/gxmmx/testproject/commits/${sourceSha}/statuses`,
      )
    ) {
      response.end("[]");
    } else if (
      request.url.startsWith(
        `/repos/gxmmx/testproject/commits/${sourceSha}/pulls`,
      )
    ) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits?")) {
      response.end(
        JSON.stringify([
          {
            sha: sourceSha,
            commit: { message: "feat: add candidate feature" },
          },
          { sha: latestStableSha, commit: { message: "chore: v1.10.0" } },
          { sha: olderStableSha, commit: { message: "chore: v1.9.0" } },
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
        GITHUB_REF: "refs/heads/beta",
        GITHUB_EVENT_NAME: "push",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_GITHUB_TOKEN: "test-token",
        INPUT_BETA_BRANCH: "beta",
      },
    });
    const values = outputsFrom(outputFile);
    const plan = JSON.parse(values.release_plan);
    assert.equal(plan.history.stable_base_version, "1.10.0");
    assert.equal(values.next_stable_version, "1.11.0");
    assert.equal(values.next_release_tag, "v1.11.0-beta.1");
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
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
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

test("Git co-author trailers do not invalidate a Conventional Commit", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const sourceSha = "1234567890abcdef1234567890abcdef12345678";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([
          {
            sha: sourceSha,
            commit: {
              message:
                "feat: add reusable workflow\n\nCo-authored-by: OpenAI Codex <codex@openai.com>",
            },
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
    assert.equal(values.bump, "minor");
    assert.equal(values.next_stable_version, "0.1.0");
    assert.equal(values.release_required, "true");
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("pull request preview uses the PR head SHA and SemVer preview identifier", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  const eventFile = path.join(temp, "event.json");
  const headSha = "abcdef1234567890abcdef1234567890abcdef12";
  writeFileSync(outputFile, "");
  writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 42 } }));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url === "/repos/gxmmx/testproject/pulls/42") {
      response.end(
        JSON.stringify({ head: { sha: headSha }, base: { ref: "main" } }),
      );
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([
          { sha: headSha, commit: { message: "feat: add preview support" } },
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
        GITHUB_SHA: "9999999999999999999999999999999999999999",
        GITHUB_REPOSITORY: "gxmmx/testproject",
        GITHUB_REF: "refs/pull/42/merge",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_RUN_ID: "1234567",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_GITHUB_TOKEN: "test-token",
      },
    });
    const values = outputsFrom(outputFile);
    assert.equal(values.build_version, "0.1.0-pr.42.sha.abcdef12");
    assert.equal(values.next_stable_version, "0.1.0");
    assert.equal(values.next_release_version, "");
    assert.equal(values.next_release_tag, "");
    assert.equal(values.release_required, "false");
    assert.equal(values.commit_sha, headSha);
    const plan = JSON.parse(values.release_plan);
    assert.equal(plan.source.sha, headSha);
    assert.equal(plan.source.pull_request, 42);
    assert.equal(plan.source.target_branch, "main");
    assert.equal(plan.configuration.version_format, "semver");
    assert.equal(plan.versions.build_version, values.build_version);
    assert.equal(plan.versions.next_release_version, null);
    assert.equal(plan.versions.next_release_tag, null);
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

async function runPullRequestPreview({ versionFormat, commitMessage }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  const eventFile = path.join(temp, "event.json");
  const headSha = "abcdef1234567890abcdef1234567890abcdef12";
  writeFileSync(outputFile, "");
  writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 42 } }));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (request.url === "/repos/gxmmx/testproject/pulls/42") {
      response.end(
        JSON.stringify({ head: { sha: headSha }, base: { ref: "main" } }),
      );
    } else if (request.url.startsWith("/repos/gxmmx/testproject/releases")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/tags")) {
      response.end("[]");
    } else if (request.url.startsWith("/repos/gxmmx/testproject/commits")) {
      response.end(
        JSON.stringify([{ sha: headSha, commit: { message: commitMessage } }]),
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
        GITHUB_SHA: "9999999999999999999999999999999999999999",
        GITHUB_REPOSITORY: "gxmmx/testproject",
        GITHUB_REF: "refs/pull/42/merge",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_RUN_ID: "1234567",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_GITHUB_TOKEN: "test-token",
        INPUT_VERSION_FORMAT: versionFormat,
      },
    });
    return outputsFrom(outputFile);
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test("PEP 440 PR preview uses the workflow run ID and keeps release outputs empty", async () => {
  const values = await runPullRequestPreview({
    versionFormat: "pep440",
    commitMessage: "feat: add preview support",
  });
  assert.equal(values.build_version, "0.1.0.dev1234567");
  assert.equal(values.next_stable_version, "0.1.0");
  assert.equal(values.next_release_version, "");
  assert.equal(values.next_release_tag, "");
  const plan = JSON.parse(values.release_plan);
  assert.equal(plan.configuration.version_format, "pep440");
  assert.equal(plan.versions.build_version, "0.1.0.dev1234567");
  assert.equal(plan.versions.next_release_version, null);
  assert.equal(plan.versions.next_release_tag, null);
});

test("PR previews without a prospective version use the selected profile fallback", async (t) => {
  for (const [versionFormat, expected] of [
    ["semver", "sha-abcdef12"],
    ["pep440", "0.0.0.dev1234567"],
  ]) {
    await t.test(versionFormat, async () => {
      const values = await runPullRequestPreview({
        versionFormat,
        commitMessage: "docs: clarify installation",
      });
      assert.equal(values.build_version, expected);
      assert.equal(values.next_stable_version, "");
      assert.equal(values.next_release_version, "");
      assert.equal(values.next_release_tag, "");
      const plan = JSON.parse(values.release_plan);
      assert.equal(plan.configuration.version_format, versionFormat);
      assert.equal(plan.versions.next_stable_version, null);
      assert.equal(plan.versions.next_release_version, null);
      assert.equal(plan.versions.next_release_tag, null);
    });
  }
});
