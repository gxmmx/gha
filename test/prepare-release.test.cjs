const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const action = path.resolve("actions/release/prepare-release/dist/index.js");
const execFileAsync = promisify(execFile);

function outputsFrom(outputFile) {
  const lines = readFileSync(outputFile, "utf8").trimEnd().split("\n");
  const values = {};
  for (let index = 0; index < lines.length; index += 1) {
    const multiline = lines[index].match(/^([^<]+)<<(.+)$/);
    if (multiline) {
      const [, name, delimiter] = multiline;
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

function errorText(error) {
  return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
}

async function runPreparation({
  title = "docs(api): describe the new endpoint",
  commits = ["fix(api): guard empty requests", "feat(api): add the endpoint"],
  labels = [],
  base = "main",
  writeStatus = 200,
  configuredStableBranch = "main",
  configuredBetaBranch = "",
  noReleaseLabel = "no-release",
} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-prepare-release-"));
  const outputFile = path.join(temp, "outputs");
  const eventFile = path.join(temp, "event.json");
  const headSha = "abcdef1234567890abcdef1234567890abcdef12";
  writeFileSync(outputFile, "");
  writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 42 } }));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      request.url === "/repos/gxmmx/testproject"
    ) {
      response.end(JSON.stringify({ default_branch: "main" }));
    } else if (
      request.method === "GET" &&
      request.url === "/repos/gxmmx/testproject/pulls/42"
    ) {
      response.end(
        JSON.stringify({
          number: 42,
          title,
          labels: labels.map((name) => ({ name })),
          head: { sha: headSha },
          base: { ref: base },
        }),
      );
    } else if (
      request.method === "GET" &&
      request.url === "/repos/gxmmx/testproject/pulls/42/commits?per_page=100"
    ) {
      response.end(
        JSON.stringify(
          commits.map((message, index) => ({
            sha: `${index}`.padStart(40, "0"),
            commit: { message },
          })),
        ),
      );
    } else if (
      request.method === "PATCH" &&
      request.url === "/repos/gxmmx/testproject/pulls/42"
    ) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (writeStatus !== 200) {
          response.statusCode = writeStatus;
          response.end(JSON.stringify({ message: "Resource not accessible" }));
          return;
        }
        response.end(JSON.stringify({ ...JSON.parse(body), number: 42 }));
      });
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    let error;
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
          INPUT_STABLE_BRANCH: configuredStableBranch,
          INPUT_BETA_BRANCH: configuredBetaBranch,
          INPUT_NO_RELEASE_LABEL: noReleaseLabel,
        },
      });
    } catch (caught) {
      error = caught;
    }
    return {
      error,
      output: readFileSync(outputFile, "utf8"),
      values: readFileSync(outputFile, "utf8") ? outputsFrom(outputFile) : {},
      requests,
    };
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test("PR title uses strongest signal while preserving scope and description", async () => {
  const result = await runPreparation({
    title: "docs(api): describe the endpoint",
    commits: ["fix(api): guard empty requests", "feat(api): add the endpoint"],
  });
  assert.ifError(result.error);
  assert.equal(result.values.title, "feat(api): describe the endpoint");
  assert.equal(result.values.title_updated, "true");
});

test("breaking commit signal adds the breaking marker", async () => {
  const result = await runPreparation({
    title: "fix(api): describe the endpoint",
    commits: ["feat(api)!: change endpoint contract"],
  });
  assert.ifError(result.error);
  assert.equal(result.values.title, "feat(api)!: describe the endpoint");
});

test("breaking footer is preserved as a breaking title marker", async () => {
  const result = await runPreparation({
    title: "docs(api): describe the endpoint",
    commits: [
      "feat(api): change the contract\n\nBREAKING CHANGE: field removed",
    ],
  });
  assert.ifError(result.error);
  assert.equal(result.values.title, "feat(api)!: describe the endpoint");
});

test("stable PR with no release signal fails unless the no-release label is present", async () => {
  const rejected = await runPreparation({ commits: ["docs: clarify usage"] });
  assert.match(errorText(rejected.error), /release-worthy/i);

  const accepted = await runPreparation({
    commits: ["docs: clarify usage"],
    labels: ["no-release"],
  });
  assert.ifError(accepted.error);
  assert.equal(accepted.values.release_required, "false");
});

test("configured no-release label suppresses a release signal", async () => {
  const result = await runPreparation({
    commits: ["feat(api): add the endpoint"],
    labels: ["skip-release"],
    noReleaseLabel: "skip-release",
  });
  assert.ifError(result.error);
  assert.equal(result.values.bump, "none");
  assert.equal(result.values.release_required, "false");
  assert.equal(result.values.reason, "suppressed");
});

test("candidate branch configuration uses the shared channel model", async () => {
  const result = await runPreparation({
    base: "beta",
    configuredBetaBranch: "beta",
    commits: ["feat(api): add the endpoint"],
  });
  assert.ifError(result.error);
  assert.equal(result.values.channel, "beta");
  assert.equal(result.values.bump, "minor");
  assert.equal(result.values.release_required, "true");
});

test("malformed Conventional Commit history fails before title mutation", async () => {
  const result = await runPreparation({ commits: ["feat(api):"] });
  assert.match(errorText(result.error), /malformed conventional commit/i);
  assert.equal(
    result.requests.some((request) => request.method === "PATCH"),
    false,
  );
});

test("incomplete PR commit data fails before title mutation", async () => {
  const result = await runPreparation({ commits: [null] });
  assert.match(errorText(result.error), /history is incomplete/i);
  assert.equal(
    result.requests.some((request) => request.method === "PATCH"),
    false,
  );
});

test("missing pull request write permission is reported without failing validation", async () => {
  const result = await runPreparation({
    writeStatus: 403,
    title: "fix(api): describe the endpoint",
    commits: ["feat(api): add the endpoint"],
  });
  assert.ifError(result.error);
  assert.equal(result.values.title_updated, "false");
  assert.match(result.values.title_update_error, /pull-requests: write/i);
});

test("unconfigured target branch is a successful no-op without commit reads or title writes", async () => {
  const result = await runPreparation({
    base: "feature",
    configuredStableBranch: "main",
  });
  assert.ifError(result.error);
  assert.equal(result.values.prepared, "false");
  assert.equal(result.values.reason, "unmatched-branch");
  assert.equal(
    result.requests.some((request) => request.url.includes("/commits")),
    false,
  );
  assert.equal(
    result.requests.some((request) => request.method === "PATCH"),
    false,
  );
});
