export type ProviderKind = "claude" | "local";

export interface ClaudeProviderConfig {
  kind: "claude";
  model: string;
}

export interface LocalProviderConfig {
  kind: "local";
  model: string;
  endpoint: string;
}

export type ProviderConfig = ClaudeProviderConfig | LocalProviderConfig;

export type CatalogEntryStatus =
  | "valid"
  | "malformed"
  | "duplicate"
  | "unstable";

export type IssueSeverity = "info" | "warning" | "error";

export interface CatalogIssue {
  code: string;
  severity: IssueSeverity;
  path?: string;
  message: string;
}

export interface SkillPackageFile {
  path: string;
  size: number;
  digest: string;
  kind: string;
}

export interface SkillPresentation {
  displayName?: string;
  shortDescription?: string;
}

export interface SkillCatalogEntry {
  id: string;
  rootId: string;
  rootPath: string;
  packageRoot: string;
  manifestPath: string;
  status: CatalogEntryStatus;
  name?: string;
  description?: string;
  digest: string;
  fileCount: number;
  totalBytes: number;
  files: SkillPackageFile[];
  presentation?: SkillPresentation;
  issues: CatalogIssue[];
}

export interface OrphanedMetadata {
  path: string;
  rootPath?: string;
  message: string;
}

export interface SkillCatalog {
  entries: SkillCatalogEntry[];
  issues: CatalogIssue[];
  orphanedMetadata: OrphanedMetadata[];
  scannedAt: string;
}

export interface DetailNote {
  message: string;
  path?: string;
  code?: string;
}

export type ApplicabilityVerdict =
  | "applicable"
  | "not-applicable"
  | "not_applicable"
  | "unknown"
  | "blocked";

export interface Applicability {
  verdict: ApplicabilityVerdict;
  summary: string;
  evidence: DetailNote[];
}

export interface ContextFile {
  path: string;
  size: number;
  digest: string;
  reason: string;
  redactions: DetailNote[];
}

export interface ContextManifest {
  hash: string;
  totalBytes: number;
  files: ContextFile[];
}

export interface PreflightSkill {
  id: string;
  name: string;
  digest: string;
  packageRoot: string;
}

export interface RemoteEgressPreview {
  required: boolean;
  destination: string;
  contextHash: string;
}

export interface PlanPreflight {
  id: string;
  createdAt: string;
  canonicalRepository: string;
  skill: PreflightSkill;
  applicability: Applicability;
  contextManifest: ContextManifest;
  remoteEgress: RemoteEgressPreview;
  warnings: DetailNote[];
}

export interface ProviderModel {
  id: string;
  label?: string;
}

export interface ProviderHealth {
  healthy: boolean;
  status: string;
  message: string;
  models: ProviderModel[];
  checkedAt: string;
  discovery: "provider" | "static-aliases" | "unavailable" | "unknown";
}

export interface StartPlanResponse {
  runId: string;
}

export interface RunArtifactPaths {
  markdown?: string;
  json?: string;
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface RunResultMetadata {
  provider?: string;
  model?: string;
  skillDigest?: string;
  contextHash?: string;
  filesInspected?: string[];
  artifacts?: RunArtifactPaths;
  usage?: RunUsage;
}

export interface StructuredRunResult {
  markdown?: string;
  plan?: string;
  json?: unknown;
  metadata?: RunResultMetadata;
  artifacts?: RunArtifactPaths;
}

export type AgentEvent =
  | {
      type: "status";
      runId: string;
      phase: string;
      message: string;
      details?: Record<string, unknown>;
    }
  | { type: "text_delta"; runId: string; text: string }
  | { type: "tool_call"; runId: string; name: string; input: unknown }
  | {
      type: "diagnostic";
      runId: string;
      level: "info" | "warning" | "error";
      message: string;
    }
  | {
      type: "result";
      runId: string;
      success: boolean;
      cancelled: boolean;
      result?: string | StructuredRunResult;
      error?: string;
      durationMs?: number;
      turns?: number;
      costUsd?: number;
      metadata?: RunResultMetadata;
      artifacts?: RunArtifactPaths;
    };

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : {};
}

function at(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeSeverity(value: unknown): IssueSeverity {
  return value === "error" || value === "info" ? value : "warning";
}

function normalizeNote(value: unknown): DetailNote {
  if (typeof value === "string") return { message: value };
  const note = asRecord(value);
  return {
    message: asString(at(note, "message", "summary", "reason"), "No details supplied"),
    path: asString(at(note, "path", "file")) || undefined,
    code: asString(note.code) || undefined,
  };
}

function normalizeIssue(value: unknown): CatalogIssue {
  const issue = asRecord(value);
  return {
    code: asString(issue.code, "catalog_issue"),
    severity: normalizeSeverity(issue.severity),
    path: asString(issue.path) || undefined,
    message: asString(issue.message, "Catalog validation issue"),
  };
}

function normalizePackageFile(value: unknown): SkillPackageFile {
  const file = asRecord(value);
  return {
    path: asString(at(file, "path", "relativePath", "relative_path")),
    size: asNumber(file.size),
    digest: asString(at(file, "digest", "sha256")),
    kind: asString(file.kind, "data"),
  };
}

function normalizeCatalogEntry(
  value: unknown,
  index: number,
  rootPaths: ReadonlyMap<string, string>,
): SkillCatalogEntry {
  const entry = asRecord(value);
  const files = asArray(entry.files).map(normalizePackageFile);
  const presentation = asRecord(entry.presentation);
  const rootId = asString(at(entry, "rootId", "root_id"));
  const rawStatus = asString(entry.status, "malformed");
  const status: CatalogEntryStatus =
    rawStatus === "valid" ||
    rawStatus === "duplicate" ||
    rawStatus === "unstable"
      ? rawStatus
      : "malformed";

  return {
    id: asString(entry.id, `catalog-entry-${index}`),
    rootId,
    rootPath:
      asString(at(entry, "rootPath", "root_path")) || rootPaths.get(rootId) || "",
    packageRoot: asString(at(entry, "packageRoot", "package_root")),
    manifestPath: asString(at(entry, "manifestPath", "manifest_path")),
    status,
    name: asString(entry.name) || undefined,
    description: asString(entry.description) || undefined,
    digest: asString(entry.digest),
    fileCount: asNumber(at(entry, "fileCount", "file_count"), files.length),
    totalBytes: asNumber(at(entry, "totalBytes", "total_bytes")),
    files,
    presentation:
      Object.keys(presentation).length > 0
        ? {
            displayName:
              asString(at(presentation, "displayName", "display_name")) ||
              undefined,
            shortDescription:
              asString(
                at(presentation, "shortDescription", "short_description"),
              ) || undefined,
          }
        : undefined,
    issues: asArray(entry.issues).map(normalizeIssue),
  };
}

export function normalizeSkillCatalog(value: unknown): SkillCatalog {
  const catalog = asRecord(value);
  const rootPaths = new Map<string, string>();
  for (const rawRoot of asArray(catalog.roots)) {
    if (typeof rawRoot === "string") {
      rootPaths.set(rawRoot, rawRoot);
      continue;
    }
    const root = asRecord(rawRoot);
    const id = asString(at(root, "id", "rootId", "root_id"));
    const path = asString(
      at(
        root,
        "path",
        "rootPath",
        "root_path",
        "configuredPath",
        "configured_path",
        "resolvedPath",
        "resolved_path",
        "canonicalPath",
        "canonical_path",
      ),
    );
    if (id && path) rootPaths.set(id, path);
  }
  return {
    entries: asArray(catalog.entries).map((entry, index) =>
      normalizeCatalogEntry(entry, index, rootPaths),
    ),
    issues: asArray(catalog.issues).map(normalizeIssue),
    orphanedMetadata: asArray(
      at(
        catalog,
        "orphanedMetadata",
        "orphaned_metadata",
        "orphanMetadata",
        "orphan_metadata",
      ),
    ).map((raw) => {
      const orphan = asRecord(raw);
      return {
        path: typeof raw === "string" ? raw : asString(orphan.path),
        rootPath:
          asString(at(orphan, "rootPath", "root_path")) || undefined,
        message:
          asString(orphan.message) || "Metadata is outside a discovered skill package",
      };
    }),
    scannedAt: asString(at(catalog, "scannedAt", "scanned_at")),
  };
}

function normalizeContextFile(value: unknown): ContextFile {
  if (typeof value === "string") {
    return { path: value, size: 0, digest: "", reason: "Selected context", redactions: [] };
  }
  const file = asRecord(value);
  return {
    path: asString(at(file, "path", "relativePath", "relative_path")),
    size: asNumber(file.size),
    digest: asString(at(file, "digest", "sha256")),
    reason: asString(file.reason, "Selected context"),
    redactions: asArray(file.redactions).map(normalizeNote),
  };
}

function normalizeVerdict(value: unknown): ApplicabilityVerdict {
  if (value === true) return "applicable";
  if (value === false) return "not-applicable";
  const verdict = asString(value, "unknown").toLowerCase();
  if (verdict === "applicable" || verdict === "applies") return "applicable";
  if (
    verdict === "not_applicable" ||
    verdict === "not-applicable" ||
    verdict === "does-not-apply"
  ) {
    return "not-applicable";
  }
  return verdict === "blocked" ? "blocked" : "unknown";
}

export function normalizePreflight(value: unknown): PlanPreflight {
  const preflight = asRecord(value);
  const skill = asRecord(preflight.skill);
  const applicability = asRecord(preflight.applicability);
  const context = asRecord(
    at(preflight, "contextManifest", "context_manifest", "context"),
  );
  const egress = asRecord(at(preflight, "remoteEgress", "remote_egress"));
  const files = asArray(at(context, "files", "filesToRead", "files_to_read")).map(
    normalizeContextFile,
  );

  return {
    id: asString(at(preflight, "id", "preflightId", "preflight_id")),
    createdAt: asString(at(preflight, "createdAt", "created_at")),
    canonicalRepository: asString(
      at(
        preflight,
        "canonicalRepository",
        "canonical_repository",
        "canonicalPath",
        "canonical_path",
      ),
    ),
    skill: {
      id: asString(skill.id),
      name: asString(skill.name),
      digest: asString(skill.digest),
      packageRoot: asString(at(skill, "packageRoot", "package_root")),
    },
    applicability: {
      verdict: normalizeVerdict(
        at(applicability, "verdict", "applicable", "status"),
      ),
      summary: asString(
        at(applicability, "summary", "reason", "message"),
        "No applicability summary supplied",
      ),
      evidence: asArray(applicability.evidence).map(normalizeNote),
    },
    contextManifest: {
      hash: asString(at(context, "hash", "contextHash", "context_hash")),
      totalBytes: asNumber(at(context, "totalBytes", "total_bytes")),
      files,
    },
    remoteEgress: {
      required: asBoolean(egress.required),
      destination: asString(egress.destination),
      contextHash: asString(at(egress, "contextHash", "context_hash")),
    },
    warnings: asArray(preflight.warnings).map(normalizeNote),
  };
}

function normalizeModel(value: unknown): ProviderModel {
  if (typeof value === "string") return { id: value };
  const model = asRecord(value);
  return {
    id: asString(at(model, "id", "model", "name")),
    label: asString(at(model, "label", "displayName", "display_name")) || undefined,
  };
}

export function normalizeProviderHealth(value: unknown): ProviderHealth {
  const health = asRecord(value);
  const status = asString(health.status);
  const rawDiscovery = asString(health.discovery);
  const discovery: ProviderHealth["discovery"] =
    rawDiscovery === "provider" ||
    rawDiscovery === "static-aliases" ||
    rawDiscovery === "unavailable"
      ? rawDiscovery
      : "unknown";
  return {
    healthy: asBoolean(at(health, "healthy", "ok"), status === "healthy"),
    status: status || (asBoolean(at(health, "healthy", "ok")) ? "healthy" : "unavailable"),
    message: asString(health.message),
    models: asArray(health.models).map(normalizeModel).filter((model) => model.id),
    checkedAt: asString(at(health, "checkedAt", "checked_at")),
    discovery,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function shortDigest(digest: string): string {
  return digest ? digest.slice(0, 12) : "not available";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown application error";
  }
}
