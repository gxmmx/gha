const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const action = path.resolve("actions/release/stage-assets/dist/index.js");
const execFileAsync = promisify(execFile);

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
  return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
}

async function stage({ assets, files, release, storedAssets = [] }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "gha-stage-assets-"));
  const checkout = path.join(temp, "checkout");
  const outputFile = path.join(temp, "outputs");
  const eventFile = path.join(temp, "event.json");
  require("node:fs").mkdirSync(checkout);
  writeFileSync(outputFile, "");
  writeFileSync(eventFile, JSON.stringify({}));
  for (const [file, content] of Object.entries(files)) {
    const fullPath = path.join(checkout, file);
    require("node:fs").mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  const state = {
    release: { ...release },
    assets: [...storedAssets],
    uploads: [],
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url, "http://localhost");
    if (
      url.pathname === "/repos/gxmmx/testproject/releases/55" &&
      request.method === "GET"
    ) {
      response.end(JSON.stringify(state.release));
    } else if (
      url.pathname === "/repos/gxmmx/testproject/releases/55" &&
      request.method === "PATCH"
    ) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        Object.assign(state.release, JSON.parse(body));
        response.end(JSON.stringify(state.release));
      });
    } else if (
      url.pathname === "/repos/gxmmx/testproject/releases/55/assets" &&
      request.method === "GET"
    ) {
      response.end(JSON.stringify(state.assets));
    } else if (
      url.pathname === "/repos/gxmmx/testproject/releases/55/assets" &&
      request.method === "POST"
    ) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const name = url.searchParams.get("name");
        const uploaded = {
          id: state.assets.length + 1,
          name,
          size: bytes.length,
          digest: `sha256:${require("node:crypto").createHash("sha256").update(bytes).digest("hex")}`,
          state: "uploaded",
        };
        state.assets.push(uploaded);
        state.uploads.push({ ...uploaded, bytes });
        response.end(JSON.stringify(uploaded));
      });
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const result = await execFileAsync(process.execPath, [action], {
      cwd: checkout,
      env: {
        ...process.env,
        INPUT_GITHUB_TOKEN: "test-token",
        INPUT_DRAFT_RELEASE_ID: "55",
        INPUT_ATTEMPT_ID: "v0.2.0@aaaaaaaaaaaa",
        INPUT_ASSETS: assets,
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: "gxmmx/testproject",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_OUTPUT: outputFile,
      },
    });
    return {
      outputs: outputsFrom(outputFile),
      state,
      result,
      cleanup: () => rmSync(temp, { recursive: true, force: true }),
    };
  } catch (error) {
    error.stageState = state;
    error.cleanup = () => rmSync(temp, { recursive: true, force: true });
    throw error;
  } finally {
    server.close();
  }
}

const draft = {
  id: 55,
  draft: true,
  tag_name: "v0.2.0",
  body: 'Release notes\n\n<!-- gxmmx-release-attempt:v1 -->\n{"schema_version":1,"attempt_id":"v0.2.0@aaaaaaaaaaaa","tag":"v0.2.0","version":"0.2.0","source_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","plan":{"attempt_id":"v0.2.0@aaaaaaaaaaaa"}}',
};

test("stages assets and a SHA-256 checksum file on the matching draft", async () => {
  const result = await stage({
    assets: "dist/app.tar.gz",
    files: { "dist/app.tar.gz": "built bytes" },
    release: draft,
  });
  try {
    assert.equal(result.outputs.staged, "true");
    assert.deepEqual(
      result.state.uploads.map((asset) => asset.name),
      ["app.tar.gz", "SHA256SUMS"],
    );
    const checksum = result.state.uploads
      .find((asset) => asset.name === "SHA256SUMS")
      .bytes.toString();
    assert.match(checksum, /^[a-f0-9]{64}  app\.tar\.gz\n$/);
    assert.match(result.state.release.body, /"sha256":"[a-f0-9]{64}"/);
  } finally {
    result.cleanup();
  }
});

test("fails before changing a draft when a path or pattern has no files", async () => {
  for (const assets of ["missing.tar.gz", "dist/*.zip"]) {
    let error;
    try {
      await stage({ assets, files: {}, release: draft });
    } catch (caught) {
      error = caught;
    }
    try {
      assert.ok(error, `expected ${assets} to fail`);
      assert.match(errorText(error), /did not match any files/);
      assert.equal(error.stageState.uploads.length, 0);
      assert.equal(error.stageState.release.body, draft.body);
    } finally {
      error?.cleanup?.();
    }
  }
});

test("reuses matching staged bytes without uploading again", async () => {
  const first = await stage({
    assets: "dist/app.tar.gz",
    files: { "dist/app.tar.gz": "built bytes" },
    release: draft,
  });
  try {
    const second = await stage({
      assets: "dist/*.tar.gz",
      files: { "dist/app.tar.gz": "built bytes" },
      release: first.state.release,
      storedAssets: first.state.assets,
    });
    try {
      assert.equal(second.outputs.staged, "true");
      assert.equal(second.state.uploads.length, 0);
      assert.deepEqual(JSON.parse(second.outputs.asset_names), [
        "app.tar.gz",
        "SHA256SUMS",
      ]);
    } finally {
      second.cleanup();
    }
  } finally {
    first.cleanup();
  }
});

test("rejects changed bytes for a claimed attempt", async () => {
  const first = await stage({
    assets: "dist/app.tar.gz",
    files: { "dist/app.tar.gz": "built bytes" },
    release: draft,
  });
  try {
    let error;
    try {
      await stage({
        assets: "dist/app.tar.gz",
        files: { "dist/app.tar.gz": "different bytes" },
        release: first.state.release,
        storedAssets: first.state.assets,
      });
    } catch (caught) {
      error = caught;
    }
    try {
      assert.ok(error);
      assert.match(errorText(error), /different asset bytes/);
      assert.equal(error.stageState.uploads.length, 0);
    } finally {
      error?.cleanup?.();
    }
  } finally {
    first.cleanup();
  }
});

test("records an empty manifest without uploading a placeholder asset", async () => {
  const result = await stage({ assets: "", files: {}, release: draft });
  try {
    assert.equal(result.outputs.staged, "true");
    assert.deepEqual(result.state.uploads, []);
    assert.equal(result.outputs.checksum_asset, "");
    assert.match(result.state.release.body, /"assets":\[\]/);
  } finally {
    result.cleanup();
  }
});
