import {
  CONTEXT_MANIFEST_SCHEMA_VERSION,
  REPOSITORY_PREFLIGHT_SCHEMA_VERSION,
  type ContextSelectionLimits,
  type RepositoryContextBundle,
  type RepositoryPreflight,
  resolveRepositoryPreflight,
  selectMigrateToViteContext,
} from "./repository-context.js";
import { hashStableJson, sha256, stableJson } from "./stable-json.js";
import {
  detectViteApplicability,
  type ViteApplicability,
} from "./vite-applicability.js";

export const MIGRATE_TO_VITE_PREFLIGHT_SCHEMA_VERSION =
  "migrate-to-vite-preflight/v1";

export interface SelectedSkillInput {
  name: string;
  digest: string;
  instructions: string;
  manifestPath?: string;
}

export interface SelectedSkillSnapshot {
  name: "migrate-to-vite";
  digest: string;
  instructions: string;
  instructionsSha256: string;
  manifestPath?: string;
}

export interface MigrateToVitePreflight {
  schemaVersion: typeof MIGRATE_TO_VITE_PREFLIGHT_SCHEMA_VERSION;
  repository: RepositoryPreflight;
  skill: SelectedSkillSnapshot;
  context: RepositoryContextBundle;
  applicability: ViteApplicability;
  preflightSha256: string;
}

function assertSortedUnique(values: readonly string[], label: string): void {
  const sorted = [...new Set(values)].sort();
  if (stableJson(values) !== stableJson(sorted)) {
    throw new Error(`${label} must be sorted and unique`);
  }
}

export function assertMigrateToVitePreflightIntegrity(
  preflight: MigrateToVitePreflight,
): void {
  if (preflight.schemaVersion !== MIGRATE_TO_VITE_PREFLIGHT_SCHEMA_VERSION) {
    throw new Error("Unsupported migrate-to-vite preflight schema");
  }
  if (preflight.repository.schemaVersion !== REPOSITORY_PREFLIGHT_SCHEMA_VERSION) {
    throw new Error("Unsupported repository preflight schema");
  }
  if (preflight.context.manifest.schemaVersion !== CONTEXT_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Unsupported context manifest schema");
  }
  if (preflight.repository.repositoryRoot !== preflight.context.manifest.repositoryRoot) {
    throw new Error("Preflight repository and context roots do not match");
  }
  if (preflight.repository.repositoryIdentitySha256 !== sha256(preflight.repository.repositoryRoot)) {
    throw new Error("Preflight repository identity hash is invalid");
  }
  if (preflight.skill.name !== "migrate-to-vite") {
    throw new Error("Preflight skill is not migrate-to-vite");
  }
  if (!/^[a-f0-9]{64}$/u.test(preflight.skill.digest)) {
    throw new Error("Preflight skill digest is invalid");
  }
  if (preflight.skill.instructionsSha256 !== sha256(preflight.skill.instructions)) {
    throw new Error("Preflight skill instructions hash is invalid");
  }

  const { manifestSha256, ...manifestWithoutHash } = preflight.context.manifest;
  if (manifestSha256 !== hashStableJson(manifestWithoutHash)) {
    throw new Error("Context manifest hash is invalid");
  }
  assertSortedUnique(
    preflight.context.manifest.environmentVariableNames,
    "Context environment variable names",
  );
  for (const name of preflight.context.manifest.environmentVariableNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error("Context manifest contains an invalid environment variable name");
    }
  }

  const files = preflight.context.manifest.files;
  const documents = preflight.context.documents;
  if (files.length !== documents.length) {
    throw new Error("Context manifest and document counts do not match");
  }
  assertSortedUnique(
    files.map((file) => file.relativePath),
    "Context manifest paths",
  );
  assertSortedUnique(
    documents.map((document) => document.relativePath),
    "Context document paths",
  );
  let totalContextBytes = 0;
  for (const [index, file] of files.entries()) {
    const document = documents[index];
    if (
      !document ||
      document.relativePath !== file.relativePath ||
      document.reason !== file.reason ||
      document.contentKind !== file.contentKind ||
      document.contextSha256 !== file.contextSha256
    ) {
      throw new Error(`Context document does not match manifest entry ${file.relativePath}`);
    }
    const bytes = Buffer.byteLength(document.content, "utf8");
    if (bytes !== file.contextBytes || sha256(document.content) !== file.contextSha256) {
      throw new Error(`Context content hash is invalid for ${file.relativePath}`);
    }
    totalContextBytes += bytes;
  }
  if (totalContextBytes !== preflight.context.manifest.totalContextBytes) {
    throw new Error("Context total byte count is invalid");
  }
  if (stableJson(detectViteApplicability(preflight.context)) !== stableJson(preflight.applicability)) {
    throw new Error("Vite applicability does not match the approved context");
  }

  const { preflightSha256, ...preflightWithoutHash } = preflight;
  if (preflightSha256 !== hashStableJson(preflightWithoutHash)) {
    throw new Error("Preflight hash is invalid");
  }
}

function validateSkill(skill: SelectedSkillInput): SelectedSkillSnapshot {
  const name = skill.name.trim().toLowerCase();
  if (name !== "migrate-to-vite") {
    throw new Error("The selected skill must be migrate-to-vite");
  }
  const digest = skill.digest.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("Selected skill digest must be a SHA-256 hex digest");
  }
  if (!skill.instructions.trim()) throw new Error("Selected skill instructions are required");
  if (Buffer.byteLength(skill.instructions, "utf8") > 256 * 1024) {
    throw new Error("Selected skill instructions exceed the planning limit");
  }
  if (/\0/u.test(skill.instructions)) {
    throw new Error("Selected skill instructions contain a NUL character");
  }

  return {
    name: "migrate-to-vite",
    digest,
    instructions: skill.instructions,
    instructionsSha256: sha256(skill.instructions),
    ...(skill.manifestPath ? { manifestPath: skill.manifestPath } : {}),
  };
}

export async function prepareMigrateToVitePreflight(options: {
  repositoryPath: string;
  outputRoot: string;
  skill: SelectedSkillInput;
  limits?: Partial<ContextSelectionLimits>;
}): Promise<MigrateToVitePreflight> {
  const repository = await resolveRepositoryPreflight({
    repositoryPath: options.repositoryPath,
    outputRoot: options.outputRoot,
  });
  const skill = validateSkill(options.skill);
  const context = await selectMigrateToViteContext(repository, options.limits);
  const applicability = detectViteApplicability(context);
  const withoutHash: Omit<MigrateToVitePreflight, "preflightSha256"> = {
    schemaVersion: MIGRATE_TO_VITE_PREFLIGHT_SCHEMA_VERSION,
    repository,
    skill,
    context,
    applicability,
  };

  return {
    ...withoutHash,
    preflightSha256: hashStableJson(withoutHash),
  };
}
