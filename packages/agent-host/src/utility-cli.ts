import { scanSkillCatalog } from "@pimp-code/skill-runtime";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareMigrateToVitePreflight } from "./planning/index.js";
import { checkProviderHealth } from "./provider-health.js";
import { validateProviderConfig } from "./validation.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const DESKTOP_SKILL_SCAN_LIMITS = {
  maxRoots: 16,
  maxDiscoveryEntries: 25_000,
  maxDiscoveryDepth: 16,
  maxPackageDepth: 16,
  maxPackageEntries: 4_096,
  maxPackageFiles: 512,
  maxPackageBytes: 16 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxFrontmatterBytes: 32 * 1024,
  maxMetadataBytes: 128 * 1024,
  maxRelativePathLength: 512,
  maxDescriptionLength: 2_048,
} as const;

interface UtilitySuccess {
  ok: true;
  data: unknown;
}

interface UtilityFailure {
  ok: false;
  error: string;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function requireString(value: unknown, label: string, maxLength = 2_000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > maxLength || /\p{Cc}/u.test(result)) {
    throw new Error(`${label} is invalid or too long`);
  }
  return result;
}

async function catalogForUi(roots: string[]): Promise<unknown> {
  const catalog = await scanSkillCatalog({
    roots,
    limits: DESKTOP_SKILL_SCAN_LIMITS,
  });
  const rootPaths = new Map(
    catalog.roots.map((root) => [root.id, root.configuredPath]),
  );
  return {
    ...catalog,
    entries: catalog.entries.map((entry) => ({
      ...entry,
      rootPath: rootPaths.get(entry.rootId) ?? "",
      files: entry.files.map((file) => ({
        ...file,
        path: file.relativePath,
        digest: file.sha256,
      })),
    })),
    orphanedMetadata: catalog.orphanMetadata.map((orphan) => ({
      ...orphan,
      rootPath: rootPaths.get(orphan.rootId) ?? "",
      message: orphan.issue.message,
    })),
  };
}

async function prepareVitePreflight(
  request: Record<string, unknown>,
): Promise<unknown> {
  const repository = requireString(request.repository, "repository");
  const skillId = requireString(request.skillId, "skillId", 200);
  const skillRoot = requireString(request.skillRoot, "skillRoot");
  const configuredRoots = requireStrings(
    request.configuredRoots,
    "configuredRoots",
  );
  if (!configuredRoots.some((root) => root.trim().toLowerCase() === skillRoot.toLowerCase())) {
    throw new Error("The selected skill root is not configured");
  }

  const catalog = await scanSkillCatalog({
    roots: [skillRoot],
    limits: DESKTOP_SKILL_SCAN_LIMITS,
  });
  const entry = catalog.entries.find((candidate) => candidate.id === skillId);
  if (
    !entry ||
    entry.status !== "valid" ||
    entry.name !== "migrate-to-vite" ||
    !entry.digest ||
    !entry.instructions
  ) {
    throw new Error("The selected migrate-to-vite skill is not uniquely valid");
  }

  const requestedRoot = resolve(
    requireString(request.preflightRoot, "preflightRoot"),
  );
  const preflightRoot = await realpath(requestedRoot);
  const id = randomUUID();
  const outputRoot = join(preflightRoot, id);
  await mkdir(outputRoot, { recursive: false });
  const preflight = await prepareMigrateToVitePreflight({
    repositoryPath: repository,
    outputRoot,
    skill: {
      name: entry.name,
      digest: entry.digest,
      instructions: entry.instructions,
      ...(entry.manifestPath ? { manifestPath: entry.manifestPath } : {}),
    },
    limits: {
      maxDepth: 6,
      maxFiles: 60,
      maxFileBytes: 128 * 1024,
      maxTotalBytes: 512 * 1024,
    },
  });
  const createdAt = new Date().toISOString();
  await writeFile(
    join(outputRoot, "preflight.json"),
    `${JSON.stringify(
      {
        schemaVersion: "pimp.preflight-record.v1",
        id,
        createdAt,
        skillCatalogEntryId: entry.id,
        skillPackageRoot: entry.packageRoot,
        preflight,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const verdict =
    preflight.applicability.status === "applicable"
      ? "applicable"
      : preflight.applicability.status === "uncertain"
        ? "unknown"
        : "not-applicable";
  return {
    id,
    createdAt,
    canonicalRepository: preflight.repository.repositoryRoot,
    skill: {
      id: entry.id,
      name: entry.name,
      digest: entry.digest,
      packageRoot: entry.packageRoot,
    },
    applicability: {
      verdict,
      summary: preflight.applicability.rationale,
      evidence: preflight.applicability.evidence.map((evidence) => ({
        path: evidence.relativePath,
        message: evidence.fact,
        kind: evidence.kind,
      })),
    },
    contextManifest: {
      hash: preflight.context.manifest.manifestSha256,
      totalBytes: preflight.context.manifest.totalContextBytes,
      files: preflight.context.manifest.files.map((file) => ({
        path: file.relativePath,
        size: file.contextBytes,
        digest: file.contextSha256,
        reason: file.reason,
        redactions: [],
      })),
    },
    remoteEgress: {
      required: true,
      destination: "Anthropic / Claude",
      contextHash: preflight.context.manifest.manifestSha256,
    },
    warnings: preflight.context.manifest.excluded.slice(0, 100).map((item) => ({
      path: item.relativePath,
      message: `Excluded: ${item.reason}`,
    })),
  };
}

async function readRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error("Utility request exceeds the size limit");
    }
    chunks.push(buffer);
  }
  if (total === 0) throw new Error("Utility request is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function dispatch(value: unknown): Promise<unknown> {
  const request = requireObject(value, "utility request");
  switch (request.operation) {
    case "scan_skill_catalog":
      return catalogForUi(requireStrings(request.roots, "roots"));
    case "provider_health":
      return checkProviderHealth(
        validateProviderConfig(request.provider, { allowEmptyModel: true }),
      );
    case "prepare_migrate_to_vite":
      return prepareVitePreflight(request);
    default:
      throw new Error("Unknown utility operation");
  }
}

async function main(): Promise<void> {
  let response: UtilitySuccess | UtilityFailure;
  try {
    response = { ok: true, data: await dispatch(await readRequest()) };
  } catch (error) {
    response = {
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
    };
  }
  process.stdout.write(JSON.stringify(response));
}

void main();
