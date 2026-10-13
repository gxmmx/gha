const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const action = path.resolve("actions/get-next-version/dist/index.js");

test("unconfigured branch outputs a short-SHA build version and non-publishable plan", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-action-test-"));
  const outputFile = path.join(temp, "outputs");
  writeFileSync(outputFile, "");
  try {
    execFileSync(process.execPath, [action], {
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: outputFile,
        GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
        GITHUB_REPOSITORY: "gxmmx/testproject",
        GITHUB_REF: "refs/heads/feature/first-build",
        GITHUB_EVENT_NAME: "push",
      },
    });
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
    assert.equal(values.build_version, "sha-12345678");
    assert.equal(values.next_stable_version, "");
    assert.equal(values.next_release_version, "");
    assert.equal(values.next_release_tag, "");
    assert.equal(values.release_required, "false");
    assert.equal(values.reason, "unmatched-branch");
    assert.equal(values.commit_sha, "1234567890abcdef1234567890abcdef12345678");
    assert.equal(values.channel, "");
    assert.equal(values.bump, "");
    const plan = JSON.parse(values.release_plan);
    assert.equal(plan.schema_version, 1);
    assert.equal(plan.repository, "gxmmx/testproject");
    assert.equal(plan.source.sha, "1234567890abcdef1234567890abcdef12345678");
    assert.equal(plan.decision.reason, "unmatched-branch");
    assert.equal(plan.decision.release_required, false);
    assert.equal(plan.versions.build_version, "sha-12345678");
    assert.equal(plan.versions.next_release_version, null);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
