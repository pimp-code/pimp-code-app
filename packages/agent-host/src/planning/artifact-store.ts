import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  renderMigrateToVitePlanMarkdown,
  validateMigrateToVitePlanV1,
  type MigrateToVitePlanV1,
} from "./migrate-to-vite-plan.js";
import {
  assertMigrateToVitePreflightIntegrity,
  type MigrateToVitePreflight,
} from "./preflight.js";
import { pathIsWithin } from "./repository-context.js";
import { sha256, stableJson } from "./stable-json.js";

export interface PlanningArtifactFile {
  path: string;
  sha256: string;
}

export interface PlanningArtifactPaths {
  runDirectory: string;
  preflight: PlanningArtifactFile;
  context: PlanningArtifactFile;
  planJson: PlanningArtifactFile;
  planMarkdown: PlanningArtifactFile;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(runId) || runId === "." || runId === "..") {
    throw new Error("Run ID must be a safe single path segment");
  }
}

async function assertContainedRunDirectory(
  outputRoot: string,
  runDirectory: string,
): Promise<string> {
  const outputMetadata = await lstat(outputRoot);
  const runMetadata = await lstat(runDirectory);
  if (
    outputMetadata.isSymbolicLink() ||
    !outputMetadata.isDirectory() ||
    runMetadata.isSymbolicLink() ||
    !runMetadata.isDirectory()
  ) {
    throw new Error("Artifact directory changed or became a symlink");
  }
  const canonicalOutputRoot = await realpath(outputRoot);
  const canonicalRunDirectory = await realpath(runDirectory);
  if (
    !samePath(canonicalOutputRoot, outputRoot) ||
    !samePath(canonicalRunDirectory, runDirectory) ||
    !pathIsWithin(canonicalOutputRoot, canonicalRunDirectory) ||
    samePath(canonicalOutputRoot, canonicalRunDirectory)
  ) {
    throw new Error("Run artifact directory escapes the output root");
  }
  return canonicalRunDirectory;
}

async function writeImmutable(
  outputRoot: string,
  runDirectory: string,
  fileName: "context.json" | "plan.json" | "plan.md" | "preflight.json" | "run.json",
  value: string,
): Promise<PlanningArtifactFile> {
  const canonicalRunDirectory = await assertContainedRunDirectory(outputRoot, runDirectory);
  const path = resolve(canonicalRunDirectory, fileName);
  const noFollow = (constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Artifact target is not a regular file");
    await handle.writeFile(value, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  const checkedRunDirectory = await assertContainedRunDirectory(outputRoot, runDirectory);
  const fileMetadata = await lstat(path);
  const canonicalPath = await realpath(path);
  if (
    fileMetadata.isSymbolicLink() ||
    !fileMetadata.isFile() ||
    !samePath(checkedRunDirectory, canonicalRunDirectory) ||
    !pathIsWithin(checkedRunDirectory, canonicalPath)
  ) {
    throw new Error("Artifact file escaped its immutable run directory");
  }
  return { path: canonicalPath, sha256: sha256(value) };
}

export async function writePlanningRunMetadata(options: {
  preflight: MigrateToVitePreflight;
  runDirectory: string;
  metadata: Record<string, unknown>;
}): Promise<PlanningArtifactFile> {
  assertMigrateToVitePreflightIntegrity(options.preflight);
  const outputRoot = await realpath(options.preflight.repository.outputRoot);
  if (!samePath(outputRoot, options.preflight.repository.outputRoot)) {
    throw new Error("Output root changed after preflight");
  }
  return writeImmutable(
    outputRoot,
    options.runDirectory,
    "run.json",
    `${stableJson(options.metadata, 2)}\n`,
  );
}

export async function writeMigrateToVitePlanArtifacts(options: {
  preflight: MigrateToVitePreflight;
  plan: MigrateToVitePlanV1;
  runId: string;
}): Promise<PlanningArtifactPaths> {
  assertRunId(options.runId);
  assertMigrateToVitePreflightIntegrity(options.preflight);
  const outputMetadata = await lstat(options.preflight.repository.outputRoot);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error("Output root changed or became a symlink after preflight");
  }
  const outputRoot = await realpath(options.preflight.repository.outputRoot);
  if (!samePath(outputRoot, options.preflight.repository.outputRoot)) {
    throw new Error("Output root changed after preflight");
  }
  const repositoryMetadata = await lstat(options.preflight.repository.repositoryRoot);
  if (repositoryMetadata.isSymbolicLink() || !repositoryMetadata.isDirectory()) {
    throw new Error("Repository root changed or became a symlink after preflight");
  }
  const repositoryRoot = await realpath(options.preflight.repository.repositoryRoot);
  if (!samePath(repositoryRoot, options.preflight.repository.repositoryRoot)) {
    throw new Error("Repository root changed after preflight");
  }
  if (
    pathIsWithin(repositoryRoot, outputRoot) ||
    pathIsWithin(outputRoot, repositoryRoot)
  ) {
    throw new Error("Repository and output roots must remain disjoint");
  }

  const runDirectory = resolve(outputRoot, options.runId);
  const runRelativePath = relative(outputRoot, runDirectory);
  if (
    runRelativePath === "" ||
    runRelativePath === ".." ||
    runRelativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("Run artifact path escapes the output root");
  }
  const plan = validateMigrateToVitePlanV1(options.plan, options.preflight);
  const markdown = renderMigrateToVitePlanMarkdown(plan, options.preflight);

  await mkdir(runDirectory, { recursive: false, mode: 0o700 });
  const canonicalRunDirectory = await assertContainedRunDirectory(outputRoot, runDirectory);

  const preflightArtifact = {
    schemaVersion: options.preflight.schemaVersion,
    repository: options.preflight.repository,
    skill: options.preflight.skill,
    applicability: options.preflight.applicability,
    contextManifest: options.preflight.context.manifest,
    preflightSha256: options.preflight.preflightSha256,
  };
  const values = {
    preflight: `${stableJson(preflightArtifact, 2)}\n`,
    context: `${stableJson(options.preflight.context, 2)}\n`,
    planJson: `${stableJson(plan, 2)}\n`,
    planMarkdown: markdown,
  };

  const preflight = await writeImmutable(
    outputRoot,
    canonicalRunDirectory,
    "preflight.json",
    values.preflight,
  );
  const context = await writeImmutable(
    outputRoot,
    canonicalRunDirectory,
    "context.json",
    values.context,
  );
  const planJson = await writeImmutable(
    outputRoot,
    canonicalRunDirectory,
    "plan.json",
    values.planJson,
  );
  const planMarkdown = await writeImmutable(
    outputRoot,
    canonicalRunDirectory,
    "plan.md",
    values.planMarkdown,
  );

  return {
    runDirectory: canonicalRunDirectory,
    preflight,
    context,
    planJson,
    planMarkdown,
  };
}
