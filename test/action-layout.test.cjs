const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const canonicalDirectory = path.resolve("actions/release/get-next-version");
const compatibilityDirectory = path.resolve("actions/get-next-version");

function actionMain(directory) {
  const metadata = readFileSync(path.join(directory, "action.yml"), "utf8");
  const match = metadata.match(/^  main: (.+)$/m);
  assert.ok(match, `${directory}/action.yml must declare a main entry point`);
  return path.resolve(directory, match[1]);
}

test("get-next-version canonical and compatibility paths share one bundle", () => {
  const canonicalMain = actionMain(canonicalDirectory);
  const compatibilityMain = actionMain(compatibilityDirectory);

  assert.equal(canonicalMain, path.join(canonicalDirectory, "dist/index.js"));
  assert.ok(existsSync(canonicalMain), "canonical bundle must exist");
  assert.equal(compatibilityMain, canonicalMain);
});
