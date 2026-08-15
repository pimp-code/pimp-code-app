import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppShell,
  JobsPage,
  OverviewPage,
  ProjectsPage,
  ProviderProfilesPage,
  SettingsPage,
  SkillsPage,
  type AppView,
} from "./AppShell";
import {
  type AgentEvent,
  type ApplicationSettings,
  type CatalogIssue,
  type DetailNote,
  type JobProviderSnapshot,
  type JobRecord,
  type JobStore,
  type PlanPreflight,
  type ProjectSettings,
  type ProjectUpdateInput,
  type ProviderConfig,
  type ProviderCredentialStatus,
  type ProviderHealth,
  type ProviderKind,
  type ProviderProfileInput,
  type ProviderProfileRecord,
  type ProviderProfileSettings,
  type RunArtifactPaths,
  type RunResultMetadata,
  type SkillCatalog,
  type SkillCatalogEntry,
  type StartPlanResponse,
  type StructuredRunResult,
  errorMessage,
  formatBytes,
  normalizePreflight,
  normalizeApplicationSettings,
  normalizeJobStore,
  normalizeProjectSettings,
  normalizeProviderHealth,
  normalizeProviderCredentialStatus,
  normalizeProviderProfileSettings,
  normalizeSkillCatalog,
  shortDigest,
} from "./contracts";
import { MarkdownChecklist } from "./MarkdownChecklist";

interface TimelineItem {
  id: number;
  tone: "neutral" | "warning" | "error" | "success";
  label: string;
  detail?: string;
}

interface OperationNotice {
  tone: "neutral" | "warning" | "error" | "success";
  message: string;
}

interface RunSummary extends RunResultMetadata {
  durationMs?: number;
  turns?: number;
  costUsd?: number;
  artifacts?: RunArtifactPaths;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:1234/v1";
const DEFAULT_MAX_TURNS = 10;
const MIN_MAX_TURNS = 1;
const MAX_MAX_TURNS = 20;

function safeDetail(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Details could not be displayed";
  }
}

function resultObject(
  result: string | StructuredRunResult | undefined,
): StructuredRunResult | undefined {
  return typeof result === "object" && result !== null ? result : undefined;
}

function resultText(result: string | StructuredRunResult | undefined): string {
  if (typeof result === "string") return result;
  return result?.markdown ?? result?.plan ?? "";
}

function displayTimestamp(value: string): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function noteText(note: DetailNote): string {
  return [note.path, note.message].filter(Boolean).join(" — ");
}

function issueText(issue: CatalogIssue): string {
  return [issue.code, issue.path, issue.message].filter(Boolean).join(" · ");
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRunnableSkill(entry: SkillCatalogEntry): boolean {
  return (
    entry.status === "valid" &&
    entry.planningSupported &&
    hasText(entry.id) &&
    hasText(entry.name) &&
    hasText(entry.digest) &&
    hasText(entry.rootPath)
  );
}

function assertPreparedPreflightMatchesSkill(
  preflight: PlanPreflight,
  selectedSkill: SkillCatalogEntry,
): void {
  if (
    !hasText(preflight.id) ||
    !hasText(preflight.canonicalRepository) ||
    !hasText(preflight.contextManifest.hash) ||
    !hasText(preflight.skill.id) ||
    !hasText(preflight.skill.name) ||
    !hasText(preflight.skill.digest) ||
    !hasText(preflight.skill.packageRoot)
  ) {
    throw new Error("Planning preflight response is incomplete.");
  }
  if (
    preflight.skill.id !== selectedSkill.id ||
    preflight.skill.name !== selectedSkill.name ||
    preflight.skill.digest !== selectedSkill.digest
  ) {
    throw new Error(
      "Planning preflight does not match the selected skill package.",
    );
  }
  if (
    hasText(preflight.remoteEgress.contextHash) &&
    preflight.remoteEgress.contextHash !== preflight.contextManifest.hash
  ) {
    throw new Error("Planning preflight contains inconsistent context hashes.");
  }
}

function catalogEntryName(entry: SkillCatalogEntry): string {
  return (
    entry.presentation?.displayName ??
    entry.name ??
    entry.manifestPath ??
    "Unnamed skill package"
  );
}

function normalizeJobRecord(value: unknown): JobRecord {
  const job = normalizeJobStore({ version: 1, jobs: [value] }).jobs[0];
  if (!job) throw new Error("The desktop host returned an invalid job record.");
  return job;
}

function storedJobResultText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const event = value as { result?: string | StructuredRunResult };
  return resultText(event.result);
}

function matchesEditableJob(job: JobRecord): boolean {
  return job.status === "draft" || job.status === "ready";
}

function jobSetupMatches(
  job: JobRecord,
  provider: JobProviderSnapshot,
  maxTurns: number,
): boolean {
  const savedProvider = job.provider;
  return (
    savedProvider !== undefined &&
    savedProvider.profileId === provider.profileId &&
    savedProvider.profileRevision === provider.profileRevision &&
    savedProvider.profileName === provider.profileName &&
    savedProvider.kind === provider.kind &&
    (savedProvider.endpoint ?? "") === (provider.endpoint ?? "") &&
    savedProvider.model === provider.model &&
    job.runMode === "plan" &&
    job.approvalMode === "guided" &&
    job.maxTurns === maxTurns
  );
}

export function App() {
  const [view, setView] = useState<AppView>("overview");
  const [projects, setProjects] = useState<ProjectSettings>({
    version: 1,
    projects: [],
  });
  const [providerProfiles, setProviderProfiles] =
    useState<ProviderProfileSettings>({ version: 1, profiles: [] });
  const [providerCredentialStatus, setProviderCredentialStatus] =
    useState<ProviderCredentialStatus>();
  const [applicationSettings, setApplicationSettings] =
    useState<ApplicationSettings>({
      version: 1,
      jobRetention: {
        enabled: false,
        maxTerminalJobs: 500,
        maxAgeDays: 365,
      },
    });
  const [selectedProviderProfileId, setSelectedProviderProfileId] =
    useState("");
  const [jobs, setJobs] = useState<JobStore>({ version: 1, jobs: [] });
  const [activeJobId, setActiveJobId] = useState("");
  const [selectedHistoryJobId, setSelectedHistoryJobId] = useState("");
  const [historyResult, setHistoryResult] = useState("");
  const [loadingHistoryResult, setLoadingHistoryResult] = useState(false);
  const [repository, setRepository] = useState("");
  const [skillRoots, setSkillRoots] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [providerKind, setProviderKind] = useState<ProviderKind>("local");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [maxTurns, setMaxTurns] = useState(DEFAULT_MAX_TURNS);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth>();
  const [preflight, setPreflight] = useState<PlanPreflight>();
  const [canonicalConfirmed, setCanonicalConfirmed] = useState(false);
  const [remoteEgressApproved, setRemoteEgressApproved] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [runSummary, setRunSummary] = useState<RunSummary>();
  const [notice, setNotice] = useState<OperationNotice>();
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [scanningCatalog, setScanningCatalog] = useState(false);
  const [checkingProvider, setCheckingProvider] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [creatingJob, setCreatingJob] = useState(false);
  const sequence = useRef(0);
  const preflightRevision = useRef(0);
  const providerHealthRevision = useRef(0);
  const providerCredentialStatusRevision = useRef(0);

  const refreshProviderCredentialStatus = useCallback(async (profileId: string) => {
    const revision = providerCredentialStatusRevision.current + 1;
    providerCredentialStatusRevision.current = revision;
    setProviderCredentialStatus(undefined);
    if (!profileId) return;
    try {
      const value = await invoke<unknown>("provider_credential_status", {
        profileId,
      });
      if (revision !== providerCredentialStatusRevision.current) return;
      const status = normalizeProviderCredentialStatus(value);
      if (status.profileId === profileId) setProviderCredentialStatus(status);
    } catch (error) {
      if (revision === providerCredentialStatusRevision.current) {
        setNotice({ tone: "error", message: errorMessage(error) });
      }
    }
  }, []);

  const selectedSkill = useMemo(
    () => catalog?.entries.find((entry) => entry.id === selectedSkillId),
    [catalog, selectedSkillId],
  );

  const activeProject = useMemo(
    () =>
      projects.projects.find(
        (project) => project.id === projects.activeProjectId,
      ),
    [projects],
  );

  const selectedProviderProfile = useMemo(
    () =>
      providerProfiles.profiles.find(
        (profile) => profile.id === selectedProviderProfileId,
      ),
    [providerProfiles, selectedProviderProfileId],
  );

  useEffect(() => {
    void refreshProviderCredentialStatus(selectedProviderProfileId);
  }, [refreshProviderCredentialStatus, selectedProviderProfileId]);

  const activeJob = useMemo(
    () => jobs.jobs.find((job) => job.id === activeJobId),
    [activeJobId, jobs],
  );

  const catalogProblemCount = useMemo(
    () =>
      (catalog?.issues.length ?? 0) +
      (catalog?.orphanedMetadata.length ?? 0) +
      (catalog?.entries.filter((entry) => entry.status !== "valid").length ?? 0),
    [catalog],
  );

  const provider = useMemo<ProviderConfig>(
    () =>
      providerKind === "claude"
        ? { kind: "claude", model: model.trim() }
        : providerKind === "codex"
          ? { kind: "codex", model: model.trim() }
        : {
            kind: "local",
            model: model.trim(),
            endpoint: endpoint.trim(),
          },
    [endpoint, model, providerKind],
  );

  const preflightApplicable =
    preflight?.applicability.verdict === "applicable";
  const needsRemoteApproval = providerKind !== "local";
  const effectiveMaxTurns = providerKind === "codex" ? 1 : maxTurns;
  const selectedLocalModelIsAvailable =
    providerKind !== "local" ||
    providerHealth?.models.some(
      (availableModel) => availableModel.id === model.trim(),
    ) === true;
  const providerReady =
    providerHealth?.healthy === true &&
    providerHealth.status === "ready" &&
    selectedLocalModelIsAvailable;
  const canCheckProvider =
    !checkingProvider &&
    selectedProviderProfile !== undefined &&
    (providerKind !== "local" || endpoint.trim().length > 0);
  const canPrepare =
    activeProject !== undefined &&
    activeJob !== undefined &&
    selectedProviderProfile !== undefined &&
    repository.trim().length > 0 &&
    selectedSkill !== undefined &&
    isRunnableSkill(selectedSkill) &&
    providerReady &&
    model.trim().length > 0 &&
    !loadingRoots &&
    !scanningCatalog &&
    !preparing &&
    !loadingSettings &&
    !running;
  const canStart =
    activeJob !== undefined &&
    activeJob.status === "ready" &&
    preflight !== undefined &&
    preflight.id.length > 0 &&
    activeJob.preflightId === preflight.id &&
    preflightApplicable &&
    preflight.contextManifest.files.length > 0 &&
    canonicalConfirmed &&
    providerReady &&
    model.trim().length > 0 &&
    (!needsRemoteApproval || remoteEgressApproved) &&
    !running;

  const addTimeline = useCallback(
    (
      label: string,
      tone: TimelineItem["tone"] = "neutral",
      detail?: string,
    ) => {
      setTimeline((items) => [
        ...items,
        { id: ++sequence.current, label, tone, detail },
      ]);
    },
    [],
  );

  const invalidatePreflight = useCallback(() => {
    preflightRevision.current += 1;
    setPreflight(undefined);
    setCanonicalConfirmed(false);
    setRemoteEgressApproved(false);
  }, []);

  const invalidateProviderHealth = useCallback(() => {
    providerHealthRevision.current += 1;
    setProviderHealth(undefined);
  }, []);

  const applyJobRecord = useCallback((job: JobRecord) => {
    setJobs((current) => ({
      ...current,
      jobs: [job, ...current.jobs.filter((item) => item.id !== job.id)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    }));
  }, []);

  const refreshJobs = useCallback(async () => {
    const value = await invoke<unknown>("list_jobs");
    setJobs(normalizeJobStore(value));
  }, []);

  const providerSnapshot = useCallback(
    (profile = selectedProviderProfile, selectedModel = model): JobProviderSnapshot | undefined =>
      profile
        ? {
            profileId: profile.id,
            profileRevision: profile.revision,
            profileName: profile.name,
            kind: profile.kind,
            endpoint: profile.endpoint,
            model: selectedModel.trim() || profile.defaultModel,
          }
        : undefined,
    [model, selectedProviderProfile],
  );

  const activateProviderProfile = useCallback(
    (profile: ProviderProfileRecord | undefined, selectedModel?: string) => {
      setSelectedProviderProfileId(profile?.id ?? "");
      setProviderKind(profile?.kind ?? "local");
      setEndpoint(profile?.endpoint ?? DEFAULT_ENDPOINT);
      setModel(selectedModel?.trim() || profile?.defaultModel || "");
      invalidateProviderHealth();
      invalidatePreflight();
    },
    [invalidatePreflight, invalidateProviderHealth],
  );

  const applyCatalog = useCallback((nextCatalog: SkillCatalog) => {
    setCatalog(nextCatalog);
    setSelectedSkillId((current) => {
      if (
        nextCatalog.entries.some(
          (entry) => entry.id === current && isRunnableSkill(entry),
        )
      ) {
        return current;
      }
      return "";
    });
  }, []);

  const scanRoots = useCallback(
    async (roots: string[], successMessage?: string) => {
      setScanningCatalog(true);
      invalidatePreflight();
      try {
        const rawCatalog = await invoke<unknown>("scan_skill_catalog", {
          roots,
        });
        const nextCatalog = normalizeSkillCatalog(rawCatalog);
        applyCatalog(nextCatalog);
        setNotice({
          tone:
            nextCatalog.issues.some((issue) => issue.severity === "error")
              ? "warning"
              : "success",
          message:
            successMessage ??
            `Catalog scan found ${nextCatalog.entries.length} package${nextCatalog.entries.length === 1 ? "" : "s"}.`,
        });
      } catch (error) {
        setNotice({ tone: "error", message: errorMessage(error) });
      } finally {
        setScanningCatalog(false);
      }
    },
    [applyCatalog, invalidatePreflight],
  );

  useEffect(() => {
    let disposed = false;
    setLoadingSettings(true);

    void Promise.all([
      invoke<unknown>("list_projects"),
      invoke<unknown>("list_provider_profiles"),
      invoke<unknown>("list_application_settings"),
      invoke<unknown>("list_jobs"),
    ])
      .then(([rawProjects, rawProfiles, rawApplicationSettings, rawJobs]) => {
        if (disposed) return;
        const nextProjects = normalizeProjectSettings(rawProjects);
        const nextProfiles = normalizeProviderProfileSettings(rawProfiles);
        const nextApplicationSettings = normalizeApplicationSettings(
          rawApplicationSettings,
        );
        const nextJobs = normalizeJobStore(rawJobs);
        const nextActiveProject = nextProjects.projects.find(
          (project) => project.id === nextProjects.activeProjectId,
        );
        const preferredProfile =
          nextProfiles.profiles.find(
            (profile) =>
              profile.id === nextActiveProject?.defaultProviderProfileId,
          ) ?? nextProfiles.profiles[0];
        setProjects(nextProjects);
        setProviderProfiles(nextProfiles);
        setApplicationSettings(nextApplicationSettings);
        setJobs(nextJobs);
        setRepository(
          nextActiveProject?.workspacePath ?? nextActiveProject?.canonicalPath ?? "",
        );
        activateProviderProfile(preferredProfile, nextActiveProject?.defaultModel);
        if (!nextActiveProject) setView("projects");
        else setView("overview");
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setNotice({ tone: "error", message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (!disposed) setLoadingSettings(false);
      });

    return () => {
      disposed = true;
    };
  }, [activateProviderProfile]);

  useEffect(() => {
    let disposed = false;
    setLoadingRoots(true);

    void invoke<unknown>("load_skill_roots")
      .then(async (value) => {
        if (disposed) return;
        const roots = Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
        setSkillRoots(roots);
        if (roots.length > 0) {
          await scanRoots(roots);
        } else {
          setNotice({
            tone: "neutral",
            message: "Add a skill root to discover SKILL.md packages.",
          });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setNotice({ tone: "error", message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (!disposed) setLoadingRoots(false);
      });

    return () => {
      disposed = true;
    };
  }, [scanRoots]);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    void listen<AgentEvent>("agent-event", (event) => {
      if (disposed) return;
      const payload = event.payload;
      setRunId((currentRunId) => currentRunId ?? payload.runId);

      switch (payload.type) {
        case "text_delta":
          setOutput((current) => current + payload.text);
          break;
        case "status":
          addTimeline(payload.message, "neutral", payload.phase);
          break;
        case "tool_call":
          addTimeline(
            `Read-only tool: ${payload.name}`,
            "neutral",
            safeDetail(payload.input),
          );
          break;
        case "diagnostic":
          addTimeline(
            payload.message,
            payload.level === "error"
              ? "error"
              : payload.level === "warning"
                ? "warning"
                : "neutral",
          );
          break;
        case "result": {
          const structured = resultObject(payload.result);
          const metadata = payload.metadata ?? structured?.metadata;
          const artifacts =
            payload.artifacts ?? structured?.artifacts ?? metadata?.artifacts;
          setRunning(false);
          setOutput((current) => current || resultText(payload.result));
          setRunSummary({
            ...metadata,
            durationMs: payload.durationMs,
            turns: payload.turns,
            costUsd: payload.costUsd ?? metadata?.usage?.costUsd,
            artifacts,
          });
          addTimeline(
            payload.cancelled
              ? "Run cancelled"
              : payload.success
                ? "Run completed"
                : "Run failed",
            payload.cancelled
              ? "warning"
              : payload.success
                ? "success"
                : "error",
            payload.error ??
              [
                payload.turns !== undefined ? `${payload.turns} turns` : undefined,
                payload.durationMs !== undefined
                  ? `${Math.round(payload.durationMs / 100) / 10}s`
                  : undefined,
                payload.costUsd !== undefined
                  ? `$${payload.costUsd.toFixed(4)}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · "),
          );
          void refreshJobs().catch((error: unknown) => {
            addTimeline(
              "Could not refresh durable job history",
              "warning",
              errorMessage(error),
            );
          });
          break;
        }
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });

    void invoke<string | null>("agent_status")
      .then((activeRunId) => {
        if (activeRunId && !disposed) {
          setRunId(activeRunId);
          setRunning(true);
          addTimeline("Reattached to active run", "neutral", activeRunId);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          addTimeline("Could not restore agent status", "warning", errorMessage(error));
        }
      });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [addTimeline, refreshJobs]);

  useEffect(() => {
    if (!runId || activeJobId) return;
    const persistedJob = jobs.jobs.find((job) => job.activeRunId === runId);
    if (persistedJob) {
      setActiveJobId(persistedJob.id);
      setSelectedSkillId(persistedJob.skillId);
      setView("plan");
    }
  }, [activeJobId, jobs, runId]);

  const applyProjectSettings = useCallback(
    (nextProjects: ProjectSettings) => {
      setProjects(nextProjects);
      const nextActive = nextProjects.projects.find(
        (project) => project.id === nextProjects.activeProjectId,
      );
      const preferredProfile =
        providerProfiles.profiles.find(
          (profile) => profile.id === nextActive?.defaultProviderProfileId,
        ) ?? providerProfiles.profiles[0];
      setRepository(nextActive?.workspacePath ?? nextActive?.canonicalPath ?? "");
      activateProviderProfile(preferredProfile, nextActive?.defaultModel);
    },
    [activateProviderProfile, providerProfiles.profiles],
  );

  const addSavedProject = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Add a project to Pimp Code",
      });
      if (typeof selected !== "string") return;
      setSavingSettings(true);
      const value = await invoke<unknown>("add_saved_project", {
        path: selected,
      });
      const nextProjects = normalizeProjectSettings(value);
      applyProjectSettings(nextProjects);
      setActiveJobId("");
      setView("overview");
      setNotice({ tone: "success", message: "Project saved and selected." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingSettings(false);
    }
  };

  const selectSavedProject = async (projectId: string) => {
    if (!projectId || projectId === projects.activeProjectId) return;
    setSavingSettings(true);
    try {
      const value = await invoke<unknown>("select_saved_project", { projectId });
      applyProjectSettings(normalizeProjectSettings(value));
      setActiveJobId("");
      setView("overview");
      setNotice({ tone: "success", message: "Active project changed." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingSettings(false);
    }
  };

  const removeSavedProject = async (projectId: string) => {
    const project = projects.projects.find((item) => item.id === projectId);
    if (!project) return;
    if (
      !window.confirm(
        `Remove ${project.name} from the app? Repository files will not be deleted.`,
      )
    ) {
      return;
    }
    setSavingSettings(true);
    try {
      const value = await invoke<unknown>("remove_saved_project", { projectId });
      const nextProjects = normalizeProjectSettings(value);
      applyProjectSettings(nextProjects);
      if (nextProjects.projects.length === 0) setView("projects");
      setNotice({ tone: "success", message: "Project removed from the app." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingSettings(false);
    }
  };

  const saveProjectSettings = async (project: ProjectUpdateInput) => {
    setSavingSettings(true);
    try {
      const value = await invoke<unknown>("update_saved_project", { project });
      applyProjectSettings(normalizeProjectSettings(value));
      setNotice({ tone: "success", message: "Project settings saved." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingSettings(false);
    }
  };

  const relinkSavedProject = async (projectId: string) => {
    const project = projects.projects.find((item) => item.id === projectId);
    if (!project) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: `Relink ${project.name}`,
      });
      if (typeof selected !== "string") return;
      await saveProjectSettings({
        id: project.id,
        name: project.name,
        configuredPath: selected,
        defaultProviderProfileId: project.defaultProviderProfileId,
        defaultModel: project.defaultModel,
      });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const selectProviderProfile = (profileId: string) => {
    activateProviderProfile(
      providerProfiles.profiles.find((profile) => profile.id === profileId),
    );
  };

  const saveProviderProfile = async (profile: ProviderProfileInput) => {
    setSavingSettings(true);
    try {
      const value = await invoke<unknown>("save_provider_profile", { profile });
      const nextProfiles = normalizeProviderProfileSettings(value);
      setProviderProfiles(nextProfiles);
      const saved =
        nextProfiles.profiles.find((item) => item.id === profile.id) ??
        nextProfiles.profiles.find((item) =>
          item.name.localeCompare(profile.name, undefined, { sensitivity: "accent" }) === 0
        );
      activateProviderProfile(saved);
      setNotice({ tone: "success", message: "LLM profile saved." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingSettings(false);
    }
  };

  const deleteProviderProfile = async (profileId: string) => {
    const profile = providerProfiles.profiles.find((item) => item.id === profileId);
    if (!profile || !window.confirm(`Delete the ${profile.name} profile?`)) return;
    setSavingSettings(true);
    try {
      const value = await invoke<unknown>("delete_saved_provider_profile", {
        profileId,
      });
      const nextProfiles = normalizeProviderProfileSettings(value);
      setProviderProfiles(nextProfiles);
      activateProviderProfile(nextProfiles.profiles[0]);
      setNotice({ tone: "success", message: "LLM profile deleted." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingSettings(false);
    }
  };

  const startSkillJob = async (skill: SkillCatalogEntry) => {
    if (!activeProject || !isRunnableSkill(skill) || !skill.name) return;
    setCreatingJob(true);
    try {
      const value = await invoke<unknown>("create_durable_job", {
        request: {
          projectId: activeProject.id,
          projectName: activeProject.name,
          canonicalRepository:
            activeProject.workspacePath ?? activeProject.canonicalPath,
          skillId: skill.id,
          skillName: skill.name,
          skillDigest: skill.digest,
          skillRoot: skill.rootPath,
          provider: providerSnapshot(
            selectedProviderProfile,
            selectedProviderProfile?.defaultModel ?? "",
          ),
          runMode: "plan",
          approvalMode: "guided",
          maxTurns: DEFAULT_MAX_TURNS,
        },
      });
      const job = normalizeJobRecord(value);
      applyJobRecord(job);
      setActiveJobId(job.id);
      setSelectedSkillId(job.skillId);
      setMaxTurns(job.maxTurns);
      setOutput("");
      setTimeline([]);
      setRunSummary(undefined);
      setRunId(undefined);
      invalidatePreflight();
      if (job.provider) {
        const profile = providerProfiles.profiles.find(
          (item) => item.id === job.provider?.profileId,
        );
        activateProviderProfile(profile);
        setModel(job.provider.model);
      }
      setView("plan");
      setNotice({
        tone: "success",
        message: "Durable draft created. Setup is saved in job history.",
      });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setCreatingJob(false);
    }
  };

  const openDurableJob = async (jobId: string) => {
    let job = jobs.jobs.find((item) => item.id === jobId);
    if (!job || (!matchesEditableJob(job) && job.status !== "interrupted")) return;
    if (running && job.id !== activeJobId) {
      setNotice({
        tone: "warning",
        message: "Finish or cancel the active job before resuming another draft.",
      });
      return;
    }
    const savedSkillId = job.skillId;
    const savedSkillDigest = job.skillDigest;
    if (job.projectId !== projects.activeProjectId) {
      await selectSavedProject(job.projectId);
    }
    const currentSkill = catalog?.entries.find(
      (skill) => skill.id === savedSkillId && skill.digest === savedSkillDigest,
    );
    if (!currentSkill) {
      setNotice({
        tone: "error",
        message:
          "The exact skill version for this draft is no longer in the catalog. Refresh or clone the original skill source before resuming.",
      });
      return;
    }
    if (job.status === "interrupted") {
      try {
        const value = await invoke<unknown>("resume_interrupted_job", { jobId });
        job = normalizeJobRecord(value);
        applyJobRecord(job);
        setNotice({
          tone: "success",
          message: "Interrupted attempt preserved. Setup restarted with a fresh preflight.",
        });
      } catch (error) {
        setNotice({ tone: "error", message: errorMessage(error) });
        return;
      }
    }
    setActiveJobId(job.id);
    setSelectedSkillId(job.skillId);
    setRepository(job.canonicalRepository);
    setMaxTurns(job.maxTurns);
    setOutput("");
    setTimeline([]);
    setRunSummary(undefined);
    setRunId(job.activeRunId);
    invalidatePreflight();
    if (job.provider) {
      const profile = providerProfiles.profiles.find(
        (item) =>
          item.id === job.provider?.profileId &&
          item.revision === job.provider.profileRevision,
      );
      activateProviderProfile(profile);
      setModel(job.provider.model);
    }
    setView("plan");
  };

  const selectHistoryJob = async (jobId: string) => {
    setSelectedHistoryJobId(jobId);
    setHistoryResult("");
    setLoadingHistoryResult(true);
    try {
      const value = await invoke<unknown>("read_job_result", { jobId });
      setHistoryResult(storedJobResultText(value));
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setLoadingHistoryResult(false);
    }
  };

  const saveGlobalSettings = async (settings: ApplicationSettings) => {
    if (
      settings.jobRetention.enabled &&
      !window.confirm(
        "Save and apply this retention policy now? Eligible terminal history may be permanently removed. Drafts, resumable jobs, active work, and immutable plan artifacts will be preserved.",
      )
    ) {
      return;
    }
    setSavingSettings(true);
    try {
      const value = await invoke<unknown>("save_application_settings", { settings });
      const nextSettings = normalizeApplicationSettings(value);
      const jobsValue = await invoke<unknown>("list_jobs");
      const nextJobs = normalizeJobStore(jobsValue);
      const removedCount = Math.max(0, jobs.jobs.length - nextJobs.jobs.length);
      setApplicationSettings(nextSettings);
      setJobs(nextJobs);
      setNotice({
        tone: "success",
        message:
          removedCount > 0
            ? `Retention settings saved; ${removedCount} terminal histor${removedCount === 1 ? "y entry" : "y entries"} removed.`
            : "Retention settings saved.",
      });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingSettings(false);
    }
  };

  const saveProviderCredential = (profileId: string, secret: string) => {
    setSavingSettings(true);
    void invoke<unknown>("save_provider_credential", {
      profileId,
      secret,
    })
      .then(async (value) => {
        const nextProfiles = normalizeProviderProfileSettings(value);
        setProviderProfiles(nextProfiles);
        activateProviderProfile(
          nextProfiles.profiles.find((profile) => profile.id === profileId),
        );
        await refreshProviderCredentialStatus(profileId);
        setNotice({
          tone: "success",
          message: "Credential saved in Windows Credential Manager.",
        });
      })
      .catch((error: unknown) => {
        setNotice({ tone: "error", message: errorMessage(error) });
      })
      .finally(() => {
        setSavingSettings(false);
      });
  };

  const deleteProviderCredential = async (profileId: string) => {
    if (!window.confirm("Remove this profile credential?")) return;
    setSavingSettings(true);
    try {
      const value = await invoke<unknown>("delete_provider_credential", {
        profileId,
      });
      const nextProfiles = normalizeProviderProfileSettings(value);
      setProviderProfiles(nextProfiles);
      activateProviderProfile(
        nextProfiles.profiles.find((profile) => profile.id === profileId),
      );
      await refreshProviderCredentialStatus(profileId);
      setNotice({ tone: "success", message: "Profile credential removed." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setSavingSettings(false);
    }
  };

  const deleteSavedJob = async (jobId: string) => {
    const job = jobs.jobs.find((item) => item.id === jobId);
    if (
      !job ||
      !window.confirm(
        `Delete the ${job.skillName} history entry? Saved plan artifacts outside job history will remain on disk.`,
      )
    ) {
      return;
    }
    try {
      const value = await invoke<unknown>("delete_saved_job", { jobId });
      setJobs(normalizeJobStore(value));
      if (selectedHistoryJobId === jobId) {
        setSelectedHistoryJobId("");
        setHistoryResult("");
      }
      if (activeJobId === jobId) setActiveJobId("");
      setNotice({ tone: "success", message: "Job history deleted." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const saveActiveJobSetup = async (): Promise<JobRecord> => {
    if (!activeJob) throw new Error("Start or resume a durable job first.");
    const snapshot = providerSnapshot();
    if (!snapshot) throw new Error("Choose a saved LLM profile first.");
    const value = await invoke<unknown>("update_durable_job_setup", {
      request: {
        jobId: activeJob.id,
        provider: snapshot,
        runMode: "plan",
        approvalMode: "guided",
        maxTurns: effectiveMaxTurns,
      },
    });
    const job = normalizeJobRecord(value);
    applyJobRecord(job);
    return job;
  };

  useEffect(() => {
    if (
      !activeJob ||
      !matchesEditableJob(activeJob) ||
      !selectedProviderProfile ||
      !model.trim() ||
      running
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const snapshot = providerSnapshot();
      if (!snapshot) return;
      if (jobSetupMatches(activeJob, snapshot, effectiveMaxTurns)) return;
      void invoke<unknown>("update_durable_job_setup", {
        request: {
          jobId: activeJob.id,
          provider: snapshot,
          runMode: "plan",
          approvalMode: "guided",
          maxTurns: effectiveMaxTurns,
        },
      })
        .then((value) => applyJobRecord(normalizeJobRecord(value)))
        .catch((error: unknown) => {
          setNotice({
            tone: "warning",
            message: `Could not autosave job setup: ${errorMessage(error)}`,
          });
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    activeJob?.id,
    activeJob?.status,
    applyJobRecord,
    effectiveMaxTurns,
    model,
    providerSnapshot,
    running,
    selectedProviderProfile,
  ]);

  const chooseSkillRoot = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Add a root containing skill packages",
      });
      if (typeof selected !== "string") return;
      setSkillRoots((roots) =>
        roots.some(
          (root) => root.toLocaleLowerCase() === selected.toLocaleLowerCase(),
        )
          ? roots
          : [...roots, selected],
      );
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const updateSkillRoot = (index: number, value: string) => {
    setSkillRoots((roots) =>
      roots.map((root, rootIndex) => (rootIndex === index ? value : root)),
    );
  };

  const removeSkillRoot = (index: number) => {
    setSkillRoots((roots) => roots.filter((_, rootIndex) => rootIndex !== index));
  };

  const saveAndScanRoots = async () => {
    const seen = new Set<string>();
    const roots = skillRoots
      .map((root) => root.trim())
      .filter((root) => {
        const key = root.toLocaleLowerCase();
        if (!root || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    setScanningCatalog(true);
    try {
      const value = await invoke<unknown>("save_skill_roots", { roots });
      const savedRoots = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : roots;
      setSkillRoots(savedRoots);
      await scanRoots(savedRoots, "Skill roots saved and catalog refreshed.");
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setScanningCatalog(false);
    }
  };

  const selectSkill = (entry: SkillCatalogEntry) => {
    setSelectedSkillId(entry.id);
    invalidatePreflight();
  };

  const checkProvider = async () => {
    if (!canCheckProvider) return;
    setCheckingProvider(true);
    setProviderHealth(undefined);
    invalidatePreflight();
    const revision = providerHealthRevision.current + 1;
    providerHealthRevision.current = revision;
    try {
      const rawHealth = await invoke<unknown>("provider_health", {
        profileId: selectedProviderProfile?.id,
        provider,
      });
      if (revision !== providerHealthRevision.current) return;
      const health = normalizeProviderHealth(rawHealth);
      setProviderHealth(health);
      if (!model.trim() && health.models[0]) setModel(health.models[0].id);
      setNotice({
        tone: health.healthy ? "success" : "error",
        message:
          health.message ||
          (health.healthy
            ? "Provider is ready."
            : "Provider health check failed."),
      });
    } catch (error) {
      if (revision === providerHealthRevision.current) {
        setNotice({ tone: "error", message: errorMessage(error) });
      }
    } finally {
      setCheckingProvider(false);
    }
  };

  const preparePlan = async () => {
    if (!canPrepare || !selectedSkill || !activeJob) return;
    setPreparing(true);
    setNotice(undefined);
    invalidatePreflight();
    const revision = preflightRevision.current;
    try {
      const persistedJob = await saveActiveJobSetup();
      const rawPreflight = await invoke<unknown>("prepare_plan", {
        repository: repository.trim(),
        skillId: selectedSkill.id,
        skillRoot: selectedSkill.rootPath,
        jobId: persistedJob.id,
      });
      if (revision !== preflightRevision.current) return;
      const nextPreflight = normalizePreflight(rawPreflight);
      assertPreparedPreflightMatchesSkill(nextPreflight, selectedSkill);
      setPreflight(nextPreflight);
      await refreshJobs();
      setNotice({
        tone:
          nextPreflight.applicability.verdict === "applicable"
            ? "success"
            : "warning",
        message:
          nextPreflight.applicability.verdict === "applicable"
            ? "Read-only context is ready for review."
            : "The selected skill is not yet approved for this repository.",
      });
    } catch (error) {
      if (revision === preflightRevision.current) {
        setNotice({ tone: "error", message: errorMessage(error) });
      }
    } finally {
      setPreparing(false);
    }
  };

  const startPlan = async () => {
    if (!canStart || !preflight || !activeJob) return;
    setOutput("");
    setTimeline([]);
    sequence.current = 0;
    setRunSummary(undefined);
    setRunId(undefined);
    setRunning(true);
    setNotice(undefined);
    addTimeline(
      "Submitting plan-only run",
      "neutral",
      `${effectiveMaxTurns}-turn limit · ${preflight.contextManifest.files.length} approved files`,
    );

    try {
      const response = await invoke<StartPlanResponse>("start_plan", {
        request: {
          jobId: activeJob.id,
          preflightId: preflight.id,
          provider,
          maxTurns: effectiveMaxTurns,
          remoteEgressApproved:
            providerKind !== "local" ? remoteEgressApproved : false,
        },
      });
      setRunId(response.runId);
      await refreshJobs();
    } catch (error) {
      setRunning(false);
      addTimeline("Plan could not start", "error", errorMessage(error));
      void refreshJobs();
    }
  };

  const cancelRun = async () => {
    if (!runId || !running) return;
    try {
      await invoke("cancel_agent", { runId });
      addTimeline("Cancellation sent", "warning");
    } catch (error) {
      addTimeline("Cancellation failed", "error", errorMessage(error));
    }
  };

  return (
    <AppShell
      view={view}
      projects={projects}
      activeProject={activeProject}
      activeProfile={selectedProviderProfile}
      activeJob={activeJob}
      running={running}
      onNavigate={setView}
      onSelectProject={selectSavedProject}
    >
      {view !== "plan" && notice ? (
        <div
          className={`app-notice management-notice ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span aria-hidden="true" />
          {notice.message}
        </div>
      ) : null}
      {view === "overview" && activeProject ? (
        <OverviewPage
          project={activeProject}
          profile={selectedProviderProfile}
          catalog={catalog}
          jobs={jobs.jobs}
          activeJob={activeJob}
          onNavigate={setView}
        />
      ) : view === "skills" ? (
        <SkillsPage
          projectName={activeProject?.name ?? "No active project"}
          catalog={catalog}
          skillRoots={skillRoots}
          loading={loadingRoots || scanningCatalog}
          starting={creatingJob || running}
          onRefresh={() => void scanRoots(skillRoots, "Project skill catalog refreshed.")}
          onStartJob={startSkillJob}
          onBrowseRoot={() => void chooseSkillRoot()}
          onAddRoot={() => setSkillRoots((roots) => [...roots, ""])}
          onUpdateRoot={updateSkillRoot}
          onRemoveRoot={removeSkillRoot}
          onSaveRoots={() => void saveAndScanRoots()}
        />
      ) : view === "jobs" ? (
        <JobsPage
          jobs={jobs.jobs}
          activeProjectId={activeProject?.id ?? ""}
          selectedJobId={selectedHistoryJobId}
          resultText={historyResult}
          loadingResult={loadingHistoryResult}
          onSelectJob={(jobId) => void selectHistoryJob(jobId)}
          onOpenJob={(jobId) => void openDurableJob(jobId)}
          onDeleteJob={(jobId) => void deleteSavedJob(jobId)}
        />
      ) : view === "settings" ? (
        <SettingsPage
          skillRoots={skillRoots}
          applicationSettings={applicationSettings}
          providerCount={providerProfiles.profiles.length}
          projectCount={projects.projects.length}
          jobCount={jobs.jobs.length}
          loading={loadingRoots || scanningCatalog || savingSettings}
          onBrowseRoot={() => void chooseSkillRoot()}
          onAddRoot={() => setSkillRoots((roots) => [...roots, ""])}
          onUpdateRoot={updateSkillRoot}
          onRemoveRoot={removeSkillRoot}
          onSaveRoots={() => void saveAndScanRoots()}
          onSaveApplicationSettings={(settings) => void saveGlobalSettings(settings)}
          onNavigate={setView}
        />
      ) : view === "projects" ? (
        <ProjectsPage
          settings={projects}
          profiles={providerProfiles.profiles}
          busy={loadingSettings || savingSettings || running}
          onAdd={addSavedProject}
          onSelect={selectSavedProject}
          onSave={(project) => void saveProjectSettings(project)}
          onRelink={(projectId) => void relinkSavedProject(projectId)}
          onRemove={removeSavedProject}
          onOpenPlan={() => setView("overview")}
        />
      ) : view === "providers" ? (
        <ProviderProfilesPage
          profiles={providerProfiles.profiles}
          selectedProfileId={selectedProviderProfileId}
          credentialStatus={providerCredentialStatus}
          busy={loadingSettings || savingSettings}
          onSelect={selectProviderProfile}
          onSave={saveProviderProfile}
          onDelete={deleteProviderProfile}
          onSaveCredential={saveProviderCredential}
          onDeleteCredential={deleteProviderCredential}
        />
      ) : (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">
            Durable job {activeJob ? `· ${activeJob.id.slice(0, 12)}` : ""}
          </p>
          <h1>{activeJob?.skillName ?? "Plan a safe codebase migration"}</h1>
          <p className="subtitle">
            Review the saved project, immutable skill package, execution mode and LLM
            profile before preparing exact context.
          </p>
        </div>
        <span className={`status-pill ${running ? "active" : ""}`}>
          <span className="status-dot" aria-hidden="true" />
          {running ? "Planning" : preparing ? "Preparing" : "Plan-only"}
        </span>
      </header>

      <ol className="step-strip" aria-label="Plan setup progress">
        <li className={repository.trim() ? "complete" : "current"}>
          <span>1</span>Repository
        </li>
        <li
          className={
            selectedSkill
              ? "complete"
              : repository.trim()
                ? "current"
                : ""
          }
        >
          <span>2</span>Skill
        </li>
        <li
          className={
            providerReady
              ? "complete"
              : selectedSkill
                ? "current"
                : ""
          }
        >
          <span>3</span>Provider
        </li>
        <li
          className={
            preflight && canonicalConfirmed
              ? "complete"
              : providerReady
                ? "current"
                : ""
          }
        >
          <span>4</span>Review &amp; start
        </li>
      </ol>

      {notice ? (
        <div
          className={`app-notice ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span aria-hidden="true" />
          {notice.message}
        </div>
      ) : null}

      <div className="workspace">
        <aside className="setup-panel" aria-label="Plan setup">
          <section className="flow-section" aria-labelledby="repository-heading">
            <div className="section-heading">
              <span>01</span>
              <div>
                <h2 id="repository-heading">Repository</h2>
                <p>The active saved project defines the exact read boundary.</p>
              </div>
            </div>
            <div className="selected-project-card">
              <div>
                <strong>{activeProject?.name ?? "No project selected"}</strong>
                <code>{repository || "Add a project from the project library."}</code>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => setView("projects")}
              >
                Manage
              </button>
            </div>
          </section>

          <section className="flow-section job-skill-lock" aria-labelledby="skill-heading">
            <div className="section-heading heading-with-action">
              <span>02</span>
              <div>
                <h2 id="skill-heading">Selected skill</h2>
                <p>
                  This job is pinned to the exact package digest shown below.
                </p>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={saveAndScanRoots}
                disabled={scanningCatalog || skillRoots.length === 0}
              >
                {scanningCatalog ? "Saving & scanning…" : "Save & rescan"}
              </button>
            </div>

            <details className="root-manager">
              <summary>
                Skill roots <span>{skillRoots.length}</span>
              </summary>
              <div className="root-list">
                {skillRoots.length === 0 ? (
                  <p className="empty-copy">No roots configured.</p>
                ) : (
                  skillRoots.map((root, index) => (
                    <div className="root-row" key={index}>
                      <label className="sr-only" htmlFor={`skill-root-${index}`}>
                        Skill root {index + 1}
                      </label>
                      <input
                        id={`skill-root-${index}`}
                        value={root}
                        onChange={(event) => updateSkillRoot(index, event.target.value)}
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => removeSkillRoot(index)}
                        aria-label={`Remove skill root ${root || index + 1}`}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="root-actions">
                <button type="button" className="secondary" onClick={chooseSkillRoot}>
                  Browse root
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setSkillRoots((roots) => [...roots, ""])}
                >
                  Enter path
                </button>
                <button
                  type="button"
                  className="secondary emphasize"
                  onClick={saveAndScanRoots}
                  disabled={scanningCatalog || loadingRoots}
                >
                  Save &amp; scan
                </button>
              </div>
            </details>

            {loadingRoots ? (
              <div className="catalog-empty">Loading configured roots…</div>
            ) : catalog && catalog.entries.length > 0 ? (
              <fieldset className="catalog-picker">
                <legend className="sr-only">Choose a skill package</legend>
                {catalog.entries.map((entry) => {
                  const runnable = isRunnableSkill(entry);
                  return (
                    <label
                      className={`skill-card ${selectedSkillId === entry.id ? "selected" : ""} ${!runnable ? "unavailable" : ""}`}
                      key={entry.id}
                    >
                      <input
                        type="radio"
                        name="skill"
                        value={entry.id}
                        checked={selectedSkillId === entry.id}
                        disabled={!runnable || Boolean(activeJob)}
                        onChange={() => selectSkill(entry)}
                      />
                      <span className="skill-card-body">
                        <span className="skill-title-row">
                          <strong>{catalogEntryName(entry)}</strong>
                          <span className="skill-badges">
                            <span className={`catalog-status ${entry.status}`}>
                              {entry.status}
                            </span>
                            {entry.status === "valid" ? (
                              <span
                                className={`catalog-certification ${
                                  entry.planningSupported ? "certified" : "uncertified"
                                }`}
                              >
                                {entry.planningSupported
                                  ? "Certified · plan-only"
                                  : "Catalog valid · not certified"}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <small>
                          {entry.description ??
                            entry.issues[0]?.message ??
                            "No package description available."}
                        </small>
                        <span className="skill-meta">
                          <code title={entry.digest}>{shortDigest(entry.digest)}</code>
                          <span>
                            {entry.fileCount} files · {formatBytes(entry.totalBytes)}
                          </span>
                          {!runnable &&
                          entry.planningSupported &&
                          entry.status === "valid" ? (
                            <span>Planning package metadata incomplete</span>
                          ) : null}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ) : (
              <div className="catalog-empty">
                {scanningCatalog
                  ? "Scanning SKILL.md packages…"
                  : "No skill packages discovered in the configured roots."}
              </div>
            )}

            {catalog ? (
              <div className="catalog-footnote">
                <span>Scanned {displayTimestamp(catalog.scannedAt)}</span>
                <span>{catalog.entries.length} packages</span>
              </div>
            ) : null}

            {catalog && catalogProblemCount > 0 ? (
              <details className="diagnostics" open>
                <summary>
                  Catalog diagnostics <span>{catalogProblemCount}</span>
                </summary>
                <div className="diagnostic-groups">
                  {catalog.entries
                    .filter((entry) => entry.status !== "valid")
                    .map((entry) => (
                      <div className="diagnostic-group" key={`bad-${entry.id}`}>
                        <strong>
                          {catalogEntryName(entry)} · {entry.status}
                        </strong>
                        <code>{entry.manifestPath || entry.packageRoot}</code>
                        {entry.issues.map((issue, index) => (
                          <p key={`${entry.id}-issue-${index}`}>{issueText(issue)}</p>
                        ))}
                      </div>
                    ))}
                  {catalog.issues.map((issue, index) => (
                    <div className="diagnostic-group" key={`global-${index}`}>
                      <strong>{issue.severity} catalog issue</strong>
                      <p>{issueText(issue)}</p>
                    </div>
                  ))}
                  {catalog.orphanedMetadata.map((orphan, index) => (
                    <div className="diagnostic-group" key={`orphan-${index}`}>
                      <strong>Orphaned metadata</strong>
                      <code>{orphan.path}</code>
                      <p>{orphan.message}</p>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </section>

          <section className="flow-section" aria-labelledby="provider-heading">
            <div className="section-heading">
              <span>03</span>
              <div>
                <h2 id="provider-heading">Mode, provider &amp; limits</h2>
                <p>Choose how the saved job should progress, then select its LLM profile.</p>
              </div>
            </div>

            <fieldset className="execution-mode-picker">
              <legend>Execution mode</legend>
              <label className="selected">
                <input type="radio" name="execution-mode" checked readOnly />
                <span>
                  <strong>Plan only</strong>
                  <small>Inspect, generate and save a plan. No project changes.</small>
                </span>
                <i>Available</i>
              </label>
              <label className="disabled" aria-disabled="true">
                <input type="radio" name="execution-mode" disabled />
                <span>
                  <strong>Guided job</strong>
                  <small>Approve the persisted plan before guarded execution.</small>
                </span>
                <i>Not certified</i>
              </label>
              <label className="disabled" aria-disabled="true">
                <input type="radio" name="execution-mode" disabled />
                <span>
                  <strong>Continuous job</strong>
                  <small>Continue inside the approved capability envelope.</small>
                </span>
                <i>Not certified</i>
              </label>
            </fieldset>

            <div className="profile-picker-row">
              <label className="field" htmlFor="provider-profile">
                <span>Saved LLM profile</span>
                <select
                  id="provider-profile"
                  value={selectedProviderProfileId}
                  onChange={(event) => selectProviderProfile(event.target.value)}
                >
                  {providerProfiles.profiles.length === 0 ? (
                    <option value="">No profiles configured</option>
                  ) : null}
                  {providerProfiles.profiles.map((profile) => (
                    <option value={profile.id} key={profile.id}>
                      {profile.name} · {profile.defaultModel}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() => setView("providers")}
              >
                Manage profiles
              </button>
            </div>

            {selectedProviderProfile ? (
              <div className="inline-note profile-summary">
                <strong>
                  {selectedProviderProfile.kind === "claude"
                    ? "Claude profile"
                    : selectedProviderProfile.kind === "codex"
                      ? "Codex SDK profile"
                    : "Local compatibility profile"}
                </strong>
                {selectedProviderProfile.endpoint ? (
                  <code>{selectedProviderProfile.endpoint}</code>
                ) : (
                  <span>Credentials remain in the trusted host environment.</span>
                )}
              </div>
            ) : (
              <div className="inline-note">
                Create a saved LLM profile before preparing this job.
              </div>
            )}

            <div className="field-grid">
              <label className="field" htmlFor="provider-model">
                <span>Model ID</span>
                <input
                  id="provider-model"
                  list="provider-models"
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    invalidateProviderHealth();
                    invalidatePreflight();
                  }}
                  placeholder={
                    providerKind === "claude"
                      ? "sonnet"
                      : providerKind === "codex"
                        ? "gpt-5.6-terra"
                        : "Run health check"
                  }
                  spellCheck={false}
                />
                <datalist id="provider-models">
                  {providerHealth?.models.map((availableModel) => (
                    <option value={availableModel.id} key={availableModel.id}>
                      {availableModel.label}
                    </option>
                  ))}
                </datalist>
              </label>
              <label className="field" htmlFor="max-turns">
                <span>Maximum turns</span>
                <input
                  id="max-turns"
                  type="number"
                  min={MIN_MAX_TURNS}
                  max={MAX_MAX_TURNS}
                  step={1}
                  value={effectiveMaxTurns}
                  disabled={providerKind === "codex"}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setMaxTurns(
                      Number.isFinite(value)
                        ? Math.min(
                            MAX_MAX_TURNS,
                            Math.max(MIN_MAX_TURNS, Math.trunc(value)),
                          )
                        : DEFAULT_MAX_TURNS,
                    );
                    invalidatePreflight();
                  }}
                />
                {providerKind === "codex" ? (
                  <small>Codex SDK completes each plan job as one SDK turn.</small>
                ) : null}
              </label>
            </div>

            <div className="health-row">
              <button
                type="button"
                className="secondary"
                onClick={checkProvider}
                disabled={!canCheckProvider}
              >
                {checkingProvider ? "Checking…" : "Check provider"}
              </button>
              {providerHealth ? (
                <span
                  className={`health-status ${
                    providerHealth.status === "degraded"
                      ? "degraded"
                      : providerHealth.healthy
                        ? "healthy"
                        : "unhealthy"
                  }`}
                >
                  <span aria-hidden="true" />
                  {providerHealth.status}
                  {providerHealth.models.length > 0
                    ? providerHealth.discovery === "static-aliases"
                      ? ` · ${providerHealth.models.length} static aliases`
                      : providerHealth.discovery === "provider"
                        ? ` · ${providerHealth.models.length} provider models`
                        : ` · ${providerHealth.models.length} model options`
                    : ""}
                </span>
              ) : (
                <span className="health-status unchecked">Not checked</span>
              )}
            </div>

            <button
              type="button"
              className="primary prepare-button"
              onClick={preparePlan}
              disabled={!canPrepare}
            >
              {preparing ? "Inspecting repository…" : "Prepare read-only preview"}
            </button>
            {!providerHealth?.healthy ? (
              <p className="button-help">A successful provider health check is required.</p>
            ) : providerHealth.status !== "ready" ? (
              <p className="button-help">
                The provider reported {providerHealth.status}; resolve its health
                diagnostic before preparing context.
              </p>
            ) : !model.trim() ? (
              <p className="button-help">Choose a discovered model or enter its exact ID.</p>
            ) : providerKind === "local" && !selectedLocalModelIsAvailable ? (
              <p className="button-help">
                Choose a model returned by the local provider health check.
              </p>
            ) : null}
          </section>
        </aside>

        <section className="review-panel" aria-labelledby="review-heading">
          <div className="review-header">
            <div>
              <p className="eyebrow">Preflight approval</p>
              <h2 id="review-heading">Exact read boundary</h2>
            </div>
            {preflight ? <code>{shortDigest(preflight.contextManifest.hash)}</code> : null}
          </div>

          {!preflight ? (
            <div className="preflight-empty">
              {running && runId ? (
                <>
                  <span className="empty-icon" aria-hidden="true">↻</span>
                  <h3>Active run reattached</h3>
                  <p>
                    The host reports run <code>{runId}</code> is still active. Its
                    preflight state is not available in this renderer session, but
                    cancellation remains available.
                  </p>
                  <button type="button" className="danger" onClick={cancelRun}>
                    Cancel active run
                  </button>
                </>
              ) : (
                <>
                  <span className="empty-icon" aria-hidden="true">⌁</span>
                  <h3>Nothing leaves the setup panel yet</h3>
                  <p>
                    Select the repository, runnable skill, and healthy provider. The
                    preflight will resolve the canonical path, test applicability, and
                    enumerate every file that may be read.
                  </p>
                  <ul>
                    <li>No target writes</li>
                    <li>No project commands</li>
                    <li>Artifacts stored outside the repository</li>
                  </ul>
                </>
              )}
            </div>
          ) : (
            <div className="preflight-content">
              <section className="review-block" aria-labelledby="canonical-heading">
                <div className="review-block-heading">
                  <h3 id="canonical-heading">Canonical repository</h3>
                  <span>engine resolved</span>
                </div>
                <code className="path-box">{preflight.canonicalRepository}</code>
                {repository.trim() !== preflight.canonicalRepository ? (
                  <p className="path-note">
                    Entered path: <code>{repository.trim()}</code>
                  </p>
                ) : null}
                <label className="approval-check">
                  <input
                    type="checkbox"
                    checked={canonicalConfirmed}
                    onChange={(event) => setCanonicalConfirmed(event.target.checked)}
                  />
                  <span>
                    <strong>I confirm this exact repository</strong>
                    <small>All context must remain inside this canonical root.</small>
                  </span>
                </label>
              </section>

              <section className="review-block" aria-labelledby="applicability-heading">
                <div className="review-block-heading">
                  <h3 id="applicability-heading">Skill applicability</h3>
                  <span className={`verdict ${preflight.applicability.verdict}`}>
                    {preflight.applicability.verdict.replace("_", " ")}
                  </span>
                </div>
                <p className="review-summary">{preflight.applicability.summary}</p>
                {preflight.applicability.evidence.length > 0 ? (
                  <ul className="evidence-list">
                    {preflight.applicability.evidence.map((evidence, index) => (
                      <li key={`evidence-${index}`}>{noteText(evidence)}</li>
                    ))}
                  </ul>
                ) : null}
                <dl className="skill-proof">
                  <div>
                    <dt>Skill</dt>
                    <dd>{preflight.skill.name}</dd>
                  </div>
                  <div>
                    <dt>Package hash</dt>
                    <dd><code>{preflight.skill.digest || "not available"}</code></dd>
                  </div>
                </dl>
              </section>

              {preflight.warnings.length > 0 ? (
                <section className="warning-stack" aria-label="Preflight warnings">
                  {preflight.warnings.map((warning, index) => (
                    <p key={`warning-${index}`}>{noteText(warning)}</p>
                  ))}
                </section>
              ) : null}

              <section className="review-block context-block" aria-labelledby="context-heading">
                <div className="review-block-heading">
                  <h3 id="context-heading">Files approved for reading</h3>
                  <span>
                    {preflight.contextManifest.files.length} files ·{" "}
                    {formatBytes(preflight.contextManifest.totalBytes)}
                  </span>
                </div>
                {preflight.contextManifest.files.length > 0 ? (
                  <div className="context-table-wrap">
                    <table className="context-table">
                      <caption className="sr-only">
                        Exact files included in the plan context
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">File</th>
                          <th scope="col">Why</th>
                          <th scope="col">Size</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preflight.contextManifest.files.map((file) => (
                          <tr key={`${file.path}-${file.digest}`}>
                            <td>
                              <code>{file.path}</code>
                              {file.redactions.length > 0 ? (
                                <small>{file.redactions.length} redactions</small>
                              ) : null}
                            </td>
                            <td>{file.reason}</td>
                            <td>{formatBytes(file.size)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="context-empty">
                    No files were selected. A plan cannot start with an empty context.
                  </div>
                )}
              </section>

              {needsRemoteApproval ? (
                <section className="egress-card" aria-labelledby="egress-heading">
                  <div>
                    <p className="eyebrow">Remote egress</p>
                    <h3 id="egress-heading">
                      Approval required for {providerKind === "codex" ? "Codex" : "Claude"}
                    </h3>
                    <p>
                      Destination: {providerKind === "codex"
                        ? "OpenAI / Codex"
                        : "Anthropic / Claude"}.
                      Only the files listed above and the immutable skill snapshot may
                      leave this machine.
                    </p>
                  </div>
                  <label className="approval-check strong">
                    <input
                      type="checkbox"
                      checked={remoteEgressApproved}
                      onChange={(event) =>
                        setRemoteEgressApproved(event.target.checked)
                      }
                    />
                    <span>
                      <strong>I approve this remote context for this run</strong>
                      <small>
                        Context hash {shortDigest(
                          preflight.remoteEgress.contextHash ||
                            preflight.contextManifest.hash,
                        )}
                      </small>
                    </span>
                  </label>
                </section>
              ) : (
                <div className="local-egress-note">
                  Local bridge target: <code>{endpoint}</code>. Remote-egress approval
                  is not requested for this provider.
                </div>
              )}

              <div className="run-actions">
                <button
                  type="button"
                  className="primary start-button"
                  disabled={!canStart}
                  onClick={startPlan}
                >
                  {running ? "Plan running…" : "Start plan-only run"}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={!running || !runId}
                  onClick={cancelRun}
                >
                  Cancel
                </button>
              </div>
              <p className="safety-line">
                Read files only · no writes · no repository commands · {effectiveMaxTurns}-turn cap
              </p>
            </div>
          )}

          <section className="run-output" aria-labelledby="output-heading">
            <div className="output-header">
              <div>
                <p className="eyebrow">Structured artifact</p>
                <h2 id="output-heading">Structured plan</h2>
              </div>
              {runId ? <code className="run-id">{runId.slice(0, 12)}</code> : null}
            </div>
            {output ? <MarkdownChecklist markdown={output} /> : null}
            <article
              className={`output ${output ? "has-output" : ""}`}
              aria-live="polite"
            >
              {output || "The validated Markdown plan will appear here when the run completes."}
            </article>

            <div className="timeline-header">
              <h3>Run timeline</h3>
              <span>{timeline.length} events</span>
            </div>
            <ol className="timeline" aria-live="polite">
              {timeline.length === 0 ? (
                <li className="empty">No run events yet.</li>
              ) : (
                timeline.map((item) => (
                  <li key={item.id} className={item.tone}>
                    <span className="timeline-marker" aria-hidden="true" />
                    <div>
                      <strong>{item.label}</strong>
                      {item.detail ? <small>{item.detail}</small> : null}
                    </div>
                  </li>
                ))
              )}
            </ol>

            {(runId || runSummary) && preflight ? (
              <section className="run-metadata" aria-labelledby="metadata-heading">
                <div className="timeline-header">
                  <h3 id="metadata-heading">Run metadata</h3>
                  <span>{running ? "in progress" : "final"}</span>
                </div>
                <dl>
                  <div>
                    <dt>Provider / model</dt>
                    <dd>
                      {runSummary?.provider ?? providerKind} /{" "}
                      {runSummary?.model ?? model}
                    </dd>
                  </div>
                  <div>
                    <dt>Skill hash</dt>
                    <dd><code>{runSummary?.skillDigest ?? preflight.skill.digest}</code></dd>
                  </div>
                  <div>
                    <dt>Context</dt>
                    <dd>
                      {runSummary?.filesInspected?.length ??
                        preflight.contextManifest.files.length} files ·{" "}
                      <code>{runSummary?.contextHash ?? preflight.contextManifest.hash}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Turns / duration</dt>
                    <dd>
                      {runSummary?.turns ?? "—"} /{" "}
                      {runSummary?.durationMs !== undefined
                        ? `${Math.round(runSummary.durationMs / 100) / 10}s`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Usage / cost</dt>
                    <dd>
                      {runSummary?.usage?.totalTokens !== undefined
                        ? `${runSummary.usage.totalTokens.toLocaleString()} tokens`
                        : "usage unavailable"}
                      {runSummary?.costUsd !== undefined
                        ? ` · $${runSummary.costUsd.toFixed(4)}`
                        : ""}
                    </dd>
                  </div>
                </dl>
                {runSummary?.artifacts?.markdown || runSummary?.artifacts?.json ? (
                  <div className="artifact-paths">
                    <strong>App-owned artifacts</strong>
                    {runSummary.artifacts.markdown ? (
                      <code>{runSummary.artifacts.markdown}</code>
                    ) : null}
                    {runSummary.artifacts.json ? (
                      <code>{runSummary.artifacts.json}</code>
                    ) : null}
                  </div>
                ) : null}
                {runSummary?.filesInspected &&
                runSummary.filesInspected.length > 0 ? (
                  <details className="inspected-files">
                    <summary>
                      Files inspected <span>{runSummary.filesInspected.length}</span>
                    </summary>
                    <ul>
                      {runSummary.filesInspected.map((path) => (
                        <li key={path}><code>{path}</code></li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </section>
            ) : null}
          </section>
        </section>
      </div>
    </main>
      )}
    </AppShell>
  );
}
