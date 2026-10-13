const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const action = path.resolve("actions/release/publish/dist/index.js");
const execFileAsync = promisify(execFile);
const sourceSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const plan = {
  schema_version: 1,
  repository: { owner: "gxmmx", name: "testproject" },
  source: {
    event: "push",
    run_id: 1234,
    sha: sourceSha,
    target_branch: "release-acceptance",
    pull_request: null,
  },
  configuration: {
    stable_branch: "main",
    alpha_branch: null,
    beta_branch: null,
    rc_branch: "release-acceptance",
    version_format: "semver",
  },
  history: {
    stable_base_version: "0.1.0",
    stable_release_tag: null,
    stable_release_sha: null,
  },
  decision: {
    channel: "rc",
    bump: "minor",
    reason: "release",
    release_required: true,
  },
  versions: {
    build_version: "0.2.0-rc.1",
    next_stable_version: "0.2.0",
    next_release_version: "0.2.0-rc.1",
    next_release_tag: "v0.2.0-rc.1",
  },
  attempt_id: `v0.2.0-rc.1@${sourceSha.slice(0, 12)}`,
};

function outputsFrom(outputFile) {
  const values = {};
  const lines = readFileSync(outputFile, "utf8").trimEnd().split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const multiline = lines[index].match(/^([^<]+)<<(.+)$/);
    if (multiline) {
      const [, name, delimiter] = multiline;
      const end = lines.indexOf(delimiter, index + 1);
      values[name] = lines.slice(index + 1, end).join("\n");
      index = end;
    } else {
      const separator = lines[index].indexOf("=");
      if (separator >= 0) {
        values[lines[index].slice(0, separator)] = lines[index].slice(
          separator + 1,
        );
      }
    }
  }
  return values;
}

function errorText(error) {
  return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}\n${JSON.stringify(error?.publishState?.requests ?? [])}`;
}

async function publish({
  releasePlan = plan,
  receipt = "",
  releaseOverrides = {},
  tagSha = sourceSha,
  existingAssets = [],
} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-publish-release-"));
  const outputFile = path.join(temp, "outputs");
  const eventFile = path.join(temp, "event.json");
  writeFileSync(outputFile, "");
  writeFileSync(eventFile, JSON.stringify({}));
  const planWithAttempt = { ...plan, ...releasePlan };
  const attempt = {
    schema_version: 1,
    attempt_id: plan.attempt_id,
    tag: plan.versions.next_release_tag,
    version: plan.versions.next_release_version,
    source_sha: plan.source.sha,
    plan: { ...plan, attempt_id: plan.attempt_id },
    asset_manifest: {
      schema_version: 1,
      assets: [],
      checksum_asset: null,
    },
  };
  const marker = "<!-- gxmmx-release-attempt:v1 -->";
  const state = {
    release: {
      id: 55,
      draft: true,
      prerelease: true,
      tag_name: plan.versions.next_release_tag,
      target_commitish: plan.source.target_branch,
      name: plan.versions.next_release_tag,
      body: `## Features\n\n- add acceptance fixture\n\n${marker}\n${JSON.stringify(attempt)}`,
      ...releaseOverrides,
    },
    assets: [...existingAssets],
    operations: [],
    requests: [],
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const decodedPath = decodeURIComponent(url.pathname);
    state.requests.push({ method: request.method, path: decodedPath });
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      url.pathname === "/repos/gxmmx/testproject/releases/55"
    ) {
      response.end(JSON.stringify(state.release));
    } else if (
      request.method === "GET" &&
      url.pathname === "/repos/gxmmx/testproject/releases/55/assets"
    ) {
      response.end(JSON.stringify(state.assets));
    } else if (
      request.method === "POST" &&
      url.pathname === "/repos/gxmmx/testproject/releases/55/assets"
    ) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const name = url.searchParams.get("name");
        const digest = require("node:crypto")
          .createHash("sha256")
          .update(bytes)
          .digest("hex");
        const asset = {
          id: state.assets.length + 1,
          name,
          size: bytes.length,
          digest: `sha256:${digest}`,
          state: "uploaded",
        };
        state.assets.push(asset);
        state.operations.push({ operation: "upload", name, bytes });
        response.end(JSON.stringify(asset));
      });
    } else if (
      request.method === "GET" &&
      decodedPath ===
        `/repos/gxmmx/testproject/git/ref/tags/${plan.versions.next_release_tag}`
    ) {
      response.end(JSON.stringify({ object: { sha: tagSha, type: "commit" } }));
    } else if (
      request.method === "PATCH" &&
      url.pathname === "/repos/gxmmx/testproject/releases/55"
    ) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const update = JSON.parse(body);
        state.operations.push({
          operation: update.draft === false ? "publish" : "update-draft",
          body: update.body,
          draft: update.draft,
        });
        Object.assign(state.release, update);
        response.end(JSON.stringify(state.release));
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
      const result = await execFileAsync(process.execPath, [action], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputFile,
          GITHUB_REPOSITORY: "gxmmx/testproject",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_EVENT_PATH: eventFile,
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          INPUT_GITHUB_TOKEN: "test-token",
          INPUT_DRAFT_RELEASE_ID: "55",
          INPUT_ATTEMPT_ID: plan.attempt_id,
          INPUT_RELEASE_PLAN: JSON.stringify(planWithAttempt),
          INPUT_REGISTRY_RECEIPT: receipt,
        },
      });
      return {
        outputs: outputsFrom(outputFile),
        state,
        result,
        cleanup: () => rmSync(temp, { recursive: true, force: true }),
      };
    } catch (caught) {
      error = caught;
      error.publishState = state;
      error.cleanup = () => rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  } finally {
    server.close();
  }
}

test("stores the registry receipt on the draft before publishing the exact tag", async () => {
  const receipt = JSON.stringify({
    schema_version: 1,
    artifacts: [
      {
        registry: "npm",
        reference: "https://registry.npmjs.org/example/0.2.0-rc.1",
        digest: `sha256:${"b".repeat(64)}`,
      },
    ],
  });
  const result = await publish({ receipt });
  try {
    assert.equal(result.outputs.published, "true");
    assert.equal(result.outputs.tag, "v0.2.0-rc.1");
    assert.equal(result.outputs.source_sha, sourceSha);
    assert.equal(result.state.release.draft, false);
    assert.deepEqual(
      result.state.operations.map((operation) => operation.operation),
      ["upload", "update-draft", "publish"],
    );
    assert.equal(result.state.operations[0].name, "release-receipt.json");
    assert.match(result.state.operations[1].body, /Registry artifacts/);
    assert.equal(result.state.operations[1].draft, true);
    assert.equal(result.state.operations[2].draft, false);
    assert.match(
      result.state.release.body,
      /https:\/\/registry\.npmjs\.org\/example\/0\.2\.0-rc\.1/,
    );
    const stored = JSON.parse(
      result.state.operations[2].body.split(
        "<!-- gxmmx-release-attempt:v1 -->\n",
      )[1],
    );
    assert.equal(stored.attempt_id, plan.attempt_id);
    assert.deepEqual(stored.registry_receipt, JSON.parse(receipt));
    assert.ok(
      result.state.requests.every(
        (request) => request.path !== "/repos/gxmmx/testproject/git/refs",
      ),
    );
  } finally {
    result.cleanup();
  }
});

test("publishes an asset-free release without a registry receipt", async () => {
  const result = await publish();
  try {
    assert.equal(result.outputs.published, "true");
    assert.equal(result.state.release.draft, false);
    assert.deepEqual(
      result.state.operations.map((operation) => operation.operation),
      ["publish"],
    );
  } finally {
    result.cleanup();
  }
});

test("retries an already-published matching attempt without another update", async () => {
  const result = await publish({ releaseOverrides: { draft: false } });
  try {
    assert.equal(result.outputs.published, "true");
    assert.equal(result.state.release.draft, false);
    assert.deepEqual(result.state.operations, []);
  } finally {
    result.cleanup();
  }
});

test("rejects a mismatched prepared source before changing the draft", async () => {
  let error;
  try {
    await publish({
      releasePlan: {
        ...plan,
        source: { ...plan.source, sha: "c".repeat(40) },
      },
    });
  } catch (caught) {
    error = caught;
  }
  try {
    assert.ok(error);
    assert.match(errorText(error), /does not match|source|attempt/i);
    assert.deepEqual(error.publishState.operations, []);
  } finally {
    error?.cleanup?.();
  }
});

test("rejects a mismatched version or configuration before changing the draft", async () => {
  for (const releasePlan of [
    {
      ...plan,
      versions: { ...plan.versions, next_release_version: "0.3.0-rc.1" },
    },
    {
      ...plan,
      configuration: { ...plan.configuration, stable_branch: "stable" },
    },
  ]) {
    let error;
    try {
      await publish({ releasePlan });
    } catch (caught) {
      error = caught;
    }
    try {
      assert.ok(error);
      assert.match(errorText(error), /does not match|attempt|tag/i);
      assert.deepEqual(error.publishState.operations, []);
    } finally {
      error?.cleanup?.();
    }
  }
});

test("rejects a tag that points to a different commit before publication", async () => {
  let error;
  try {
    await publish({ tagSha: "c".repeat(40) });
  } catch (caught) {
    error = caught;
  }
  try {
    assert.ok(error);
    assert.match(errorText(error), /tag|source|commit/i);
    assert.deepEqual(error.publishState.operations, []);
  } finally {
    error?.cleanup?.();
  }
});

test("rejects assets that are not claimed by the prepared attempt", async () => {
  let error;
  try {
    await publish({
      existingAssets: [
        {
          id: 1,
          name: "unexpected.zip",
          size: 3,
          digest: `sha256:${"c".repeat(64)}`,
        },
      ],
    });
  } catch (caught) {
    error = caught;
  }
  try {
    assert.ok(error);
    assert.match(errorText(error), /not claimed/);
    assert.deepEqual(error.publishState.operations, []);
  } finally {
    error?.cleanup?.();
  }
});
