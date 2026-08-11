import { readFile, lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { scanSkillCatalog } from "@pimp-code/skill-runtime";
import {
  assertMigrateToVitePreflightIntegrity,
  type MigrateToVitePreflight,
} from "./planning/index.js";
import { sha256 } from "./planning/stable-json.js";

const MAX_PREFLIGHT_RECORD_BYTES = 4 * 1024 * 1024;

export interface StoredPreflightRecord {
  schemaVersion: "pimp.preflight-record.v1";
  id: string;
  createdAt: string;
  skillCatalogEntryId: string;
  skillPackageRoot: string;
  preflight: MigrateToVitePreflight;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error(`${label} must be a version 4 UUID`);
  }
}

export async function loadStoredPreflight(
  preflightPath: string,
): Promise<StoredPreflightRecord> {
  if (!isAbsolute(preflightPath) || basename(preflightPath) !== "preflight.json") {
    throw new Error("Preflight path must be an absolute preflight.json path");
  }
  const canonicalPath = await realpath(preflightPath);
  const metadata = await lstat(canonicalPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Preflight record must be a regular file");
  }
  if (metadata.size > MAX_PREFLIGHT_RECORD_BYTES) {
    throw new Error("Preflight record exceeds the size limit");
  }
  const value = JSON.parse(await readFile(canonicalPath, "utf8")) as unknown;
  const record = requireObject(value, "preflight record");
  if (record.schemaVersion !== "pimp.preflight-record.v1") {
    throw new Error("Unsupported preflight record version");
  }
  assertUuid(record.id, "preflight record ID");
  // The UUID directory is part of the trusted app-owned record identity.
  if (basename(dirname(canonicalPath)).toLowerCase() !== record.id.toLowerCase()) {
    throw new Error("Preflight record directory does not match its ID");
  }
  if (
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.skillCatalogEntryId !== "string" ||
    typeof record.skillPackageRoot !== "string"
  ) {
    throw new Error("Preflight record metadata is malformed");
  }
  const preflight = requireObject(record.preflight, "preflight") as unknown as MigrateToVitePreflight;
  if (
    preflight.schemaVersion !== "migrate-to-vite-preflight/v1" ||
    preflight.repository?.outputRoot !== dirname(canonicalPath) ||
    preflight.skill?.name !== "migrate-to-vite" ||
    !Array.isArray(preflight.context?.manifest?.files) ||
    !Array.isArray(preflight.context?.documents) ||
    preflight.context.manifest.files.length === 0 ||
    preflight.applicability?.status !== "applicable"
  ) {
    throw new Error(
      "Stored preflight must be a non-empty, applicable migrate-to-vite snapshot",
    );
  }
  assertMigrateToVitePreflightIntegrity(preflight);

  return {
    schemaVersion: "pimp.preflight-record.v1",
    id: record.id,
    createdAt: record.createdAt,
    skillCatalogEntryId: record.skillCatalogEntryId,
    skillPackageRoot: record.skillPackageRoot,
    preflight,
  };
}

export async function assertStoredPreflightCurrent(
  record: StoredPreflightRecord,
): Promise<void> {
  const repositoryRoot = await realpath(record.preflight.repository.repositoryRoot);
  if (repositoryRoot !== record.preflight.repository.repositoryRoot) {
    throw new Error("Repository canonical identity changed after preflight");
  }

  for (const file of record.preflight.context.manifest.files) {
    const candidate = resolve(repositoryRoot, file.relativePath);
    if (!pathIsWithin(repositoryRoot, candidate)) {
      throw new Error(`Approved context path escapes the repository: ${file.relativePath}`);
    }
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Approved context file is no longer regular: ${file.relativePath}`);
    }
    const canonical = await realpath(candidate);
    if (!pathIsWithin(repositoryRoot, canonical)) {
      throw new Error(`Approved context file escaped the repository: ${file.relativePath}`);
    }
    const bytes = await readFile(canonical);
    if (sha256(bytes) !== file.sourceSha256) {
      throw new Error(`Approved context changed after preflight: ${file.relativePath}`);
    }
  }

  const catalog = await scanSkillCatalog([record.skillPackageRoot]);
  const matching = catalog.entries.find(
    (entry) =>
      entry.id === record.skillCatalogEntryId &&
      entry.status === "valid" &&
      entry.digest === record.preflight.skill.digest,
  );
  if (!matching) {
    throw new Error("Selected skill package changed or is no longer valid");
  }

  const outputRoot = await realpath(record.preflight.repository.outputRoot);
  if (
    pathIsWithin(repositoryRoot, outputRoot) ||
    pathIsWithin(outputRoot, repositoryRoot)
  ) {
    throw new Error("Plan artifact storage must remain outside the repository");
  }
  if (basename(outputRoot).toLowerCase() !== record.id.toLowerCase()) {
    throw new Error("Plan artifact directory does not match the preflight ID");
  }
}
