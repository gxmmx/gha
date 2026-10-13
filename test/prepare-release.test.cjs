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
  eventName = "pull_request",
  ref = "refs/pull/42/merge",
  pushedSha = "9999999999999999999999999999999999999999",
  associatedPulls = [],
  existingStatuses = [],
  existingReleases = [],
  historyEntries,
  statusesBySha = {},
  existingRefs = {},
  claimedTagSha = null,
  releasePlan,
} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-prepare-release-"));
  const outputFile = path.join(temp, "outputs");
  const eventFile = path.join(temp, "event.json");
  const headSha = "abcdef1234567890abcdef1234567890abcdef12";
  writeFileSync(outputFile, "");
  writeFileSync(
    eventFile,
    JSON.stringify(
      eventName === "push"
        ? { after: pushedSha }
        : { pull_request: { number: 42 } },
    ),
  );
  const requests = [];
  const sourcePlan = releasePlan ?? {
    schema_version: 1,
    repository: { owner: "gxmmx", name: "testproject" },
    source: {
      event: "push",
      run_id: 1234567,
      sha: pushedSha,
      target_branch: base,
      pull_request: null,
    },
    configuration: {
      stable_branch: configuredStableBranch,
      alpha_branch: null,
      beta_branch: configuredBetaBranch || null,
      rc_branch: null,
      version_format: "semver",
    },
    history: {
      stable_base_version: "0.1.0",
      stable_release_tag: null,
      stable_release_sha: null,
    },
    decision: {
      channel: base === "beta" ? "beta" : "stable",
      bump: "minor",
      reason: "release",
      release_required: true,
    },
    versions: {
      build_version: base === "beta" ? "0.2.0-beta.1" : "0.2.0",
      next_stable_version: "0.2.0",
      next_release_version: base === "beta" ? "0.2.0-beta.1" : "0.2.0",
      next_release_tag: base === "beta" ? "v0.2.0-beta.1" : "v0.2.0",
    },
  };
  const releaseHistory = historyEntries ?? [
    { sha: pushedSha, commit: { message: commits.join("\n\n") } },
  ];
  let tagSha = claimedTagSha;
  let createdDraft;
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
      request.url.startsWith("/repos/gxmmx/testproject/releases")
    ) {
      response.end(JSON.stringify(existingReleases));
    } else if (
      request.method === "GET" &&
      decodeURIComponent(request.url).startsWith(
        "/repos/gxmmx/testproject/git/ref/tags/",
      )
    ) {
      const ref = decodeURIComponent(request.url).split("/git/ref/")[1];
      const sha =
        ref === `tags/${sourcePlan.versions.next_release_tag}`
          ? tagSha
          : existingRefs[ref];
      if (sha)
        response.end(JSON.stringify({ object: { sha, type: "commit" } }));
      else {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not Found" }));
      }
    } else if (
      request.method === "POST" &&
      request.url === "/repos/gxmmx/testproject/git/refs"
    ) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.at(-1).body = JSON.parse(body);
        if (tagSha) {
          response.statusCode = 422;
          response.end(JSON.stringify({ message: "Reference already exists" }));
          return;
        }
        tagSha = JSON.parse(body).sha;
        response.end(
          JSON.stringify({
            ref: JSON.parse(body).ref,
            object: {
              sha: tagSha,
              type: "commit",
              url: "https://api.github.com/repos/gxmmx/testproject/git/commits/mock",
            },
          }),
        );
      });
    } else if (
      request.method === "POST" &&
      request.url === "/repos/gxmmx/testproject/releases"
    ) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        createdDraft = JSON.parse(body);
        requests.at(-1).body = createdDraft;
        response.end(JSON.stringify({ id: 55, ...createdDraft }));
      });
    } else if (
      request.method === "GET" &&
      request.url.startsWith(`/repos/gxmmx/testproject/commits/${pushedSha}?`)
    ) {
      response.end(
        JSON.stringify({
          sha: pushedSha,
          commit: { message: commits.join("\n\n") },
        }),
      );
    } else if (
      request.method === "GET" &&
      request.url.startsWith(`/repos/gxmmx/testproject/commits?`)
    ) {
      response.end(JSON.stringify(releaseHistory));
    } else if (
      request.method === "GET" &&
      request.url.startsWith(
        `/repos/gxmmx/testproject/commits/${pushedSha}/pulls`,
      )
    ) {
      response.end(JSON.stringify(associatedPulls));
    } else if (
      request.method === "GET" &&
      /^\/repos\/gxmmx\/testproject\/commits\/[a-f0-9]+\/statuses/.test(
        request.url,
      )
    ) {
      const sha = request.url.split("/commits/")[1].split("/")[0];
      response.end(
        JSON.stringify(
          sha === pushedSha ? existingStatuses : (statusesBySha[sha] ?? []),
        ),
      );
    } else if (
      request.method === "POST" &&
      request.url === `/repos/gxmmx/testproject/statuses/${pushedSha}`
    ) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.at(-1).body = JSON.parse(body);
        response.end(JSON.stringify({ ...JSON.parse(body), id: 1 }));
      });
    } else if (
      request.method === "GET" &&
      request.url === "/repos/gxmmx/testproject/pulls/42"
    ) {
      response.end(
        JSON.stringify({
          number: 42,
          title,
          labels: labels.map((name) => ({ name })),
          merged_at: eventName === "push" ? "2026-10-13T12:00:00Z" : null,
          merge_commit_sha: eventName === "push" ? pushedSha : null,
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
          GITHUB_SHA: pushedSha,
          GITHUB_REPOSITORY: "gxmmx/testproject",
          GITHUB_REF: ref,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: eventFile,
          GITHUB_RUN_ID: "1234567",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          INPUT_GITHUB_TOKEN: "test-token",
          INPUT_STABLE_BRANCH: configuredStableBranch,
          INPUT_BETA_BRANCH: configuredBetaBranch,
          INPUT_NO_RELEASE_LABEL: noReleaseLabel,
          INPUT_RELEASE_PLAN: JSON.stringify(sourcePlan),
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
      createdDraft,
      tagSha,
    };
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test("release-branch push snapshots the merged PR decision on the exact squash SHA", async () => {
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const result = await runPreparation({
    eventName: "push",
    ref: "refs/heads/main",
    pushedSha: sha,
    associatedPulls: [
      {
        number: 42,
        merged_at: "2026-10-13T12:00:00Z",
        merge_commit_sha: sha,
        base: { ref: "main" },
      },
    ],
    commits: ["feat(api): add the endpoint"],
  });
  assert.ifError(
    result.error &&
      new Error(
        `${errorText(result.error)}\n${JSON.stringify(result.requests)}`,
      ),
  );
  assert.equal(result.values.prepared, "true");
  assert.equal(result.values.release_required, "true");
  const status = result.requests.find((request) => request.method === "POST");
  assert.equal(status.url, `/repos/gxmmx/testproject/statuses/${sha}`);
  assert.equal(status.body.context, "gha/release-decision/stable");
  assert.equal(status.body.description, "v1;reason=release;bump=minor");
  assert.equal(result.values.attempt_id, `v0.2.0@${sha.slice(0, 12)}`);
  assert.equal(result.values.draft_release_id, "55");
  assert.equal(result.tagSha, sha);
  assert.equal(
    result.requests.find(
      (request) =>
        request.method === "POST" && request.url.endsWith("/git/refs"),
    ).body.sha,
    sha,
  );
  assert.equal(result.createdDraft.tag_name, "v0.2.0");
  assert.equal(result.createdDraft.draft, true);
  assert.match(result.createdDraft.body, /## Features/);
  assert.match(result.createdDraft.body, /gxmmx-release-attempt:v1/);
});

function predecessorFixture(statuses = [], existingReleases = []) {
  const pushedSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const predecessorSha = "1111111111111111111111111111111111111111";
  const baselineSha = "0000000000000000000000000000000000000000";
  const releasePlan = {
    schema_version: 1,
    repository: { owner: "gxmmx", name: "testproject" },
    source: {
      event: "push",
      run_id: 1234567,
      sha: pushedSha,
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
      stable_release_sha: baselineSha,
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
  const historyEntries = [
    { sha: pushedSha, commit: { message: "feat: current work" } },
    { sha: predecessorSha, commit: { message: "fix: previous work" } },
    { sha: baselineSha, commit: { message: "chore: baseline" } },
  ];
  return {
    options: {
      eventName: "push",
      ref: "refs/heads/main",
      pushedSha,
      releasePlan,
      historyEntries,
      statusesBySha: { [predecessorSha]: statuses },
      existingReleases,
      associatedPulls: [
        {
          number: 42,
          merged_at: "2026-10-13T12:00:00Z",
          merge_commit_sha: pushedSha,
          base: { ref: "main" },
        },
      ],
    },
    predecessorSha,
  };
}

test("stable preparation blocks a predecessor with no recorded decision", async () => {
  const fixture = predecessorFixture();
  const result = await runPreparation(fixture.options);
  assert.ok(result.error);
  assert.match(
    errorText(result.error),
    /unresolved predecessor commit.*decision is missing/i,
  );
  assert.ok(
    !result.requests.some((request) => request.url.endsWith("/git/refs")),
  );
  assert.equal(result.createdDraft, undefined);
});

test("stable preparation blocks a predecessor release attempt until it is published or abandoned", async () => {
  const sha = "1111111111111111111111111111111111111111";
  const record = {
    schema_version: 1,
    attempt_id: `v0.1.1@${sha.slice(0, 12)}`,
    tag: "v0.1.1",
    version: "0.1.1",
    source_sha: sha,
    plan: {},
  };
  const fixture = predecessorFixture(
    [
      {
        context: "gha/release-decision/stable",
        state: "success",
        description: "v1;reason=release;bump=patch",
      },
    ],
    [
      {
        id: 77,
        draft: true,
        prerelease: false,
        body: `<!-- gxmmx-release-attempt:v1 -->\n${JSON.stringify(record)}`,
      },
    ],
  );
  const result = await runPreparation(fixture.options);
  assert.ok(result.error);
  assert.match(
    errorText(result.error),
    /attempt is not published or abandoned/i,
  );
  assert.equal(result.createdDraft, undefined);
});

test("stable preparation proceeds when earlier release decisions are resolved", async () => {
  const fixture = predecessorFixture([
    {
      context: "gha/release-decision/stable",
      state: "success",
      description: "v1;reason=no-changes;bump=none",
    },
  ]);
  const result = await runPreparation(fixture.options);
  assert.equal(result.error, undefined);
  assert.equal(result.createdDraft?.tag_name, "v0.2.0");
});

test("stable preparation proceeds after an earlier attempt is explicitly abandoned", async () => {
  const sha = "1111111111111111111111111111111111111111";
  const record = {
    schema_version: 1,
    attempt_id: `v0.1.1@${sha.slice(0, 12)}`,
    tag: "v0.1.1",
    version: "0.1.1",
    source_sha: sha,
    plan: {},
    abandoned: { reason: "acceptance fixture", at: "2026-10-13T00:00:00Z" },
  };
  const fixture = predecessorFixture(
    [
      {
        context: "gha/release-decision/stable",
        state: "success",
        description: "v1;reason=release;bump=patch",
      },
    ],
    [
      {
        id: 77,
        draft: true,
        prerelease: false,
        body: `<!-- gxmmx-release-attempt:v1 -->\n${JSON.stringify(record)}`,
      },
    ],
  );
  const result = await runPreparation(fixture.options);
  assert.equal(result.error, undefined);
  assert.equal(result.createdDraft?.tag_name, "v0.2.0");
});

test("stable preparation catches a broken prior alias before claiming or creating a draft", async () => {
  const previousSha = "2222222222222222222222222222222222222222";
  const record = {
    schema_version: 1,
    attempt_id: `v0.1.0@${previousSha.slice(0, 12)}`,
    tag: "v0.1.0",
    version: "0.1.0",
    source_sha: previousSha,
    plan: {},
    major_alias_enabled: true,
  };
  const fixture = predecessorFixture(
    [
      {
        context: "gha/release-decision/stable",
        state: "success",
        description: "v1;reason=no-changes;bump=none",
      },
    ],
    [
      {
        id: 77,
        draft: false,
        prerelease: false,
        body: `<!-- gxmmx-release-attempt:v1 -->\n${JSON.stringify(record)}`,
      },
    ],
  );
  fixture.options.existingRefs = { "tags/v0": "b".repeat(40) };
  const result = await runPreparation(fixture.options);
  assert.ok(result.error);
  assert.match(errorText(result.error), /alias v0 is unresolved/i);
  assert.ok(
    !result.requests.some((request) => request.url.endsWith("/git/refs")),
  );
  assert.equal(result.createdDraft, undefined);
});

test("stale release plan fails before claiming the version tag", async () => {
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const stalePlan = {
    schema_version: 1,
    repository: { owner: "gxmmx", name: "testproject" },
    source: {
      event: "push",
      run_id: 1234567,
      sha: "1234567812345678123456781234567812345678",
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
      stable_release_tag: null,
      stable_release_sha: null,
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
  const result = await runPreparation({
    eventName: "push",
    ref: "refs/heads/main",
    pushedSha: sha,
    associatedPulls: [
      {
        number: 42,
        merged_at: "2026-10-13T12:00:00Z",
        merge_commit_sha: sha,
        base: { ref: "main" },
      },
    ],
    releasePlan: stalePlan,
  });
  assert.match(errorText(result.error), /stale/i);
  assert.equal(
    result.requests.some((request) => request.url.endsWith("/git/refs")),
    false,
  );
});

test("a version tag claimed by another source fails closed", async () => {
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const result = await runPreparation({
    eventName: "push",
    ref: "refs/heads/main",
    pushedSha: sha,
    associatedPulls: [
      {
        number: 42,
        merged_at: "2026-10-13T12:00:00Z",
        merge_commit_sha: sha,
        base: { ref: "main" },
      },
    ],
    claimedTagSha: "1234567812345678123456781234567812345678",
  });
  assert.match(
    `${errorText(result.error)} ${JSON.stringify(result.requests)}`,
    /claimed by a different source/i,
  );
  assert.equal(
    result.requests.some(
      (request) =>
        request.method === "POST" && request.url.endsWith("/releases"),
    ),
    false,
  );
});

test("retry reuses the draft plan and snapshotted notes", async () => {
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const plan = {
    schema_version: 1,
    repository: { owner: "gxmmx", name: "testproject" },
    source: {
      event: "push",
      run_id: 1234567,
      sha,
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
      stable_release_tag: null,
      stable_release_sha: null,
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
  const attempt = `v0.2.0@${sha.slice(0, 12)}`;
  const priorNotes = "## Features\n\n- Snapshotted note from first run";
  const record = {
    schema_version: 1,
    attempt_id: attempt,
    tag: "v0.2.0",
    version: "0.2.0",
    source_sha: sha,
    plan: { ...plan, attempt_id: attempt },
  };
  const result = await runPreparation({
    eventName: "push",
    ref: "refs/heads/main",
    pushedSha: sha,
    associatedPulls: [
      {
        number: 42,
        merged_at: "2026-10-13T12:00:00Z",
        merge_commit_sha: sha,
        base: { ref: "main" },
      },
    ],
    existingStatuses: [
      {
        context: "gha/release-decision/stable",
        state: "success",
        description: "v1;reason=release;bump=minor",
      },
    ],
    existingReleases: [
      {
        id: 66,
        tag_name: "v0.2.0",
        draft: true,
        body: `${priorNotes}\n\n<!-- gxmmx-release-attempt:v1 -->\n${JSON.stringify(record)}`,
      },
    ],
    claimedTagSha: sha,
    releasePlan: plan,
    commits: ["feat(api): changed after the attempt was created"],
  });
  assert.ifError(result.error);
  assert.equal(result.values.attempt_id, attempt);
  assert.equal(result.values.draft_release_id, "66");
  assert.equal(result.values.release_notes, priorNotes);
  assert.equal(
    result.requests.some((request) => request.url.endsWith("/releases")),
    false,
  );
  assert.equal(
    result.requests.some((request) => request.url.endsWith("/git/refs")),
    false,
  );
});

test("suppression on a release push is recorded and cannot change on retry", async () => {
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const mergedPull = {
    number: 42,
    merged_at: "2026-10-13T12:00:00Z",
    merge_commit_sha: sha,
    base: { ref: "main" },
  };
  const first = await runPreparation({
    eventName: "push",
    ref: "refs/heads/main",
    pushedSha: sha,
    associatedPulls: [mergedPull],
    labels: ["no-release"],
    commits: ["feat(api): add the endpoint"],
  });
  assert.ifError(first.error);
  assert.equal(first.values.reason, "suppressed");
  assert.equal(first.values.release_required, "false");
  assert.equal(
    first.requests.find((request) => request.method === "POST").body
      .description,
    "v1;reason=suppressed;bump=none",
  );

  const retry = await runPreparation({
    eventName: "push",
    ref: "refs/heads/main",
    pushedSha: sha,
    associatedPulls: [mergedPull],
    commits: ["docs: edited after merge"],
    existingStatuses: [
      {
        context: "gha/release-decision/stable",
        state: "success",
        description: "v1;reason=suppressed;bump=none",
      },
    ],
  });
  assert.ifError(retry.error);
  assert.equal(retry.values.reason, "suppressed");
  assert.equal(retry.values.release_required, "false");
  assert.equal(
    retry.requests.some((request) => request.method === "POST"),
    false,
  );
  assert.equal(
    retry.requests.some((request) => request.url.includes("/pulls/42")),
    false,
  );
});

test("direct pushes and squash SHA mismatches fail before recording a decision", async () => {
  const direct = await runPreparation({
    eventName: "push",
    ref: "refs/heads/main",
    pushedSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
  });
  assert.match(errorText(direct.error), /exact squash commit/i);
  assert.equal(
    direct.requests.some((request) => request.method === "POST"),
    false,
  );

  const mismatch = await runPreparation({
    eventName: "push",
    ref: "refs/heads/main",
    pushedSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    associatedPulls: [
      {
        number: 42,
        merged_at: "2026-10-13T12:00:00Z",
        merge_commit_sha: "1234567812345678123456781234567812345678",
        base: { ref: "main" },
      },
    ],
  });
  assert.match(errorText(mismatch.error), /exact squash commit/i);
  assert.equal(
    mismatch.requests.some((request) => request.method === "POST"),
    false,
  );
});

test("candidate decisions use a channel-specific status context", async () => {
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const result = await runPreparation({
    eventName: "push",
    ref: "refs/heads/beta",
    pushedSha: sha,
    base: "beta",
    configuredBetaBranch: "beta",
    associatedPulls: [
      {
        number: 42,
        merged_at: "2026-10-13T12:00:00Z",
        merge_commit_sha: sha,
        base: { ref: "beta" },
      },
    ],
  });
  assert.ifError(
    result.error &&
      new Error(
        `${errorText(result.error)} ${JSON.stringify(result.requests)}`,
      ),
  );
  assert.equal(result.values.channel, "beta");
  assert.equal(result.values.decision_context, "gha/release-decision/beta");
  assert.equal(
    result.requests.find((request) => request.method === "POST").body.context,
    "gha/release-decision/beta",
  );
});

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
