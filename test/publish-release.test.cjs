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
const attemptAssetName = "gxmmx-release-attempt.json";
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

function stablePlan(version = "0.2.0") {
  const tag = `v${version}`;
  return {
    ...plan,
    source: { ...plan.source, target_branch: "main" },
    configuration: { ...plan.configuration, rc_branch: null },
    decision: { ...plan.decision, channel: "stable" },
    versions: {
      build_version: version,
      next_stable_version: version,
      next_release_version: version,
      next_release_tag: tag,
    },
    attempt_id: `${tag}@${sourceSha.slice(0, 12)}`,
  };
}

function releaseRecord(releasePlan, { aliasEnabled = true } = {}) {
  return {
    id: 77,
    tag_name: releasePlan.versions.next_release_tag,
    name: releasePlan.versions.next_release_tag,
    draft: false,
    prerelease: false,
    body: `<!-- gxmmx-release-attempt:v1 -->\n${JSON.stringify({
      schema_version: 1,
      attempt_id: releasePlan.attempt_id,
      tag: releasePlan.versions.next_release_tag,
      version: releasePlan.versions.next_release_version,
      source_sha: releasePlan.source.sha,
      plan: releasePlan,
      major_alias_enabled: aliasEnabled,
    })}`,
  };
}

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
  return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}\n${JSON.stringify((error?.publishState?.requests ?? []).map((request) => [request.method, request.path]))}`;
}

async function publish({
  releasePlan = plan,
  recordPlan = plan,
  receipt = "",
  releaseOverrides = {},
  tagSha = sourceSha,
  existingAssets = [],
  updateMajorAlias = "",
  existingReleases = [],
  existingRefs = {},
  existingAssetData = new Map(),
  failAttemptAssetUpload = false,
  corruptAttemptAssetUpload = false,
} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-publish-release-"));
  const outputFile = path.join(temp, "outputs");
  const eventFile = path.join(temp, "event.json");
  writeFileSync(outputFile, "");
  writeFileSync(eventFile, JSON.stringify({}));
  const activePlan = { ...plan, ...releasePlan };
  const planWithAttempt = activePlan;
  const attempt = {
    schema_version: 1,
    attempt_id: recordPlan.attempt_id,
    tag: recordPlan.versions.next_release_tag,
    version: recordPlan.versions.next_release_version,
    source_sha: recordPlan.source.sha,
    plan: { ...recordPlan, attempt_id: recordPlan.attempt_id },
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
      prerelease: activePlan.decision.channel !== "stable",
      tag_name: recordPlan.versions.next_release_tag,
      target_commitish: activePlan.source.target_branch,
      name: recordPlan.versions.next_release_tag,
      body: `## Features\n\n- add acceptance fixture\n\n${marker}\n${JSON.stringify(attempt)}`,
      ...releaseOverrides,
    },
    assets: [...existingAssets],
    assetData: new Map(existingAssetData),
    refs: { ...existingRefs },
    releases: [],
    operations: [],
    requests: [],
  };
  state.releases = [...existingReleases, state.release];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const decodedPath = decodeURIComponent(url.pathname);
    state.requests.push({ method: request.method, path: decodedPath });
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      url.pathname === "/repos/gxmmx/testproject/releases"
    ) {
      response.end(JSON.stringify(state.releases));
    } else if (
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
        if (name === attemptAssetName && failAttemptAssetUpload) {
          response.statusCode = 500;
          response.end(JSON.stringify({ message: "Upload failed" }));
          return;
        }
        if (name === attemptAssetName && corruptAttemptAssetUpload) {
          bytes[0] = bytes[0] ^ 1;
        }
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
        state.assetData.set(asset.id, bytes);
        state.operations.push({ operation: "upload", name, bytes });
        response.end(JSON.stringify(asset));
      });
    } else if (
      request.method === "GET" &&
      decodedPath.startsWith("/repos/gxmmx/testproject/releases/assets/")
    ) {
      const id = Number(decodedPath.split("/").at(-1));
      const bytes = state.assetData.get(id);
      if (!bytes) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not Found" }));
      } else {
        response.setHeader("content-type", "application/octet-stream");
        response.end(bytes);
      }
    } else if (
      request.method === "GET" &&
      decodedPath.startsWith("/repos/gxmmx/testproject/git/ref/tags/")
    ) {
      const name = decodedPath.split("/git/ref/")[1];
      const sha =
        name === `tags/${recordPlan.versions.next_release_tag}`
          ? tagSha
          : state.refs[name];
      if (sha)
        response.end(JSON.stringify({ object: { sha, type: "commit" } }));
      else {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not Found" }));
      }
    } else if (
      request.method === "POST" &&
      url.pathname === "/repos/gxmmx/testproject/git/refs"
    ) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const ref = JSON.parse(body);
        const name = ref.ref.replace(/^refs\//, "");
        if (state.refs[name]) {
          response.statusCode = 422;
          response.end(JSON.stringify({ message: "Reference already exists" }));
          return;
        }
        state.refs[name] = ref.sha;
        state.operations.push({
          operation: "create-ref",
          ref: name,
          sha: ref.sha,
        });
        response.end(
          JSON.stringify({
            ref: ref.ref,
            object: { sha: ref.sha, type: "commit" },
          }),
        );
      });
    } else if (
      request.method === "PATCH" &&
      decodedPath.startsWith("/repos/gxmmx/testproject/git/refs/")
    ) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const update = JSON.parse(body);
        const name = decodedPath.split("/git/refs/")[1];
        state.refs[name] = update.sha;
        state.operations.push({
          operation: "update-ref",
          ref: name,
          sha: update.sha,
        });
        response.end(
          JSON.stringify({
            ref: `refs/${name}`,
            object: { sha: update.sha, type: "commit" },
          }),
        );
      });
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
          INPUT_ATTEMPT_ID: recordPlan.attempt_id,
          INPUT_RELEASE_PLAN: JSON.stringify(planWithAttempt),
          INPUT_REGISTRY_RECEIPT: receipt,
          INPUT_UPDATE_MAJOR_ALIAS: updateMajorAlias,
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
      ["upload", "update-draft", "upload", "publish"],
    );
    assert.equal(result.state.operations[0].name, "release-receipt.json");
    assert.match(result.state.operations[1].body, /Registry artifacts/);
    assert.equal(result.state.operations[1].draft, true);
    assert.equal(result.state.operations[2].name, "gxmmx-release-attempt.json");
    assert.equal(result.state.operations[3].draft, false);
    assert.match(
      result.state.release.body,
      /https:\/\/registry\.npmjs\.org\/example\/0\.2\.0-rc\.1/,
    );
    const stored = JSON.parse(
      result.state.operations[1].body.split(
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
    assert.doesNotMatch(result.state.release.body, /gxmmx-release-attempt/);
    assert.deepEqual(
      result.state.operations.map((operation) => operation.operation),
      ["update-draft", "upload", "publish"],
    );
    assert.equal(result.state.operations[1].name, "gxmmx-release-attempt.json");
    assert.deepEqual(
      JSON.parse(result.state.operations[1].bytes.toString("utf8")),
      JSON.parse(
        result.state.operations[0].body.split(
          "<!-- gxmmx-release-attempt:v1 -->\n",
        )[1],
      ),
    );
  } finally {
    result.cleanup();
  }
});

test("stops before publication when the attempt asset cannot be saved", async () => {
  let error;
  try {
    await publish({ failAttemptAssetUpload: true });
  } catch (caught) {
    error = caught;
  }
  try {
    assert.ok(error);
    assert.deepEqual(
      error.publishState.operations.map((operation) => operation.operation),
      ["update-draft"],
    );
    assert.equal(error.publishState.release.draft, true);
  } finally {
    error?.cleanup?.();
  }
});

test("stops before publication when the attempt asset differs from the draft record", async () => {
  let error;
  try {
    await publish({ corruptAttemptAssetUpload: true });
  } catch (caught) {
    error = caught;
  }
  try {
    assert.ok(error);
    assert.match(errorText(error), /does not match/);
    assert.equal(
      error.publishState.operations.some(
        (operation) => operation.operation === "publish",
      ),
      false,
    );
    assert.equal(error.publishState.release.draft, true);
  } finally {
    error?.cleanup?.();
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

test("retries a published attempt from its JSON asset with reader-facing notes", async () => {
  const record = {
    schema_version: 1,
    attempt_id: plan.attempt_id,
    tag: plan.versions.next_release_tag,
    version: plan.versions.next_release_version,
    source_sha: plan.source.sha,
    plan,
    asset_manifest: { schema_version: 1, assets: [], checksum_asset: null },
  };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const digest = require("node:crypto")
    .createHash("sha256")
    .update(bytes)
    .digest("hex");
  const asset = {
    id: 42,
    name: attemptAssetName,
    size: bytes.length,
    digest: `sha256:${digest}`,
  };
  const result = await publish({
    releaseOverrides: {
      draft: false,
      body: "## Features\n\n- add acceptance fixture",
    },
    existingAssets: [asset],
    existingAssetData: new Map([[asset.id, bytes]]),
  });
  try {
    assert.equal(result.outputs.published, "true");
    assert.equal(
      result.state.release.body,
      "## Features\n\n- add acceptance fixture",
    );
    assert.deepEqual(result.state.operations, []);
  } finally {
    result.cleanup();
  }
});

test("rejects a published attempt asset that conflicts with the prepared source", async () => {
  const record = {
    schema_version: 1,
    attempt_id: plan.attempt_id,
    tag: plan.versions.next_release_tag,
    version: plan.versions.next_release_version,
    source_sha: "b".repeat(40),
    plan,
    asset_manifest: { schema_version: 1, assets: [], checksum_asset: null },
  };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const digest = require("node:crypto")
    .createHash("sha256")
    .update(bytes)
    .digest("hex");
  const asset = {
    id: 42,
    name: attemptAssetName,
    size: bytes.length,
    digest: `sha256:${digest}`,
  };
  let error;
  try {
    await publish({
      releaseOverrides: {
        draft: false,
        body: "## Features\n\n- add acceptance fixture",
      },
      existingAssets: [asset],
      existingAssetData: new Map([[asset.id, bytes]]),
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

test("publishes a stable release then creates its major alias by default", async () => {
  const stable = stablePlan();
  const result = await publish({ releasePlan: stable, recordPlan: stable });
  try {
    assert.equal(result.outputs.published, "true");
    assert.equal(result.state.refs["tags/v0"], sourceSha);
    assert.equal(result.state.release.draft, false);
    assert.deepEqual(
      result.state.operations.map((operation) => operation.operation),
      ["update-draft", "upload", "publish", "create-ref"],
    );
    const savedAttempt = JSON.parse(
      result.state.operations[0].body.split(
        "<!-- gxmmx-release-attempt:v1 -->\n",
      )[1],
    );
    assert.equal(savedAttempt.major_alias_enabled, true);
  } finally {
    result.cleanup();
  }
});

test("stable alias opt-out is persisted and does not move the alias", async () => {
  const result = await publish({
    releasePlan: stablePlan(),
    recordPlan: stablePlan(),
    updateMajorAlias: "false",
  });
  try {
    assert.equal(result.state.release.draft, false);
    assert.equal(result.state.refs["tags/v0"], undefined);
    assert.deepEqual(
      result.state.operations.map((operation) => operation.operation),
      ["update-draft", "upload", "publish"],
    );
    const savedAttempt = JSON.parse(
      result.state.operations[0].body.split(
        "<!-- gxmmx-release-attempt:v1 -->\n",
      )[1],
    );
    assert.equal(savedAttempt.major_alias_enabled, false);
  } finally {
    result.cleanup();
  }
});

test("retrying an already published stable attempt repairs its alias only", async () => {
  const stable = stablePlan();
  const release = releaseRecord(stable);
  const result = await publish({
    releasePlan: stable,
    recordPlan: stable,
    releaseOverrides: release,
  });
  try {
    assert.equal(result.outputs.published, "true");
    assert.equal(result.state.refs["tags/v0"], sourceSha);
    assert.deepEqual(
      result.state.operations.map((operation) => operation.operation),
      ["create-ref"],
    );
    assert.equal(result.state.release.draft, false);
  } finally {
    result.cleanup();
  }
});

test("later stable publication stops while an earlier enabled alias is broken", async () => {
  const earlier = stablePlan();
  const later = stablePlan("0.3.0");
  const resultPromise = publish({
    releasePlan: later,
    recordPlan: later,
    existingReleases: [releaseRecord(earlier)],
    existingRefs: {
      [`tags/${earlier.versions.next_release_tag}`]: sourceSha,
      "tags/v0": "b".repeat(40),
    },
  });
  let error;
  try {
    await resultPromise;
  } catch (caught) {
    error = caught;
  }
  try {
    assert.ok(error);
    assert.match(errorText(error), /alias v0 is unresolved/i);
    assert.deepEqual(error.publishState.operations, []);
  } finally {
    error?.cleanup?.();
  }
});

test("stable alias opt-out lets a later release proceed past a broken predecessor alias", async () => {
  const earlier = stablePlan();
  const later = stablePlan("0.3.0");
  const result = await publish({
    releasePlan: later,
    recordPlan: later,
    updateMajorAlias: "false",
    existingReleases: [releaseRecord(earlier)],
    existingRefs: {
      [`tags/${earlier.versions.next_release_tag}`]: sourceSha,
      "tags/v0": "b".repeat(40),
    },
  });
  try {
    assert.equal(result.state.release.draft, false);
    assert.equal(result.state.refs["tags/v0"], "b".repeat(40));
    assert.deepEqual(
      result.state.operations.map((operation) => operation.operation),
      ["update-draft", "upload", "publish"],
    );
  } finally {
    result.cleanup();
  }
});

test("a published attempt can explicitly disable a previously enabled alias", async () => {
  const stable = stablePlan();
  const release = releaseRecord(stable);
  const result = await publish({
    releasePlan: stable,
    recordPlan: stable,
    releaseOverrides: release,
    updateMajorAlias: "false",
  });
  try {
    assert.equal(result.state.release.draft, false);
    assert.equal(result.state.refs["tags/v0"], undefined);
    assert.deepEqual(
      result.state.operations.map((operation) => operation.operation),
      ["update-draft"],
    );
    const stored = JSON.parse(
      result.state.operations[0].body.split(
        "<!-- gxmmx-release-attempt:v1 -->\n",
      )[1],
    );
    assert.equal(stored.major_alias_enabled, false);
  } finally {
    result.cleanup();
  }
});
