import type { Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  DEFAULT_SKILL_SCAN_LIMITS,
  DISCOVERY_IGNORED_DIRECTORIES,
  PACKAGE_IGNORED_DIRECTORIES,
} from "./constants.js";
import {
  computeSkillPackageDigest,
  sha256Bytes,
  type DigestFile,
} from "./digest.js";
import {
  parseOpenAiMetadata,
  parseSkillManifest,
} from "./frontmatter.js";
import {
  isPathWithin,
  isWindowsDevicePath,
  resolveConfiguredPath,
  stableId,
  validatePackageRelativePath,
} from "./path-policy.js";
import type {
  OrphanSkillMetadata,
  ScanSkillCatalogOptions,
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogIssue,
  SkillPackageFile,
  SkillPackageFileKind,
  SkillRootResult,
  SkillScanLimits,
} from "./types.js";

interface ValidRoot {
  result: SkillRootResult;
  canonicalPath: string;
}

interface PackageCandidate {
  packageRoot: string;
  rootIds: Set<string>;
  rootPaths: Set<string>;
}

interface MetadataSighting {
  rootId: string;
  canonicalPath: string;
}

interface DiscoveryResult {
  packages: PackageCandidate[];
  metadata: MetadataSighting[];
}

interface LoadedFile {
  record: SkillPackageFile;
  bytes: Buffer;
}

interface PackageLoadResult {
  files: LoadedFile[];
  totalBytes: number;
  issues: SkillCatalogIssue[];
}

function issue(input: {
  code: string;
  severity: "warning" | "error";
  message: string;
  path?: string | null;
  rootId?: string | null;
  entryId?: string | null;
}): SkillCatalogIssue {
  return {
    code: input.code,
    severity: input.severity,
    message: input.message.slice(0, 2_000),
    path: input.path ?? null,
    rootId: input.rootId ?? null,
    entryId: input.entryId ?? null,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function mergeLimits(overrides: Partial<SkillScanLimits> | undefined): SkillScanLimits {
  const limits: SkillScanLimits = {
    ...DEFAULT_SKILL_SCAN_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function isSameFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function classifyFile(relativePath: string): SkillPackageFileKind {
  const normalized = relativePath.toLowerCase();
  if (!normalized.includes("/") && normalized === "skill.md") return "manifest";
  if (normalized === "agents/openai.yaml") return "metadata";
  const first = normalized.split("/", 1)[0];
  if (first === "scripts") return "script";
  if (first === "references") return "reference";
  if (first === "assets") return "asset";
  return "other";
}

async function prepareRoot(
  configuredPath: string,
  ordinal: number,
): Promise<ValidRoot | { result: SkillRootResult; canonicalPath: null }> {
  const resolvedPath = resolveConfiguredPath(configuredPath || ".");
  const provisionalId = stableId(
    "pimp-skill-root-v1",
    `${ordinal}\0${resolvedPath}`,
  );
  const result: SkillRootResult = {
    id: provisionalId,
    configuredPath,
    resolvedPath,
    canonicalPath: null,
    status: "invalid",
    manifestCount: 0,
    issues: [],
  };

  if (configuredPath.trim().length === 0) {
    result.issues.push(
      issue({
        code: "ROOT_PATH_EMPTY",
        severity: "error",
        message: "Skill root path must not be empty",
        path: configuredPath,
        rootId: result.id,
      }),
    );
    return { result, canonicalPath: null };
  }
  if (isWindowsDevicePath(configuredPath)) {
    result.issues.push(
      issue({
        code: "ROOT_DEVICE_PATH_NOT_ALLOWED",
        severity: "error",
        message: "Windows device namespace paths are not allowed as skill roots",
        path: configuredPath,
        rootId: result.id,
      }),
    );
    return { result, canonicalPath: null };
  }

  try {
    const metadata = await lstat(resolvedPath);
    if (metadata.isSymbolicLink()) {
      result.issues.push(
        issue({
          code: "ROOT_LINK_NOT_ALLOWED",
          severity: "error",
          message: "A skill root may not be a symbolic link or junction",
          path: resolvedPath,
          rootId: result.id,
        }),
      );
      return { result, canonicalPath: null };
    }
    if (!metadata.isDirectory()) {
      result.issues.push(
        issue({
          code: "ROOT_NOT_DIRECTORY",
          severity: "error",
          message: "Skill root must resolve to a directory",
          path: resolvedPath,
          rootId: result.id,
        }),
      );
      return { result, canonicalPath: null };
    }

    const canonicalPath = await realpath(resolvedPath);
    result.id = stableId("pimp-skill-root-v1", canonicalPath);
    result.canonicalPath = canonicalPath;
    result.status = "ready";
    return { result, canonicalPath };
  } catch (error) {
    result.status = "unavailable";
    result.issues.push(
      issue({
        code: "ROOT_UNAVAILABLE",
        severity: "error",
        message: `Could not inspect skill root: ${errorMessage(error)}`,
        path: resolvedPath,
        rootId: result.id,
      }),
    );
    return { result, canonicalPath: null };
  }
}

function isOpenAiMetadataPath(parentPath: string, fileName: string): boolean {
  return (
    basename(parentPath).toLowerCase() === "agents" &&
    fileName.toLowerCase() === "openai.yaml"
  );
}

async function discoverRoot(
  root: ValidRoot,
  limits: SkillScanLimits,
): Promise<DiscoveryResult> {
  const candidates = new Map<string, PackageCandidate>();
  const metadata: MetadataSighting[] = [];
  const visitedDirectories = new Set<string>();
  let entriesVisited = 0;
  let limited = false;

  const addCandidate = (packageRoot: string): void => {
    const key = process.platform === "win32" ? packageRoot.toLowerCase() : packageRoot;
    const existing = candidates.get(key);
    if (existing) {
      existing.rootIds.add(root.result.id);
      existing.rootPaths.add(root.canonicalPath);
      return;
    }
    candidates.set(key, {
      packageRoot,
      rootIds: new Set([root.result.id]),
      rootPaths: new Set([root.canonicalPath]),
    });
  };

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (limited) return;
    if (depth > limits.maxDiscoveryDepth) {
      limited = true;
      root.result.status = "limited";
      root.result.issues.push(
        issue({
          code: "DISCOVERY_DEPTH_LIMIT",
          severity: "error",
          message: `Discovery exceeded depth ${limits.maxDiscoveryDepth}`,
          path: directory,
          rootId: root.result.id,
        }),
      );
      return;
    }

    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
    } catch (error) {
      root.result.issues.push(
        issue({
          code: "DISCOVERY_PATH_UNAVAILABLE",
          severity: "warning",
          message: `Could not resolve directory: ${errorMessage(error)}`,
          path: directory,
          rootId: root.result.id,
        }),
      );
      return;
    }
    if (!isPathWithin(root.canonicalPath, canonicalDirectory)) {
      root.result.issues.push(
        issue({
          code: "DISCOVERY_PATH_ESCAPE",
          severity: "error",
          message: "Directory resolves outside the configured skill root",
          path: directory,
          rootId: root.result.id,
        }),
      );
      return;
    }
    const visitKey =
      process.platform === "win32"
        ? canonicalDirectory.toLowerCase()
        : canonicalDirectory;
    if (visitedDirectories.has(visitKey)) return;
    visitedDirectories.add(visitKey);

    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      root.result.issues.push(
        issue({
          code: "DISCOVERY_DIRECTORY_UNREADABLE",
          severity: "warning",
          message: `Could not read directory: ${errorMessage(error)}`,
          path: directory,
          rootId: root.result.id,
        }),
      );
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      entriesVisited += 1;
      if (entriesVisited > limits.maxDiscoveryEntries) {
        limited = true;
        root.result.status = "limited";
        root.result.issues.push(
          issue({
            code: "DISCOVERY_ENTRY_LIMIT",
            severity: "error",
            message: `Discovery exceeded ${limits.maxDiscoveryEntries} entries`,
            path: directory,
            rootId: root.result.id,
          }),
        );
        return;
      }

      const childPath = join(directory, child.name);
      let childMetadata: Stats;
      try {
        childMetadata = await lstat(childPath);
      } catch (error) {
        root.result.issues.push(
          issue({
            code: "DISCOVERY_ENTRY_UNAVAILABLE",
            severity: "warning",
            message: `Could not inspect entry: ${errorMessage(error)}`,
            path: childPath,
            rootId: root.result.id,
          }),
        );
        continue;
      }

      if (childMetadata.isSymbolicLink()) {
        root.result.issues.push(
          issue({
            code: "LINK_NOT_ALLOWED",
            severity: "error",
            message: "Symbolic links and junctions are not traversed",
            path: childPath,
            rootId: root.result.id,
          }),
        );
        if (child.name.toLowerCase() === "skill.md") addCandidate(canonicalDirectory);
        continue;
      }

      if (childMetadata.isDirectory()) {
        const normalizedName = child.name.toLowerCase();
        if (
          child.name.startsWith(".") ||
          DISCOVERY_IGNORED_DIRECTORIES.has(normalizedName)
        ) {
          continue;
        }
        await walk(childPath, depth + 1);
        if (limited) return;
        continue;
      }

      if (!childMetadata.isFile()) {
        root.result.issues.push(
          issue({
            code: "SPECIAL_FILE_NOT_ALLOWED",
            severity: "warning",
            message: "Special filesystem entries are ignored",
            path: childPath,
            rootId: root.result.id,
          }),
        );
        continue;
      }

      let canonicalChild: string;
      try {
        canonicalChild = await realpath(childPath);
      } catch (error) {
        root.result.issues.push(
          issue({
            code: "DISCOVERY_ENTRY_UNAVAILABLE",
            severity: "warning",
            message: `Could not resolve entry: ${errorMessage(error)}`,
            path: childPath,
            rootId: root.result.id,
          }),
        );
        continue;
      }
      if (!isPathWithin(root.canonicalPath, canonicalChild)) {
        root.result.issues.push(
          issue({
            code: "DISCOVERY_PATH_ESCAPE",
            severity: "error",
            message: "File resolves outside the configured skill root",
            path: childPath,
            rootId: root.result.id,
          }),
        );
        continue;
      }

      if (child.name.toLowerCase() === "skill.md") {
        addCandidate(canonicalDirectory);
        root.result.manifestCount += 1;
      }
      if (isOpenAiMetadataPath(canonicalDirectory, child.name)) {
        metadata.push({ rootId: root.result.id, canonicalPath: canonicalChild });
      }
    }
  };

  await walk(root.canonicalPath, 0);
  return { packages: [...candidates.values()], metadata };
}

function packageEntryId(packageRoot: string): string {
  return stableId("pimp-skill-entry-v1", packageRoot);
}

async function readStableFile(
  filePath: string,
  maximumBytes: number,
): Promise<{
  bytes: Buffer | null;
  identity: Stats | null;
  unstable: boolean;
  error: string | null;
}> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const before = await handle.stat();
    if (!before.isFile()) {
      return {
        bytes: null,
        identity: null,
        unstable: false,
        error: "Entry is not a regular file",
      };
    }
    if (before.size > maximumBytes) {
      return {
        bytes: null,
        identity: null,
        unstable: false,
        error: `File exceeds ${maximumBytes} bytes`,
      };
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < before.size) {
      const read = await handle.read(
        bytes,
        offset,
        before.size - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const overflow = await handle.read(
      overflowProbe,
      0,
      1,
      before.size,
    );
    const after = await handle.stat();
    if (
      !isSameFile(before, after) ||
      offset !== before.size ||
      overflow.bytesRead !== 0
    ) {
      return {
        bytes: null,
        identity: null,
        unstable: true,
        error: "File changed while it was read",
      };
    }
    return { bytes, identity: after, unstable: false, error: null };
  } catch (error) {
    return {
      bytes: null,
      identity: null,
      unstable: false,
      error: errorMessage(error),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function loadPackageFiles(
  candidate: PackageCandidate,
  limits: SkillScanLimits,
): Promise<PackageLoadResult> {
  const entryId = packageEntryId(candidate.packageRoot);
  const rootId = [...candidate.rootIds].sort()[0] ?? null;
  const issues: SkillCatalogIssue[] = [];
  const files: LoadedFile[] = [];
  const collisionPaths = new Map<string, string>();
  const visitedDirectories = new Set<string>();
  let totalBytes = 0;
  let entriesVisited = 0;
  let limited = false;

  const addIssue = (
    code: string,
    severity: "warning" | "error",
    message: string,
    path: string,
  ): void => {
    issues.push(issue({ code, severity, message, path, rootId, entryId }));
  };

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (limited) return;
    if (depth > limits.maxPackageDepth) {
      limited = true;
      addIssue(
        "PACKAGE_DEPTH_LIMIT",
        "error",
        `Package exceeds depth ${limits.maxPackageDepth}`,
        directory,
      );
      return;
    }

    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
    } catch (error) {
      addIssue(
        "PACKAGE_PATH_UNAVAILABLE",
        "error",
        `Could not resolve directory: ${errorMessage(error)}`,
        directory,
      );
      return;
    }
    if (!isPathWithin(candidate.packageRoot, canonicalDirectory)) {
      addIssue(
        "PACKAGE_PATH_ESCAPE",
        "error",
        "Directory resolves outside the skill package",
        directory,
      );
      return;
    }
    const visitKey =
      process.platform === "win32"
        ? canonicalDirectory.toLowerCase()
        : canonicalDirectory;
    if (visitedDirectories.has(visitKey)) return;
    visitedDirectories.add(visitKey);

    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      addIssue(
        "PACKAGE_DIRECTORY_UNREADABLE",
        "error",
        `Could not read directory: ${errorMessage(error)}`,
        directory,
      );
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      entriesVisited += 1;
      if (entriesVisited > limits.maxPackageEntries) {
        limited = true;
        addIssue(
          "PACKAGE_ENTRY_LIMIT",
          "error",
          `Package exceeds ${limits.maxPackageEntries} filesystem entries`,
          directory,
        );
        return;
      }
      const childPath = join(directory, child.name);
      let childMetadata: Stats;
      try {
        childMetadata = await lstat(childPath);
      } catch (error) {
        addIssue(
          "PACKAGE_ENTRY_UNAVAILABLE",
          "error",
          `Could not inspect entry: ${errorMessage(error)}`,
          childPath,
        );
        continue;
      }

      if (childMetadata.isSymbolicLink()) {
        addIssue(
          "LINK_NOT_ALLOWED",
          "error",
          "Symbolic links and junctions are not allowed in skill packages",
          childPath,
        );
        continue;
      }
      if (childMetadata.isDirectory()) {
        if (PACKAGE_IGNORED_DIRECTORIES.has(child.name.toLowerCase())) {
          addIssue(
            "VCS_DIRECTORY_IGNORED",
            "warning",
            "Version-control metadata is excluded from the package digest",
            childPath,
          );
          continue;
        }
        await walk(childPath, depth + 1);
        if (limited) return;
        continue;
      }
      if (!childMetadata.isFile()) {
        addIssue(
          "SPECIAL_FILE_NOT_ALLOWED",
          "error",
          "Only regular files are allowed in skill packages",
          childPath,
        );
        continue;
      }

      let canonicalChild: string;
      try {
        canonicalChild = await realpath(childPath);
      } catch (error) {
        addIssue(
          "PACKAGE_ENTRY_UNAVAILABLE",
          "error",
          `Could not resolve entry: ${errorMessage(error)}`,
          childPath,
        );
        continue;
      }
      if (!isPathWithin(candidate.packageRoot, canonicalChild)) {
        addIssue(
          "PACKAGE_PATH_ESCAPE",
          "error",
          "File resolves outside the skill package",
          childPath,
        );
        continue;
      }

      const rawRelative = relative(candidate.packageRoot, canonicalChild);
      const validatedPath = validatePackageRelativePath(
        rawRelative,
        limits.maxRelativePathLength,
      );
      if (
        validatedPath.error ||
        validatedPath.normalizedPath === null ||
        validatedPath.collisionKey === null
      ) {
        addIssue(
          "INVALID_PACKAGE_PATH",
          "error",
          validatedPath.error ?? "Invalid package-relative path",
          childPath,
        );
        continue;
      }

      const collision = collisionPaths.get(validatedPath.collisionKey);
      if (collision !== undefined && collision !== validatedPath.normalizedPath) {
        addIssue(
          "PACKAGE_PATH_COLLISION",
          "error",
          `Path collides with ${collision} after case and Unicode normalization`,
          childPath,
        );
        continue;
      }
      collisionPaths.set(
        validatedPath.collisionKey,
        validatedPath.normalizedPath,
      );

      if (files.length + 1 > limits.maxPackageFiles) {
        limited = true;
        addIssue(
          "PACKAGE_FILE_LIMIT",
          "error",
          `Package exceeds ${limits.maxPackageFiles} files`,
          childPath,
        );
        return;
      }

      const kind = classifyFile(validatedPath.normalizedPath);
      const maximumBytes =
        kind === "manifest" ? limits.maxManifestBytes : limits.maxFileBytes;
      const read = await readStableFile(childPath, maximumBytes);
      if (read.bytes === null) {
        addIssue(
          read.unstable ? "UNSTABLE_FILE" : "PACKAGE_FILE_UNREADABLE",
          "error",
          read.error ?? "Could not read file",
          childPath,
        );
        continue;
      }

      let canonicalAfter: string;
      let lstatAfter: Stats;
      try {
        [canonicalAfter, lstatAfter] = await Promise.all([
          realpath(childPath),
          lstat(childPath),
        ]);
      } catch (error) {
        addIssue(
          "UNSTABLE_FILE",
          "error",
          `File changed after it was read: ${errorMessage(error)}`,
          childPath,
        );
        continue;
      }
      if (
        read.identity === null ||
        canonicalAfter !== canonicalChild ||
        lstatAfter.isSymbolicLink() ||
        !lstatAfter.isFile() ||
        lstatAfter.size !== read.bytes.byteLength ||
        !isSameFile(read.identity, lstatAfter)
      ) {
        addIssue(
          "UNSTABLE_FILE",
          "error",
          "File identity changed after it was read",
          childPath,
        );
        continue;
      }

      if (totalBytes + read.bytes.byteLength > limits.maxPackageBytes) {
        limited = true;
        addIssue(
          "PACKAGE_BYTE_LIMIT",
          "error",
          `Package exceeds ${limits.maxPackageBytes} bytes`,
          childPath,
        );
        return;
      }
      totalBytes += read.bytes.byteLength;
      files.push({
        record: {
          relativePath: validatedPath.normalizedPath,
          canonicalPath: canonicalChild,
          size: read.bytes.byteLength,
          sha256: sha256Bytes(read.bytes),
          kind,
          active: kind !== "script",
        },
        bytes: read.bytes,
      });
    }
  };

  await walk(candidate.packageRoot, 0);
  files.sort((left, right) =>
    left.record.relativePath.localeCompare(right.record.relativePath),
  );
  return { files, totalBytes, issues };
}

function withEntryId(
  item: SkillCatalogIssue,
  entryId: string,
): SkillCatalogIssue {
  return item.entryId === entryId ? item : { ...item, entryId };
}

async function loadCatalogEntry(
  candidate: PackageCandidate,
  limits: SkillScanLimits,
): Promise<SkillCatalogEntry> {
  const entryId = packageEntryId(candidate.packageRoot);
  const rootIds = [...candidate.rootIds].sort();
  const rootId = rootIds[0] ?? stableId("pimp-skill-root-missing", candidate.packageRoot);
  const loaded = await loadPackageFiles(candidate, limits);
  const issues = loaded.issues.map((item) => withEntryId(item, entryId));
  const rootManifests = loaded.files.filter(
    (file) => file.record.kind === "manifest",
  );
  const nestedManifests = loaded.files.filter(
    (file) =>
      file.record.relativePath.includes("/") &&
      basename(file.record.relativePath).toLowerCase() === "skill.md",
  );

  if (rootManifests.length !== 1) {
    issues.push(
      issue({
        code: "MANIFEST_COUNT_INVALID",
        severity: "error",
        message: `Package must contain exactly one root SKILL.md; found ${rootManifests.length}`,
        path: candidate.packageRoot,
        rootId,
        entryId,
      }),
    );
  }
  if (nestedManifests.length > 0) {
    issues.push(
      issue({
        code: "NESTED_SKILL_MANIFEST",
        severity: "error",
        message: "A skill package may not contain another SKILL.md package",
        path: nestedManifests[0]?.record.canonicalPath ?? candidate.packageRoot,
        rootId,
        entryId,
      }),
    );
  }

  const manifest = rootManifests[0];
  const parsedManifest = manifest
    ? parseSkillManifest(manifest.bytes, {
        maxFrontmatterBytes: limits.maxFrontmatterBytes,
        maxDescriptionLength: limits.maxDescriptionLength,
        directoryName: basename(candidate.packageRoot),
      })
    : null;
  for (const message of parsedManifest?.errors ?? []) {
    issues.push(
      issue({
        code: "MANIFEST_MALFORMED",
        severity: "error",
        message,
        path: manifest?.record.canonicalPath ?? candidate.packageRoot,
        rootId,
        entryId,
      }),
    );
  }
  for (const message of parsedManifest?.warnings ?? []) {
    issues.push(
      issue({
        code: "MANIFEST_WARNING",
        severity: "warning",
        message,
        path: manifest?.record.canonicalPath ?? candidate.packageRoot,
        rootId,
        entryId,
      }),
    );
  }

  const metadataFiles = loaded.files.filter(
    (file) => file.record.kind === "metadata",
  );
  let metadataStatus: SkillCatalogEntry["metadataStatus"] = "absent";
  let presentation: SkillCatalogEntry["presentation"] = null;
  let rawMetadata: SkillCatalogEntry["rawMetadata"] = null;
  if (metadataFiles.length > 1) {
    metadataStatus = "malformed";
    issues.push(
      issue({
        code: "METADATA_COUNT_INVALID",
        severity: "warning",
        message: "Package contains multiple case-equivalent agents/openai.yaml files",
        path: metadataFiles[0]?.record.canonicalPath ?? candidate.packageRoot,
        rootId,
        entryId,
      }),
    );
  } else if (metadataFiles.length === 1) {
    const metadataFile = metadataFiles[0];
    if (metadataFile === undefined) {
      throw new Error("metadata file disappeared from the in-memory package snapshot");
    }
    if (metadataFile.bytes.byteLength > limits.maxMetadataBytes) {
      metadataStatus = "malformed";
      issues.push(
        issue({
          code: "METADATA_TOO_LARGE",
          severity: "warning",
          message: `agents/openai.yaml exceeds ${limits.maxMetadataBytes} bytes`,
          path: metadataFile.record.canonicalPath,
          rootId,
          entryId,
        }),
      );
    } else {
      const parsedMetadata = parseOpenAiMetadata(metadataFile.bytes);
      if (parsedMetadata.errors.length > 0) {
        metadataStatus = "malformed";
        for (const message of parsedMetadata.errors) {
          issues.push(
            issue({
              code: "METADATA_MALFORMED",
              severity: "warning",
              message,
              path: metadataFile.record.canonicalPath,
              rootId,
              entryId,
            }),
          );
        }
      } else {
        metadataStatus = "valid";
        presentation = parsedMetadata.presentation;
        rawMetadata = parsedMetadata.rawMetadata;
      }
    }
  }

  const digestFiles: DigestFile[] = loaded.files.map((file) => ({
    relativePath: file.record.relativePath,
    bytes: file.bytes,
  }));
  const unsafePackage = issues.some(
    (item) =>
      item.severity === "error" &&
      [
        "LINK_NOT_ALLOWED",
        "PACKAGE_PATH_ESCAPE",
        "PACKAGE_PATH_COLLISION",
        "PACKAGE_ENTRY_LIMIT",
        "PACKAGE_FILE_LIMIT",
        "PACKAGE_BYTE_LIMIT",
        "PACKAGE_DEPTH_LIMIT",
        "PACKAGE_FILE_UNREADABLE",
        "PACKAGE_ENTRY_UNAVAILABLE",
        "PACKAGE_DIRECTORY_UNREADABLE",
        "SPECIAL_FILE_NOT_ALLOWED",
        "UNSTABLE_FILE",
      ].includes(item.code),
  );
  const digest = unsafePackage
    ? null
    : computeSkillPackageDigest(digestFiles);
  const hasUnstableFile = issues.some((item) => item.code === "UNSTABLE_FILE");
  const hasError = issues.some((item) => item.severity === "error");

  return {
    id: entryId,
    rootId,
    rootIds,
    packageRoot: candidate.packageRoot,
    manifestPath: manifest?.record.canonicalPath ?? null,
    metadataPath: metadataFiles[0]?.record.canonicalPath ?? null,
    status: hasUnstableFile ? "unstable" : hasError ? "malformed" : "valid",
    name: parsedManifest?.frontmatter?.name ?? null,
    description: parsedManifest?.frontmatter?.description ?? null,
    instructions: parsedManifest?.instructions ?? null,
    frontmatter: parsedManifest?.frontmatter ?? null,
    digest,
    digestAlgorithm: "sha256",
    fileCount: loaded.files.length,
    totalBytes: loaded.totalBytes,
    files: loaded.files.map((file) => file.record),
    metadataStatus,
    presentation,
    rawMetadata,
    issues,
  };
}

function mergePackageCandidate(
  map: Map<string, PackageCandidate>,
  candidate: PackageCandidate,
): void {
  const key =
    process.platform === "win32"
      ? candidate.packageRoot.toLowerCase()
      : candidate.packageRoot;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, candidate);
    return;
  }
  for (const rootId of candidate.rootIds) existing.rootIds.add(rootId);
  for (const rootPath of candidate.rootPaths) existing.rootPaths.add(rootPath);
}

function resolveDuplicateNames(entries: SkillCatalogEntry[]): SkillCatalogIssue[] {
  const byName = new Map<string, SkillCatalogEntry[]>();
  for (const entry of entries) {
    if (entry.name === null) continue;
    const group = byName.get(entry.name) ?? [];
    group.push(entry);
    byName.set(entry.name, group);
  }

  const duplicateIssues: SkillCatalogIssue[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const locations = group.map((entry) => entry.packageRoot).join(", ");
    for (const entry of group) {
      const duplicateIssue = issue({
        code: "DUPLICATE_SKILL_NAME",
        severity: "error",
        message: `Skill name ${name} is duplicated across: ${locations}`,
        path: entry.manifestPath ?? entry.packageRoot,
        rootId: entry.rootId,
        entryId: entry.id,
      });
      entry.issues.push(duplicateIssue);
      if (entry.status === "valid") entry.status = "duplicate";
      duplicateIssues.push(duplicateIssue);
    }
  }
  return duplicateIssues;
}

function metadataOwnerPath(metadataPath: string): string {
  return dirname(dirname(metadataPath));
}

function candidateKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function scanSkillCatalog(
  roots: readonly string[],
): Promise<SkillCatalog>;
export function scanSkillCatalog(
  options: ScanSkillCatalogOptions,
): Promise<SkillCatalog>;
export async function scanSkillCatalog(
  input: readonly string[] | ScanSkillCatalogOptions,
): Promise<SkillCatalog> {
  const options: ScanSkillCatalogOptions = Array.isArray(input)
    ? { roots: input }
    : (input as ScanSkillCatalogOptions);
  const limits = mergeLimits(options.limits);
  if (options.roots.length > limits.maxRoots) {
    throw new RangeError(`At most ${limits.maxRoots} skill roots may be scanned`);
  }

  const preparedRoots = await Promise.all(
    options.roots.map((root, index) => prepareRoot(root, index)),
  );
  const roots = preparedRoots.map((prepared) => prepared.result);
  const validRoots = preparedRoots.filter(
    (prepared): prepared is ValidRoot => prepared.canonicalPath !== null,
  );

  const discoveries: DiscoveryResult[] = [];
  for (const root of validRoots) {
    discoveries.push(await discoverRoot(root, limits));
  }
  const candidateMap = new Map<string, PackageCandidate>();
  const metadataSightings: MetadataSighting[] = [];
  for (const discovery of discoveries) {
    for (const candidate of discovery.packages) {
      mergePackageCandidate(candidateMap, candidate);
    }
    metadataSightings.push(...discovery.metadata);
  }

  const candidates = [...candidateMap.values()].sort((left, right) =>
    left.packageRoot.localeCompare(right.packageRoot),
  );
  const entries: SkillCatalogEntry[] = [];
  for (const candidate of candidates) {
    entries.push(await loadCatalogEntry(candidate, limits));
  }
  const duplicateIssues = resolveDuplicateNames(entries);

  const packageRoots = new Set(
    candidates.map((candidate) => candidateKey(candidate.packageRoot)),
  );
  const orphanMetadata: OrphanSkillMetadata[] = [];
  const seenMetadata = new Set<string>();
  for (const metadata of metadataSightings) {
    const key = candidateKey(metadata.canonicalPath);
    if (seenMetadata.has(key)) continue;
    seenMetadata.add(key);
    if (packageRoots.has(candidateKey(metadataOwnerPath(metadata.canonicalPath)))) {
      continue;
    }
    const orphanIssue = issue({
      code: "ORPHAN_OPENAI_METADATA",
      severity: "warning",
      message: "agents/openai.yaml is not owned by a discovered SKILL.md package",
      path: metadata.canonicalPath,
      rootId: metadata.rootId,
    });
    orphanMetadata.push({
      rootId: metadata.rootId,
      path: metadata.canonicalPath,
      reason: "no-owning-skill-package",
      issue: orphanIssue,
    });
  }

  entries.sort((left, right) => {
    const nameOrder = (left.name ?? "\uffff").localeCompare(right.name ?? "\uffff");
    return nameOrder || left.packageRoot.localeCompare(right.packageRoot);
  });
  orphanMetadata.sort((left, right) => left.path.localeCompare(right.path));
  const rootIssues = roots.flatMap((root) => root.issues);
  const orphanIssues = orphanMetadata.map((orphan) => orphan.issue);

  return {
    scannedAt: new Date().toISOString(),
    roots,
    entries,
    orphanMetadata,
    issues: [...rootIssues, ...duplicateIssues, ...orphanIssues],
  };
}
