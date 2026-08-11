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
  type AgentEvent,
  type CatalogIssue,
  type DetailNote,
  type PlanPreflight,
  type ProviderConfig,
  type ProviderHealth,
  type ProviderKind,
  type RunArtifactPaths,
  type RunResultMetadata,
  type SkillCatalog,
  type SkillCatalogEntry,
  type StartPlanResponse,
  type StructuredRunResult,
  errorMessage,
  formatBytes,
  normalizePreflight,
  normalizeProviderHealth,
  normalizeSkillCatalog,
  shortDigest,
} from "./contracts";

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
const RUNNABLE_SKILL = "migrate-to-vite";

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

function isRunnableSkill(entry: SkillCatalogEntry): boolean {
  return (
    entry.status === "valid" &&
    entry.name === RUNNABLE_SKILL &&
    entry.digest.length > 0 &&
    entry.rootPath.length > 0
  );
}

function catalogEntryName(entry: SkillCatalogEntry): string {
  return (
    entry.presentation?.displayName ??
    entry.name ??
    entry.manifestPath ??
    "Unnamed skill package"
  );
}

export function App() {
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
  const sequence = useRef(0);

  const selectedSkill = useMemo(
    () => catalog?.entries.find((entry) => entry.id === selectedSkillId),
    [catalog, selectedSkillId],
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
        : {
            kind: "local",
            model: model.trim(),
            endpoint: endpoint.trim(),
          },
    [endpoint, model, providerKind],
  );

  const preflightApplicable =
    preflight?.applicability.verdict === "applicable";
  const needsClaudeApproval = providerKind === "claude";
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
    (providerKind === "claude" || endpoint.trim().length > 0);
  const canPrepare =
    repository.trim().length > 0 &&
    selectedSkill !== undefined &&
    isRunnableSkill(selectedSkill) &&
    providerReady &&
    model.trim().length > 0 &&
    !preparing &&
    !running;
  const canStart =
    preflight !== undefined &&
    preflight.id.length > 0 &&
    preflightApplicable &&
    preflight.contextManifest.files.length > 0 &&
    canonicalConfirmed &&
    providerReady &&
    model.trim().length > 0 &&
    (!needsClaudeApproval || remoteEgressApproved) &&
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
    setPreflight(undefined);
    setCanonicalConfirmed(false);
    setRemoteEgressApproved(false);
  }, []);

  const applyCatalog = useCallback((nextCatalog: SkillCatalog) => {
    setCatalog(nextCatalog);
    setSelectedSkillId((current) => {
      if (nextCatalog.entries.some((entry) => entry.id === current)) {
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
  }, [addTimeline]);

  const chooseRepository = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select the exact repository for plan-only analysis",
      });
      if (typeof selected === "string") {
        setRepository(selected);
        invalidatePreflight();
      }
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    }
  };

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

  const changeProvider = (nextProvider: ProviderKind) => {
    setProviderKind(nextProvider);
    setModel(nextProvider === "claude" ? "sonnet" : "");
    setProviderHealth(undefined);
    invalidatePreflight();
  };

  const checkProvider = async () => {
    if (!canCheckProvider) return;
    setCheckingProvider(true);
    setProviderHealth(undefined);
    invalidatePreflight();
    try {
      const rawHealth = await invoke<unknown>("provider_health", { provider });
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
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setCheckingProvider(false);
    }
  };

  const preparePlan = async () => {
    if (!canPrepare || !selectedSkill) return;
    setPreparing(true);
    setNotice(undefined);
    invalidatePreflight();
    try {
      const rawPreflight = await invoke<unknown>("prepare_migrate_to_vite", {
        repository: repository.trim(),
        skillId: selectedSkill.id,
        skillRoot: selectedSkill.rootPath,
      });
      const nextPreflight = normalizePreflight(rawPreflight);
      setPreflight(nextPreflight);
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
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setPreparing(false);
    }
  };

  const startPlan = async () => {
    if (!canStart || !preflight) return;
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
      `${maxTurns}-turn limit · ${preflight.contextManifest.files.length} approved files`,
    );

    try {
      const response = await invoke<StartPlanResponse>("start_plan", {
        request: {
          preflightId: preflight.id,
          provider,
          maxTurns,
          remoteEgressApproved:
            providerKind === "claude" ? remoteEgressApproved : false,
        },
      });
      setRunId(response.runId);
    } catch (error) {
      setRunning(false);
      addTimeline("Plan could not start", "error", errorMessage(error));
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
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Read-only vertical slice</p>
          <h1>Plan a safe Vite migration</h1>
          <p className="subtitle">
            Pin the repository and skill package, inspect the exact context, then
            run a structured plan without modifying the target project.
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
                <p>Choose the exact folder. The engine will canonicalize it.</p>
              </div>
            </div>
            <div className="picker-row">
              <label className="sr-only" htmlFor="repository-path">
                Repository path
              </label>
              <input
                id="repository-path"
                value={repository}
                onChange={(event) => {
                  setRepository(event.target.value);
                  invalidatePreflight();
                }}
                placeholder="Select a repository"
                spellCheck={false}
              />
              <button type="button" className="secondary" onClick={chooseRepository}>
                Browse
              </button>
            </div>
          </section>

          <section className="flow-section" aria-labelledby="skill-heading">
            <div className="section-heading heading-with-action">
              <span>02</span>
              <div>
                <h2 id="skill-heading">Skill catalog</h2>
                <p>Packages are validated and hashed; scripts stay inactive.</p>
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
                        disabled={!runnable}
                        onChange={() => selectSkill(entry)}
                      />
                      <span className="skill-card-body">
                        <span className="skill-title-row">
                          <strong>{catalogEntryName(entry)}</strong>
                          <span className={`catalog-status ${entry.status}`}>
                            {entry.status}
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
                          {!runnable && entry.status === "valid" ? (
                            <span>Catalog only</span>
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
                <h2 id="provider-heading">Provider &amp; limits</h2>
                <p>Test the runtime, identify the model source, then set a turn budget.</p>
              </div>
            </div>

            <div className="segmented" role="group" aria-label="Provider">
              <button
                className={providerKind === "local" ? "selected" : ""}
                aria-pressed={providerKind === "local"}
                onClick={() => changeProvider("local")}
                type="button"
              >
                Local bridge
              </button>
              <button
                className={providerKind === "claude" ? "selected" : ""}
                aria-pressed={providerKind === "claude"}
                onClick={() => changeProvider("claude")}
                type="button"
              >
                Claude
              </button>
            </div>

            {providerKind === "local" ? (
              <label className="field" htmlFor="provider-endpoint">
                <span>OpenAI-compatible loopback endpoint</span>
                <input
                  id="provider-endpoint"
                  value={endpoint}
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    setProviderHealth(undefined);
                    invalidatePreflight();
                  }}
                  placeholder={DEFAULT_ENDPOINT}
                  spellCheck={false}
                />
                <small>
                  Compatibility bridge for the packaged Claude Code runtime; not a
                  native LM Studio or Ollama adapter.
                </small>
              </label>
            ) : (
              <div className="inline-note">
                Claude credentials remain in the host environment and never enter
                React state. Context egress requires a separate approval below.
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
                    setProviderHealth(undefined);
                    invalidatePreflight();
                  }}
                  placeholder={
                    providerKind === "claude" ? "sonnet" : "Run health check"
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
                  value={maxTurns}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setMaxTurns(
                      Number.isFinite(value)
                        ? Math.min(MAX_MAX_TURNS, Math.max(MIN_MAX_TURNS, value))
                        : DEFAULT_MAX_TURNS,
                    );
                  }}
                />
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

              {needsClaudeApproval ? (
                <section className="egress-card" aria-labelledby="egress-heading">
                  <div>
                    <p className="eyebrow">Remote egress</p>
                    <h3 id="egress-heading">Approval required for Claude</h3>
                    <p>
                      Destination: {preflight.remoteEgress.destination || "Claude provider"}.
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
                  Local bridge target: <code>{endpoint}</code>. Claude remote-egress
                  approval is not requested for this provider.
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
                Read files only · no writes · no repository commands · {maxTurns}-turn cap
              </p>
            </div>
          )}

          <section className="run-output" aria-labelledby="output-heading">
            <div className="output-header">
              <div>
                <p className="eyebrow">Structured artifact</p>
                <h2 id="output-heading">Migration plan</h2>
              </div>
              {runId ? <code className="run-id">{runId.slice(0, 12)}</code> : null}
            </div>
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
  );
}
