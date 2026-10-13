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
const sourceSha = "1234567890abcdef1234567890abcdef12345678";
const stableSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const earlierCandidateSha = "bcdefabcdefabcdefabcdefabcdefabcdefabcde";

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

async function plan({
  branch = "beta",
  head = sourceSha,
  commits,
  releases = [],
  tagShas = {},
  inputs = {},
}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-channel-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/repos/gxmmx/testproject") {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (url.pathname === "/repos/gxmmx/testproject/releases") {
      response.end(JSON.stringify(releases));
    } else if (url.pathname.startsWith("/repos/gxmmx/testproject/commits/")) {
      const tag = decodeURIComponent(url.pathname.split("/").at(-1));
      response.end(JSON.stringify({ sha: tagShas[tag] }));
    } else if (url.pathname === "/repos/gxmmx/testproject/commits") {
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
        GITHUB_SHA: head,
        GITHUB_REPOSITORY: "gxmmx/testproject",
        GITHUB_REF: `refs/heads/${branch}`,
        GITHUB_EVENT_NAME: "push",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        INPUT_GITHUB_TOKEN: "test-token",
        ...Object.fromEntries(
          Object.entries(inputs).map(([name, value]) => [
            `INPUT_${name.toUpperCase()}`,
            value,
          ]),
        ),
      },
    });
    const values = outputsFrom(outputFile);
    return { ...values, plan: JSON.parse(values.release_plan) };
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

const stableRelease = {
  tag_name: "v1.4.2",
  prerelease: false,
  draft: false,
};
const commitsWithFeature = [
  { sha: sourceSha, commit: { message: "fix: add candidate behavior" } },
  {
    sha: earlierCandidateSha,
    commit: { message: "docs: clarify candidate behavior" },
  },
  { sha: stableSha, commit: { message: "feat: released feature" } },
];

test("configured candidate branch publishes the next beta against its stable base", async () => {
  const result = await plan({
    releases: [
      stableRelease,
      { tag_name: "v1.4.3-beta.1", prerelease: true, draft: false },
    ],
    tagShas: { "v1.4.2": stableSha, "v1.4.3-beta.1": earlierCandidateSha },
    commits: commitsWithFeature,
    inputs: { beta_branch: "beta" },
  });

  assert.equal(result.channel, "beta");
  assert.equal(result.build_version, "1.4.3-beta.2");
  assert.equal(result.next_stable_version, "1.4.3");
  assert.equal(result.next_release_version, "1.4.3-beta.2");
  assert.equal(result.next_release_tag, "v1.4.3-beta.2");
  assert.equal(result.release_required, "true");
  assert.equal(result.plan.configuration.beta_branch, "beta");
  assert.equal(result.plan.history.stable_base_version, "1.4.2");
});

test("candidate counters are independent and PEP 440 changes versions but not tags", async () => {
  const result = await plan({
    releases: [
      stableRelease,
      { tag_name: "v1.4.3-beta.4", prerelease: true, draft: false },
    ],
    tagShas: { "v1.4.2": stableSha, "v1.4.3-beta.4": earlierCandidateSha },
    commits: commitsWithFeature,
    inputs: { alpha_branch: "alpha", version_format: "pep440" },
    branch: "alpha",
  });

  assert.equal(result.channel, "alpha");
  assert.equal(result.build_version, "1.4.3a1");
  assert.equal(result.next_release_version, "1.4.3a1");
  assert.equal(result.next_release_tag, "v1.4.3-alpha.1");
});

test("RC candidates use their own SemVer counter", async () => {
  const result = await plan({
    releases: [
      stableRelease,
      { tag_name: "v1.4.3-alpha.2", prerelease: true, draft: false },
      { tag_name: "v1.4.3-beta.4", prerelease: true, draft: false },
      { tag_name: "v1.4.3-rc.3", prerelease: true, draft: false },
    ],
    tagShas: {
      "v1.4.2": stableSha,
      "v1.4.3-alpha.2": earlierCandidateSha,
      "v1.4.3-beta.4": earlierCandidateSha,
      "v1.4.3-rc.3": earlierCandidateSha,
    },
    commits: commitsWithFeature,
    inputs: { alpha_branch: "alpha", beta_branch: "beta", rc_branch: "rc" },
    branch: "rc",
  });

  assert.equal(result.build_version, "1.4.3-rc.4");
  assert.equal(result.next_release_tag, "v1.4.3-rc.4");
});

test("a rerun of a published candidate source keeps its version", async () => {
  const result = await plan({
    releases: [
      stableRelease,
      { tag_name: "v1.4.3-beta.1", prerelease: true, draft: false },
    ],
    tagShas: { "v1.4.2": stableSha, "v1.4.3-beta.1": sourceSha },
    commits: commitsWithFeature,
    inputs: { beta_branch: "beta" },
  });

  assert.equal(result.next_release_version, "1.4.3-beta.1");
  assert.equal(result.next_release_tag, "v1.4.3-beta.1");
});

test("a candidate branch behind the latest stable release fails planning", async () => {
  await assert.rejects(
    plan({
      releases: [stableRelease],
      tagShas: { "v1.4.2": stableSha },
      commits: [
        { sha: sourceSha, commit: { message: "feat: add candidate behavior" } },
      ],
      inputs: { beta_branch: "beta" },
    }),
    (error) =>
      /behind the latest stable release/.test(error.stdout + error.stderr),
  );
});

test("overlapping channel branches and the repository default as candidate are rejected", async () => {
  for (const inputs of [
    { alpha_branch: "preview", beta_branch: "preview" },
    { rc_branch: "main" },
  ]) {
    await assert.rejects(
      plan({
        branch: "main",
        commits: [],
        inputs,
      }),
      (error) =>
        /channel branch configuration/.test(error.stdout + error.stderr),
    );
  }
});
