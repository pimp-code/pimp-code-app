import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { hashStableJson, sha256, stableJson } from "./stable-json.js";

export const REPOSITORY_PREFLIGHT_SCHEMA_VERSION = "repository-preflight/v1";
export const CONTEXT_MANIFEST_SCHEMA_VERSION = "repository-context-manifest/v1";

export interface ContextSelectionLimits {
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_CONTEXT_SELECTION_LIMITS: Readonly<ContextSelectionLimits> = {
  maxDepth: 6,
  maxFiles: 80,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
};

export type ContextInclusionReason =
  | "ci-workflow"
  | "deployment-config"
  | "environment-template-names"
  | "html-entry"
  | "legacy-build-config"
  | "package-manager-lockfile"
  | "package-manifest"
  | "router-source"
  | "source-entry"
  | "test-source"
  | "test-config"
  | "tooling-config"
  | "typescript-config"
  | "vite-config"
  | "workspace-config";

export type PlanningContextProfile =
  | "migrate-to-vite"
  | "upgrade-react-router-to-v8";

export type ContextExclusionReason =
  | "binary-file"
  | "depth-limit"
  | "file-count-limit"
  | "file-too-large"
  | "generated-or-private-directory"
  | "invalid-utf8"
  | "outside-repository"
  | "path-denylist"
  | "router-signal-scan-limit"
  | "secret-path-denylist"
  | "special-file"
  | "suspected-secret-content"
  | "symlink"
  | "total-byte-limit";

export interface RepositoryPreflight {
  schemaVersion: typeof REPOSITORY_PREFLIGHT_SCHEMA_VERSION;
  requestedRepositoryPath: string;
  repositoryRoot: string;
  outputRoot: string;
  canonicalizationChanged: boolean;
  repositoryIdentitySha256: string;
}

export interface ContextManifestFile {
  relativePath: string;
  reason: ContextInclusionReason;
  sourceBytes: number;
  sourceSha256: string;
  contextBytes: number;
  contextSha256: string;
  contentKind: "text" | "environment-variable-names" | "lockfile-summary";
}

export interface ContextManifestExclusion {
  relativePath: string;
  reason: ContextExclusionReason;
}

export interface RepositoryContextManifest {
  schemaVersion: typeof CONTEXT_MANIFEST_SCHEMA_VERSION;
  repositoryRoot: string;
  files: ContextManifestFile[];
  excluded: ContextManifestExclusion[];
  environmentVariableNames: string[];
  scannedPathCount: number;
  totalContextBytes: number;
  manifestSha256: string;
}

export interface RepositoryContextDocument {
  relativePath: string;
  reason: ContextInclusionReason;
  contentKind: "text" | "environment-variable-names" | "lockfile-summary";
  content: string;
  contextSha256: string;
}

export interface RepositoryContextBundle {
  manifest: RepositoryContextManifest;
  documents: RepositoryContextDocument[];
}

const PRIVATE_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".cache",
  ".claude",
  ".codex",
  ".git",
  ".gnupg",
  ".hg",
  ".next",
  ".nuxt",
  ".pimp-my-codebase",
  ".svn",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const SECRET_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
]);

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const WORKSPACE_FILE_NAMES = new Set([
  "lerna.json",
  "nx.json",
  "pnpm-workspace.yaml",
  "rush.json",
  "turbo.json",
]);

const DEPLOYMENT_FILE_NAMES = new Set([
  "app.yaml",
  "firebase.json",
  "netlify.toml",
  "render.yaml",
  "render.yml",
  "staticwebapp.config.json",
  "vercel.json",
]);

const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key|secret[_-]?key)\s*[:=]\s*["']?[^\s,"'\]}]{8,}/iu,
];

const MAX_CONTEXT_DEPTH = 20;
const MAX_CONTEXT_FILES = 1_000;
const MAX_CONTEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 50 * 1024 * 1024;
const REDACTED_ENVIRONMENT_VALUE = "<redacted-environment-value>";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeForComparison(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

function assertOrdinaryLocalPath(path: string, label: string): void {
  if (process.platform === "win32" && /^(?:\\\\|\\\\[?.]\\)/u.test(path)) {
    throw new Error(`${label} must not use a UNC or device path`);
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  assertOrdinaryLocalPath(path, label);
  const requested = resolve(path);
  const requestedMetadata = await lstat(requested).catch((error: unknown) => {
    throw new Error(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink or junction`);
  }
  const canonical = await realpath(requested);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

export async function resolveRepositoryPreflight(options: {
  repositoryPath: string;
  outputRoot: string;
}): Promise<RepositoryPreflight> {
  if (!options.repositoryPath.trim()) throw new Error("Repository path is required");
  if (!options.outputRoot.trim()) throw new Error("Output root is required");

  const requestedRepositoryPath = resolve(options.repositoryPath);
  const repositoryRoot = await canonicalDirectory(
    options.repositoryPath,
    "Repository path",
  );
  const outputRoot = await canonicalDirectory(options.outputRoot, "Output root");
  if (
    pathIsWithin(repositoryRoot, outputRoot) ||
    pathIsWithin(outputRoot, repositoryRoot)
  ) {
    throw new Error("Repository and output roots must be disjoint");
  }

  return {
    schemaVersion: REPOSITORY_PREFLIGHT_SCHEMA_VERSION,
    requestedRepositoryPath,
    repositoryRoot,
    outputRoot,
    canonicalizationChanged:
      normalizeForComparison(requestedRepositoryPath) !==
      normalizeForComparison(repositoryRoot),
    repositoryIdentitySha256: sha256(repositoryRoot),
  };
}

function toRelativePath(root: string, absolutePath: string): string {
  const localPath = relative(root, absolutePath);
  if (
    localPath === "" ||
    localPath === ".." ||
    localPath.startsWith(`..${sep}`) ||
    isAbsolute(localPath)
  ) {
    throw new Error(`Path escapes the repository: ${absolutePath}`);
  }
  return localPath.split(sep).join("/");
}

function isEnvironmentTemplate(name: string): boolean {
  if (!name.startsWith(".env.")) return false;
  const segments = name.slice(5).split(".");
  return segments.some((segment) =>
    ["example", "sample", "template"].includes(segment),
  );
}

function isSecretPathSegment(segment: string): boolean {
  if (segment === ".env" || (segment.startsWith(".env.") && !isEnvironmentTemplate(segment))) {
    return true;
  }
  if (SECRET_FILE_NAMES.has(segment)) return true;
  if (/\.(?:key|p12|pfx|pem)$/u.test(segment)) return true;
  return /(?:^|[._-])secrets?(?:[._-]|$)/u.test(segment);
}

function isWindowsUnsafePathSegment(segment: string): boolean {
  if (!segment || segment.endsWith(".") || segment.endsWith(" ") || segment.includes(":")) {
    return true;
  }
  return /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment);
}

export function isDeniedRepositoryRelativePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split("/");
  return segments.some(
    (segment) =>
      PRIVATE_DIRECTORY_NAMES.has(segment) ||
      isSecretPathSegment(segment) ||
      isWindowsUnsafePathSegment(segment),
  );
}

function isSecretPath(relativePath: string): boolean {
  return relativePath
    .toLowerCase()
    .split("/")
    .some(isSecretPathSegment);
}

function inclusionReason(
  relativePath: string,
  profile: PlanningContextProfile,
): ContextInclusionReason | undefined {
  const lowerPath = relativePath.toLowerCase();
  const name = basename(lowerPath);

  if (name === "package.json") return "package-manifest";
  if (LOCKFILE_NAMES.has(name)) return "package-manager-lockfile";
  if (WORKSPACE_FILE_NAMES.has(name)) return "workspace-config";
  if (isEnvironmentTemplate(name)) return "environment-template-names";
  if (/^(?:vite|vitest)\.config\.[cm]?[jt]s$/u.test(name)) {
    return name.startsWith("vite.") ? "vite-config" : "test-config";
  }
  if (
    /^(?:webpack|rollup|craco|rspack|snowpack|vue)\.config\.[cm]?[jt]s$/u.test(name) ||
    /^webpack\.(?:common|dev|development|prod|production)\.[cm]?[jt]s$/u.test(name) ||
    /^config-overrides\.[cm]?[jt]s$/u.test(name) ||
    /^gulpfile(?:\.[cm]?[jt]s)?$/u.test(name) ||
    /^gruntfile(?:\.[cm]?[jt]s)?$/u.test(name) ||
    name === ".parcelrc"
  ) {
    return "legacy-build-config";
  }
  if (/^(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json$/u.test(name)) {
    return "typescript-config";
  }
  if (
    /^(?:babel|eslint|postcss|prettier|stylelint|tailwind)\.config\.[cm]?[jt]s$/u.test(
      name,
    ) ||
    [".babelrc", ".babelrc.json", ".eslintrc", ".eslintrc.json"].includes(name)
  ) {
    return "tooling-config";
  }
  if (/^(?:jest|playwright|cypress)\.config\.[cm]?[jt]s$/u.test(name)) {
    return "test-config";
  }
  if (name === "index.html" && lowerPath.split("/").length <= 4) {
    return "html-entry";
  }
  if (
    /(?:^|\/)src\/(?:main|index|app|entry|bootstrap)\.[cm]?[jt]sx?$/u.test(
      lowerPath,
    )
  ) {
    return "source-entry";
  }
  if (
    profile === "upgrade-react-router-to-v8" &&
    /(?:^|\/)(?:src|app|tests?|__tests__)\//u.test(lowerPath) &&
    /(?:\.test|\.spec)\.[cm]?[jt]sx?$/u.test(name)
  ) {
    return "test-source";
  }
  if (
    profile === "upgrade-react-router-to-v8" &&
    /(?:^|\/)(?:src|app|pages?|routes?|tests?|__tests__)\//u.test(lowerPath) &&
    /(?:^|\/)(?:router|routes?|routing|navigation|history)(?:[./_-]|$)/u.test(lowerPath) &&
    /\.[cm]?[jt]sx?$/u.test(name)
  ) {
    return "router-source";
  }
  if (
    lowerPath.startsWith(".github/workflows/") &&
    /\.ya?ml$/u.test(lowerPath)
  ) {
    return "ci-workflow";
  }
  if (
    DEPLOYMENT_FILE_NAMES.has(name) ||
    /^dockerfile(?:\..+)?$/u.test(name) ||
    name === "docker-compose.yml" ||
    name === "docker-compose.yaml"
  ) {
    return "deployment-config";
  }
  return undefined;
}

function isRouterSignalCandidate(relativePath: string): boolean {
  const lowerPath = relativePath.toLowerCase();
  return (
    /(?:^|\/)(?:src|app|pages?|features?|components?)\//u.test(lowerPath) &&
    /\.[cm]?[jt]sx?$/u.test(lowerPath) &&
    !/\.d\.[cm]?ts$/u.test(lowerPath)
  );
}

function containsRouterSourceSignal(content: string): boolean {
  return (
    /\b(?:from\s+|require\s*\(\s*)["']react-router(?:-dom)?["']/u.test(content) ||
    /\b(?:createBrowserRouter|createHashRouter|RouterProvider|useRoutes)\b/u.test(content) ||
    /<(?:BrowserRouter|HashRouter|MemoryRouter|Route|Routes)\b/u.test(content)
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function routerLockfileSummary(relativePath: string, content: string): string {
  const lowerPath = relativePath.toLowerCase();
  const routerPackages = ["react-router", "react-router-dom"] as const;
  const entries: Array<{
    packageName: (typeof routerPackages)[number];
    directSpecifier: string | null;
    resolvedVersion: string | null;
  }> = [];
  if (lowerPath.endsWith("package-lock.json") || lowerPath.endsWith("npm-shrinkwrap.json")) {
    try {
      const lock = objectRecord(JSON.parse(content) as unknown);
      const packages = objectRecord(lock?.packages);
      const root = objectRecord(packages?.[""]);
      const v1Dependencies = objectRecord(lock?.dependencies);
      for (const packageName of routerPackages) {
        let directSpecifier: string | null = null;
        for (const sectionName of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const section = objectRecord(root?.[sectionName]);
          if (typeof section?.[packageName] === "string") {
            directSpecifier = section[packageName] as string;
            break;
          }
        }
        const installed = objectRecord(packages?.[`node_modules/${packageName}`]);
        const v1 = objectRecord(v1Dependencies?.[packageName]);
        const resolved = installed?.version ?? v1?.version;
        const resolvedVersion = typeof resolved === "string" ? resolved : null;
        if (directSpecifier !== null || resolvedVersion !== null) {
          entries.push({ packageName, directSpecifier, resolvedVersion });
        }
      }
      return `${stableJson({ format: "npm", lockfileVersion: lock?.lockfileVersion ?? null, routerPackages: entries }, 2)}\n`;
    } catch {
      return `${stableJson({ format: "npm", malformed: true, routerPackages: [] }, 2)}\n`;
    }
  }

  for (const packageName of routerPackages) {
    const escaped = packageName.replace("-", "\\-");
    const resolvedMatch = new RegExp(`${escaped}(?:@|[/\\s:'\"])+(?:npm:)?[~^<>=v]*(\\d+(?:\\.\\d+){0,2})`, "iu").exec(content);
    if (resolvedMatch?.[1]) {
      entries.push({ packageName, directSpecifier: null, resolvedVersion: resolvedMatch[1] });
    }
  }
  return `${stableJson({ format: "other", routerPackages: entries }, 2)}\n`;
}

function extractEnvironmentNames(content: string): string[] {
  const names = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort(compareText);
}

function environmentNamesFromSource(content: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu,
    /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu,
    /\b([A-Z][A-Z0-9_]{1,})\s*=/gu,
    /["']([A-Z][A-Z0-9_]{1,})["']\s*:/gu,
    /^\s*(?:-\s*)?([A-Z][A-Z0-9_]{1,})\s*:/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

function redactEnvironmentValues(content: string): string {
  const inlineAssignment =
    /\b([A-Z][A-Z0-9_]{1,})\s*=\s*(?:\\"(?:\\\\.|[^"\\])*\\"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&|}\]]+)/gu;
  const quotedMapEntry =
    /(["']([A-Z][A-Z0-9_]{1,})["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gu;
  const yamlMapEntry =
    /^(\s*(?:-\s*)?([A-Z][A-Z0-9_]{1,})\s*:\s*)(?![>|]\s*$).+$/gmu;
  return content
    .replace(inlineAssignment, (_match, name: string) => `${name}=${REDACTED_ENVIRONMENT_VALUE}`)
    .replace(quotedMapEntry, (_match, prefix: string) => `${prefix}${JSON.stringify(REDACTED_ENVIRONMENT_VALUE)}`)
    .replace(yamlMapEntry, (_match, prefix: string) => `${prefix}${REDACTED_ENVIRONMENT_VALUE}`);
}

function containsSuspectedSecret(content: string): boolean {
  const withoutApprovedRedactions = content.replaceAll(REDACTED_ENVIRONMENT_VALUE, "");
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(withoutApprovedRedactions));
}

export function containsDisallowedSecretOrEnvironmentValue(content: string): boolean {
  return containsSuspectedSecret(content) || redactEnvironmentValues(content) !== content;
}

function mergeLimits(
  overrides: Partial<ContextSelectionLimits> | undefined,
): ContextSelectionLimits {
  const limits = { ...DEFAULT_CONTEXT_SELECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (limits.maxDepth > MAX_CONTEXT_DEPTH) {
    throw new Error(`maxDepth must not exceed ${MAX_CONTEXT_DEPTH}`);
  }
  if (limits.maxFiles > MAX_CONTEXT_FILES) {
    throw new Error(`maxFiles must not exceed ${MAX_CONTEXT_FILES}`);
  }
  if (limits.maxFileBytes > MAX_CONTEXT_FILE_BYTES) {
    throw new Error(`maxFileBytes must not exceed ${MAX_CONTEXT_FILE_BYTES}`);
  }
  if (limits.maxTotalBytes > MAX_CONTEXT_TOTAL_BYTES) {
    throw new Error(`maxTotalBytes must not exceed ${MAX_CONTEXT_TOTAL_BYTES}`);
  }
  return limits;
}

interface FileSnapshot {
  bytes?: Buffer;
  exclusion?: ContextExclusionReason;
}

function sameFileIdentity(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readRegularFileSnapshot(
  absolutePath: string,
  repositoryRoot: string,
  maxFileBytes: number,
): Promise<FileSnapshot> {
  const canonicalBefore = await realpath(absolutePath);
  if (!pathIsWithin(repositoryRoot, canonicalBefore)) return { exclusion: "outside-repository" };
  const noFollow = (constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { exclusion: "special-file" };
    if (before.size > maxFileBytes) return { exclusion: "file-too-large" };

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let position = 0;
    while (totalBytes <= maxFileBytes) {
      const remaining = maxFileBytes + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      position += bytesRead;
    }
    if (totalBytes > maxFileBytes) return { exclusion: "file-too-large" };

    const after = await handle.stat();
    const pathAfter = await lstat(absolutePath);
    const canonicalAfter = await realpath(absolutePath);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, pathAfter) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      normalizeForComparison(canonicalBefore) !== normalizeForComparison(canonicalAfter) ||
      !pathIsWithin(repositoryRoot, canonicalAfter)
    ) {
      throw new Error(`Selected context file changed while it was read: ${absolutePath}`);
    }
    return { bytes: Buffer.concat(chunks, totalBytes) };
  } finally {
    await handle.close();
  }
}

async function selectRepositoryContext(
  preflight: RepositoryPreflight,
  profile: PlanningContextProfile,
  limitOverrides?: Partial<ContextSelectionLimits>,
): Promise<RepositoryContextBundle> {
  const rootMetadata = await lstat(preflight.repositoryRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Repository root changed or became a symlink after preflight");
  }
  const repositoryRoot = await realpath(preflight.repositoryRoot);
  if (normalizeForComparison(repositoryRoot) !== normalizeForComparison(preflight.repositoryRoot)) {
    throw new Error("Repository root changed after preflight");
  }
  const limits = mergeLimits(limitOverrides);
  const files: ContextManifestFile[] = [];
  const excluded: ContextManifestExclusion[] = [];
  const documents: RepositoryContextDocument[] = [];
  const environmentVariableNames = new Set<string>();
  let scannedPathCount = 0;
  let totalContextBytes = 0;
  let routerSignalCandidateCount = 0;

  const exclude = (relativePath: string, reason: ContextExclusionReason): void => {
    excluded.push({ relativePath, reason });
  };

  const scanDirectory = async (
    directoryPath: string,
    depth: number,
  ): Promise<void> => {
    const directoryMetadata = await lstat(directoryPath);
    const canonicalDirectoryPath = await realpath(directoryPath);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory() ||
      !pathIsWithin(repositoryRoot, canonicalDirectoryPath) ||
      normalizeForComparison(canonicalDirectoryPath) !== normalizeForComparison(directoryPath)
    ) {
      throw new Error(`Repository directory changed while scanning: ${directoryPath}`);
    }
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      const absolutePath = resolve(directoryPath, entry.name);
      const relativePath = toRelativePath(repositoryRoot, absolutePath);
      scannedPathCount += 1;
      const lowerName = entry.name.toLowerCase();

      if (entry.isDirectory() && PRIVATE_DIRECTORY_NAMES.has(lowerName)) {
        exclude(relativePath, "generated-or-private-directory");
        continue;
      }

      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        exclude(relativePath, "symlink");
        continue;
      }
      if (metadata.isDirectory()) {
        if (depth >= limits.maxDepth) {
          exclude(relativePath, "depth-limit");
        } else {
          await scanDirectory(absolutePath, depth + 1);
        }
        continue;
      }
      if (!metadata.isFile()) {
        exclude(relativePath, "special-file");
        continue;
      }
      if (isSecretPath(relativePath)) {
        exclude(relativePath, "secret-path-denylist");
        continue;
      }
      if (isDeniedRepositoryRelativePath(relativePath)) {
        exclude(relativePath, "path-denylist");
        continue;
      }

      let reason = inclusionReason(relativePath, profile);
      const routerSignalCandidate =
        reason === undefined &&
        profile === "upgrade-react-router-to-v8" &&
        isRouterSignalCandidate(relativePath);
      if (!reason && !routerSignalCandidate) continue;
      if (routerSignalCandidate) {
        routerSignalCandidateCount += 1;
        if (routerSignalCandidateCount > limits.maxFiles * 4) {
          exclude(relativePath, "router-signal-scan-limit");
          continue;
        }
      }
      if (files.length >= limits.maxFiles) {
        exclude(relativePath, "file-count-limit");
        continue;
      }
      if (metadata.size > limits.maxFileBytes) {
        exclude(relativePath, "file-too-large");
        continue;
      }

      const snapshot = await readRegularFileSnapshot(
        absolutePath,
        repositoryRoot,
        limits.maxFileBytes,
      );
      if (snapshot.exclusion) {
        exclude(relativePath, snapshot.exclusion);
        continue;
      }
      const bytes = snapshot.bytes;
      if (!bytes) throw new Error(`Context snapshot is unavailable: ${relativePath}`);
      if (bytes.includes(0)) {
        exclude(relativePath, "binary-file");
        continue;
      }

      let sourceContent: string;
      try {
        sourceContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        exclude(relativePath, "invalid-utf8");
        continue;
      }
      if (routerSignalCandidate) {
        if (!containsRouterSourceSignal(sourceContent)) continue;
        reason = "router-source";
      }
      if (!reason) throw new Error(`Context inclusion reason is unavailable: ${relativePath}`);
      let content = sourceContent;
      let contentKind: ContextManifestFile["contentKind"] = "text";
      if (reason === "environment-template-names") {
        const names = extractEnvironmentNames(sourceContent);
        for (const name of names) environmentVariableNames.add(name);
        content = names.join("\n") + (names.length > 0 ? "\n" : "");
        contentKind = "environment-variable-names";
      } else if (
        profile === "upgrade-react-router-to-v8" &&
        reason === "package-manager-lockfile"
      ) {
        content = routerLockfileSummary(relativePath, sourceContent);
        contentKind = "lockfile-summary";
      } else {
        for (const name of environmentNamesFromSource(sourceContent)) {
          environmentVariableNames.add(name);
        }
        content = redactEnvironmentValues(sourceContent);
        if (containsSuspectedSecret(content)) {
          exclude(relativePath, "suspected-secret-content");
          continue;
        }
      }

      const contextBytes = Buffer.byteLength(content, "utf8");
      if (totalContextBytes + contextBytes > limits.maxTotalBytes) {
        exclude(relativePath, "total-byte-limit");
        continue;
      }
      const contextSha256 = sha256(content);
      files.push({
        relativePath,
        reason,
        sourceBytes: bytes.length,
        sourceSha256: sha256(bytes),
        contextBytes,
        contextSha256,
        contentKind,
      });
      documents.push({
        relativePath,
        reason,
        contentKind,
        content,
        contextSha256,
      });
      totalContextBytes += contextBytes;
    }
  };

  await scanDirectory(repositoryRoot, 0);
  files.sort((left, right) => compareText(left.relativePath, right.relativePath));
  documents.sort((left, right) => compareText(left.relativePath, right.relativePath));
  excluded.sort((left, right) => {
    const pathOrder = compareText(left.relativePath, right.relativePath);
    return pathOrder === 0 ? compareText(left.reason, right.reason) : pathOrder;
  });

  const manifestWithoutHash: Omit<RepositoryContextManifest, "manifestSha256"> = {
    schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
    repositoryRoot,
    files,
    excluded,
    environmentVariableNames: [...environmentVariableNames].sort(compareText),
    scannedPathCount,
    totalContextBytes,
  };
  const manifest: RepositoryContextManifest = {
    ...manifestWithoutHash,
    manifestSha256: hashStableJson(manifestWithoutHash),
  };
  return { manifest, documents };
}

export async function selectMigrateToViteContext(
  preflight: RepositoryPreflight,
  limitOverrides?: Partial<ContextSelectionLimits>,
): Promise<RepositoryContextBundle> {
  return selectRepositoryContext(preflight, "migrate-to-vite", limitOverrides);
}

export async function selectUpgradeReactRouterToV8Context(
  preflight: RepositoryPreflight,
  limitOverrides?: Partial<ContextSelectionLimits>,
): Promise<RepositoryContextBundle> {
  return selectRepositoryContext(
    preflight,
    "upgrade-react-router-to-v8",
    limitOverrides,
  );
}
