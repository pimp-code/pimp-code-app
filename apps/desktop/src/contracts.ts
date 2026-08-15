export type ProviderKind = "claude" | "codex" | "local";

export interface ClaudeProviderConfig {
  kind: "claude";
  model: string;
}

export interface CodexProviderConfig {
  kind: "codex";
  model: string;
}

export interface LocalProviderConfig {
  kind: "local";
  model: string;
  endpoint: string;
}

export type ProviderConfig =
  | ClaudeProviderConfig
  | CodexProviderConfig
  | LocalProviderConfig;

export interface ProjectRecord {
  id: string;
  name: string;
  configuredPath: string;
  canonicalPath: string;
  workspacePath?: string;
  defaultProviderProfileId?: string;
  defaultModel?: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
}

export interface ProjectSettings {
  version: number;
  activeProjectId?: string;
  projects: ProjectRecord[];
}

export interface ProjectUpdateInput {
  id: string;
  name: string;
  configuredPath?: string;
  defaultProviderProfileId?: string;
  defaultModel?: string;
}

export interface JobRetentionSettings {
  enabled: boolean;
  maxTerminalJobs: number;
  maxAgeDays?: number;
}

export interface ApplicationSettings {
  version: number;
  jobRetention: JobRetentionSettings;
}

export interface ProviderProfileRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  endpoint?: string;
  defaultModel: string;
  credentialRef?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderProfileInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  endpoint?: string;
  defaultModel: string;
  credentialRef?: string;
}

export interface ProviderProfileSettings {
  version: number;
  profiles: ProviderProfileRecord[];
}

export interface ProviderCredentialStatus {
  profileId: string;
  source: "windowsVault" | "environment" | "none";
  configured: boolean;
}

export type JobRunMode = "plan" | "apply";
export type JobApprovalMode = "guided" | "continuous";
export type JobStatus =
  | "draft"
  | "ready"
  | "planning"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked";

export interface JobProviderSnapshot {
  profileId: string;
  profileRevision: number;
  profileName: string;
  kind: ProviderKind;
  endpoint?: string;
  model: string;
}

export interface JobAttempt {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: JobStatus;
}

export interface JobRecord {
  id: string;
  projectId: string;
  projectName: string;
  canonicalRepository: string;
  skillId: string;
  skillName: string;
  skillDigest: string;
  skillRoot: string;
  provider?: JobProviderSnapshot;
  runMode: JobRunMode;
  approvalMode: JobApprovalMode;
  maxTurns: number;
  status: JobStatus;
  currentStage: string;
  preflightId?: string;
  activeRunId?: string;
  attempts: JobAttempt[];
  resultPath?: string;
  artifactPaths: string[];
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface JobStore {
  version: number;
  jobs: JobRecord[];
}

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
  planningSupported: boolean;
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

export function normalizeProjectSettings(value: unknown): ProjectSettings {
  const settings = asRecord(value);
  const projects = asArray(settings.projects)
    .map((raw): ProjectRecord => {
      const project = asRecord(raw);
      return {
        id: asString(project.id),
        name: asString(project.name, "Unnamed project"),
        configuredPath: asString(at(project, "configuredPath", "configured_path")),
        canonicalPath: asString(at(project, "canonicalPath", "canonical_path")),
        workspacePath:
          asString(at(project, "workspacePath", "workspace_path")) || undefined,
        defaultProviderProfileId:
          asString(
            at(
              project,
              "defaultProviderProfileId",
              "default_provider_profile_id",
            ),
          ) || undefined,
        defaultModel:
          asString(at(project, "defaultModel", "default_model")) || undefined,
        createdAt: asNumber(at(project, "createdAt", "created_at")),
        updatedAt: asNumber(at(project, "updatedAt", "updated_at")),
        lastOpenedAt:
          asNumber(at(project, "lastOpenedAt", "last_opened_at")) || undefined,
      };
    })
    .filter((project) => project.id && project.canonicalPath);
  const activeProjectId = asString(
    at(settings, "activeProjectId", "active_project_id"),
  );
  return {
    version: asNumber(settings.version, 1),
    activeProjectId:
      activeProjectId && projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : projects[0]?.id,
    projects,
  };
}

export function normalizeApplicationSettings(value: unknown): ApplicationSettings {
  const settings = asRecord(value);
  const retention = asRecord(at(settings, "jobRetention", "job_retention"));
  const maxTerminalJobs = asNumber(
    at(retention, "maxTerminalJobs", "max_terminal_jobs"),
    500,
  );
  const rawMaxAgeDays = at(retention, "maxAgeDays", "max_age_days");
  const maxAgeDays = asNumber(rawMaxAgeDays, 365);
  return {
    version: asNumber(settings.version, 1),
    jobRetention: {
      enabled: asBoolean(retention.enabled),
      maxTerminalJobs:
        Number.isInteger(maxTerminalJobs) &&
        maxTerminalJobs >= 1 &&
        maxTerminalJobs <= 10_000
          ? maxTerminalJobs
          : 500,
      maxAgeDays:
        rawMaxAgeDays === null || rawMaxAgeDays === undefined
          ? undefined
          : Number.isInteger(maxAgeDays) && maxAgeDays >= 1 && maxAgeDays <= 3_650
            ? maxAgeDays
            : 365,
    },
  };
}

export function normalizeProviderProfileSettings(
  value: unknown,
): ProviderProfileSettings {
  const settings = asRecord(value);
  return {
    version: asNumber(settings.version, 1),
    profiles: asArray(settings.profiles)
      .map((raw): ProviderProfileRecord => {
        const profile = asRecord(raw);
        return {
          id: asString(profile.id),
          name: asString(profile.name, "Unnamed profile"),
          kind:
            profile.kind === "claude" || profile.kind === "codex"
              ? profile.kind
              : "local",
          endpoint: asString(profile.endpoint) || undefined,
          defaultModel: asString(
            at(profile, "defaultModel", "default_model"),
          ),
          credentialRef:
            asString(at(profile, "credentialRef", "credential_ref")) ||
            undefined,
          revision: asNumber(profile.revision, 1),
          createdAt: asNumber(at(profile, "createdAt", "created_at")),
          updatedAt: asNumber(at(profile, "updatedAt", "updated_at")),
        };
      })
      .filter((profile) => profile.id && profile.defaultModel),
  };
}

export function normalizeProviderCredentialStatus(
  value: unknown,
): ProviderCredentialStatus {
  const status = asRecord(value);
  const source = status.source;
  return {
    profileId: asString(at(status, "profileId", "profile_id")),
    source:
      source === "windowsVault" || source === "environment"
        ? source
        : "none",
    configured: status.configured === true,
  };
}

function normalizeJobStatus(value: unknown): JobStatus {
  return value === "draft" ||
    value === "ready" ||
    value === "planning" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
    ? value
    : "blocked";
}

function normalizeJobProvider(value: unknown): JobProviderSnapshot | undefined {
  const provider = asRecord(value);
  const profileId = asString(at(provider, "profileId", "profile_id"));
  const model = asString(provider.model);
  if (!profileId || !model) return undefined;
  return {
    profileId,
    profileRevision: asNumber(
      at(provider, "profileRevision", "profile_revision"),
      1,
    ),
    profileName: asString(
      at(provider, "profileName", "profile_name"),
      "Unknown profile",
    ),
    kind:
      provider.kind === "claude" || provider.kind === "codex"
        ? provider.kind
        : "local",
    endpoint: asString(provider.endpoint) || undefined,
    model,
  };
}

export function normalizeJobStore(value: unknown): JobStore {
  const store = asRecord(value);
  return {
    version: asNumber(store.version, 1),
    jobs: asArray(store.jobs)
      .map((raw): JobRecord => {
        const job = asRecord(raw);
        return {
          id: asString(job.id),
          projectId: asString(at(job, "projectId", "project_id")),
          projectName: asString(
            at(job, "projectName", "project_name"),
            "Unknown project",
          ),
          canonicalRepository: asString(
            at(job, "canonicalRepository", "canonical_repository"),
          ),
          skillId: asString(at(job, "skillId", "skill_id")),
          skillName: asString(
            at(job, "skillName", "skill_name"),
            "Unknown skill",
          ),
          skillDigest: asString(at(job, "skillDigest", "skill_digest")),
          skillRoot: asString(at(job, "skillRoot", "skill_root")),
          provider: normalizeJobProvider(job.provider),
          runMode: job.runMode === "apply" ? "apply" : "plan",
          approvalMode:
            job.approvalMode === "continuous" ? "continuous" : "guided",
          maxTurns: asNumber(at(job, "maxTurns", "max_turns"), 10),
          status: normalizeJobStatus(job.status),
          currentStage: asString(
            at(job, "currentStage", "current_stage"),
            "unknown",
          ),
          preflightId:
            asString(at(job, "preflightId", "preflight_id")) || undefined,
          activeRunId:
            asString(at(job, "activeRunId", "active_run_id")) || undefined,
          attempts: asArray(job.attempts)
            .map((rawAttempt): JobAttempt => {
              const attempt = asRecord(rawAttempt);
              return {
                runId: asString(at(attempt, "runId", "run_id")),
                startedAt: asNumber(at(attempt, "startedAt", "started_at")),
                finishedAt:
                  asNumber(at(attempt, "finishedAt", "finished_at")) ||
                  undefined,
                outcome: attempt.outcome
                  ? normalizeJobStatus(attempt.outcome)
                  : undefined,
              };
            })
            .filter((attempt) => attempt.runId),
          resultPath:
            asString(at(job, "resultPath", "result_path")) || undefined,
          artifactPaths: asArray(
            at(job, "artifactPaths", "artifact_paths"),
          ).filter((path): path is string => typeof path === "string"),
          lastError:
            asString(at(job, "lastError", "last_error")) || undefined,
          createdAt: asNumber(at(job, "createdAt", "created_at")),
          updatedAt: asNumber(at(job, "updatedAt", "updated_at")),
        };
      })
      .filter((job) => job.id && job.projectId && job.skillId),
  };
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
    planningSupported: asBoolean(
      at(entry, "planningSupported", "planning_supported"),
    ),
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
