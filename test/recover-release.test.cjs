const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const action = path.resolve("actions/release/recover/dist/index.js");
const execFileAsync = promisify(execFile);
const marker = "<!-- gxmmx-release-attempt:v1 -->";

function outputValues(file) {
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
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

function attempt() {
  const plan = {
    schema_version: 1,
    repository: { owner: "gxmmx", name: "testproject" },
    source: {
      event: "push",
      run_id: 123,
      sha: "99a022e86cc23d87faaa8d1db8a68a34f4b76366",
      target_branch: "beta",
      pull_request: null,
    },
    configuration: {
      stable_branch: "main",
      alpha_branch: null,
      beta_branch: "beta",
      rc_branch: "rc",
      version_format: "pep440",
    },
    history: {
      stable_base_version: "0.1.0",
      stable_release_tag: null,
      stable_release_sha: null,
    },
    decision: {
      channel: "beta",
      bump: "minor",
      reason: "release",
      release_required: true,
    },
    versions: {
      build_version: "0.2.0b1",
      next_stable_version: "0.2.0",
      next_release_version: "0.2.0b1",
      next_release_tag: "v0.2.0-beta.1",
    },
    attempt_id: "v0.2.0-beta.1@99a022e86cc2",
  };
  return {
    schema_version: 1,
    attempt_id: plan.attempt_id,
    tag: "v0.2.0-beta.1",
    version: "0.2.0b1",
    source_sha: plan.source.sha,
    plan,
    asset_manifest: {
      schema_version: 1,
      assets: [{ name: "dist.tgz", size: 42, sha256: "a".repeat(64) }],
      checksum_asset: { name: "SHA256SUMS", size: 99, sha256: "b".repeat(64) },
    },
    registry_receipt: {
      schema_version: 1,
      artifacts: [
        {
          registry: "npm",
          reference: "pkg@0.2.0b1",
          digest: `sha256:${"c".repeat(64)}`,
        },
      ],
    },
  };
}

async function runRecovery({
  operation,
  reason,
  record = attempt(),
  draft = true,
}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-recover-release-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  let release = {
    id: 411790045,
    tag_name: record.tag,
    name: record.tag,
    draft,
    prerelease: true,
    body: `## Notes snapshot\n\n${marker}\n${JSON.stringify(record)}`,
    assets: [
      {
        name: "dist.tgz",
        size: 42,
        digest: `sha256:${"a".repeat(64)}`,
        browser_download_url: "https://example.test/dist.tgz",
      },
    ],
  };
  const mutations = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      request.url.startsWith("/repos/gxmmx/testproject/releases")
    ) {
      response.end(JSON.stringify([release]));
    } else if (
      request.method === "PATCH" &&
      request.url === "/repos/gxmmx/testproject/releases/411790045"
    ) {
      let body = "";
      for await (const chunk of request) body += chunk;
      const update = JSON.parse(body);
      mutations.push(update);
      release = { ...release, ...update };
      response.end(JSON.stringify(release));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "gxmmx/testproject",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: record.source_sha,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      INPUT_GITHUB_TOKEN: "test-token",
      INPUT_OPERATION: operation,
      INPUT_ATTEMPT_ID: record.attempt_id,
    };
    if (reason !== undefined) env.INPUT_REASON = reason;
    await execFileAsync(process.execPath, [action], { env });
    return { outputs: outputValues(outputFile), release, mutations };
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test("resume restores the original plan, notes, receipt, and staged asset manifest", async () => {
  const { outputs, mutations } = await runRecovery({ operation: "resume" });
  const record = attempt();
  assert.equal(outputs.attempt_id, record.attempt_id);
  assert.equal(outputs.release_id, "411790045");
  assert.equal(outputs.version, "0.2.0b1");
  assert.equal(outputs.release_notes, "## Notes snapshot");
  assert.equal(
    JSON.parse(outputs.release_plan).configuration.version_format,
    "pep440",
  );
  assert.deepEqual(JSON.parse(outputs.asset_manifest), record.asset_manifest);
  assert.deepEqual(
    JSON.parse(outputs.registry_receipt),
    record.registry_receipt,
  );
  assert.deepEqual(JSON.parse(outputs.release_assets), [
    {
      name: "dist.tgz",
      size: 42,
      digest: `sha256:${"a".repeat(64)}`,
      download_url: "https://example.test/dist.tgz",
    },
  ]);
  assert.deepEqual(mutations, []);
});

test("abandon records a reason while retaining the draft and its version claim", async () => {
  const { outputs, release, mutations } = await runRecovery({
    operation: "abandon",
    reason: "Upstream registry rejected the package metadata",
  });
  const saved = JSON.parse(release.body.split(marker)[1].trim());
  assert.equal(outputs.attempt_state, "abandoned");
  assert.equal(
    saved.abandoned.reason,
    "Upstream registry rejected the package metadata",
  );
  assert.equal(release.draft, true);
  assert.equal(release.tag_name, "v0.2.0-beta.1");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].tag_name, "v0.2.0-beta.1");
  assert.equal(mutations[0].name, "v0.2.0-beta.1");
  assert.equal(mutations[0].draft, true);
  assert.equal(mutations[0].prerelease, true);
});

test("abandon requires a reason", async () => {
  await assert.rejects(runRecovery({ operation: "abandon" }), (error) =>
    /reason is required/.test(`${error.stdout}\n${error.stderr}`),
  );
});
