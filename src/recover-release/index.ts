import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  attemptMarker,
  readAttemptRecord,
  serializeAttemptBody,
  type AttemptRecord,
} from "../prepare-release/attempt.js";
import {
  createGitHubOperations,
  deleteReleaseAsset,
  listReleaseAssets,
  listRepositoryReleases,
  uploadReleaseAsset,
  updateRelease,
} from "../github/operations.js";

type Operation = "resume" | "abandon";

interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
}

function parseOperation(value: string): Operation {
  if (value === "resume" || value === "abandon") return value;
  throw new Error("operation must be resume or abandon");
}

function releaseNotes(body: string | null | undefined): string {
  return (body ?? "").split(attemptMarker)[0].trim();
}

function setOutputs(args: {
  release: {
    id: number;
    tag_name: string;
    draft: boolean;
    name?: string | null;
    prerelease: boolean;
    assets?: ReleaseAsset[];
    body?: string | null;
  };
  record: AttemptRecord;
}): void {
  const { release, record } = args;
  core.setOutput("attempt_id", record.attempt_id);
  core.setOutput("release_id", String(release.id));
  core.setOutput("tag", record.tag);
  core.setOutput("version", record.version);
  core.setOutput("source_sha", record.source_sha);
  core.setOutput("release_plan", JSON.stringify(record.plan));
  core.setOutput("release_notes", releaseNotes(release.body));
  core.setOutput(
    "asset_manifest",
    record.asset_manifest ? JSON.stringify(record.asset_manifest) : "",
  );
  core.setOutput(
    "registry_receipt",
    record.registry_receipt ? JSON.stringify(record.registry_receipt) : "",
  );
  core.setOutput("abandoned_reason", record.abandoned?.reason ?? "");
  core.setOutput(
    "attempt_state",
    record.abandoned ? "abandoned" : release.draft ? "draft" : "published",
  );
  core.setOutput(
    "release_assets",
    JSON.stringify(
      (release.assets ?? []).map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.size,
        digest: asset.digest ?? "",
        download_url: asset.browser_download_url,
      })),
    ),
  );
}

async function main(): Promise<void> {
  const operation = parseOperation(
    core.getInput("operation", { required: true }),
  );
  const attemptId = core.getInput("attempt_id", { required: true }).trim();
  if (!attemptId) throw new Error("attempt_id is required");
  const reason = core.getInput("reason").trim();
  if (operation === "abandon" && !reason) {
    throw new Error("reason is required when operation is abandon");
  }

  const { octokit, owner, repo } = createGitHubOperations(
    core.getInput("github_token", { required: true }),
  );
  const releases = await listRepositoryReleases({ octokit, owner, repo });
  const matching = (
    await Promise.all(
      releases.map(async (release) => {
        const record = await readAttemptRecord({
          octokit,
          owner,
          repo,
          release,
        });
        return record?.attempt_id === attemptId ? { release, record } : null;
      }),
    )
  ).filter((value): value is NonNullable<typeof value> => value !== null);
  if (matching.length === 0) {
    throw new Error(`No release attempt found with ID ${attemptId}`);
  }
  if (matching.length > 1) {
    throw new Error(`Attempt ID ${attemptId} appears on multiple releases`);
  }
  let { release, record } = matching[0];

  if (operation === "abandon") {
    if (!release.draft)
      throw new Error("A published attempt cannot be abandoned");
    if (record.abandoned) {
      if (record.abandoned.reason !== reason) {
        throw new Error(
          "Attempt was already abandoned with a different reason",
        );
      }
    } else {
      record = {
        ...record,
        abandoned: { reason, at: new Date().toISOString() },
      };
      const assets = await listReleaseAssets({
        octokit,
        owner,
        repo,
        releaseId: release.id,
      });
      const attemptAsset = assets.find(
        (asset) => asset.name === "gxmmx-release-attempt.json",
      );
      if (attemptAsset) {
        await deleteReleaseAsset({
          octokit,
          owner,
          repo,
          assetId: attemptAsset.id,
        });
      }
      const updated = await updateRelease({
        octokit,
        owner,
        repo,
        release_id: release.id,
        tag_name: release.tag_name,
        name: release.name ?? release.tag_name,
        draft: true,
        prerelease: release.prerelease,
        body: serializeAttemptBody(release.body, record),
      });
      release = updated.data;
      if (attemptAsset) {
        const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
        await uploadReleaseAsset({
          octokit,
          owner,
          repo,
          release_id: release.id,
          name: "gxmmx-release-attempt.json",
          data: bytes as unknown as string,
          ...(github.context.apiUrl !== "https://api.github.com"
            ? { baseUrl: github.context.apiUrl }
            : {}),
          headers: {
            "content-type": "application/json",
            "content-length": bytes.length,
          },
        });
      }
    }
  } else if (record.abandoned) {
    throw new Error(
      `Release attempt was abandoned: ${record.abandoned.reason}`,
    );
  }

  setOutputs({ release, record });
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
