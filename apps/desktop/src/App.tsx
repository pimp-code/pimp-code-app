import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

type ProviderKind = "claude" | "local";

type AgentEvent =
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
      result?: string;
      error?: string;
      durationMs?: number;
      turns?: number;
      costUsd?: number;
    };

interface StartResponse {
  runId: string;
}

interface TimelineItem {
  id: number;
  tone: "neutral" | "warning" | "error" | "success";
  label: string;
  detail?: string;
}

const DEFAULT_PROMPT =
  "Inspect this repository in read-only mode. Identify the three highest-value frontend improvements, cite the relevant files, and return a short implementation plan. Do not modify files or run commands.";
const DEFAULT_MAX_TURNS = 10;

export function App() {
  const [provider, setProvider] = useState<ProviderKind>("local");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:1234/v1");
  const [repository, setRepository] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [runId, setRunId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const sequence = useRef(0);

  const configured = useMemo(
    () =>
      repository.trim().length > 0 &&
      prompt.trim().length > 0 &&
      model.trim().length > 0 &&
      (provider === "claude" || endpoint.trim().length > 0),
    [endpoint, model, prompt, provider, repository],
  );

  const addTimeline = (
    label: string,
    tone: TimelineItem["tone"] = "neutral",
    detail?: string,
  ) => {
    setTimeline((items) => [
      ...items,
      { id: ++sequence.current, label, tone, detail },
    ]);
  };

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
            JSON.stringify(payload.input),
          );
          break;
        case "diagnostic":
          addTimeline(
            payload.message,
            payload.level === "error" ? "error" : "warning",
          );
          break;
        case "result":
          setRunning(false);
          if (payload.result && !output) setOutput(payload.result);
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
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });

    void invoke<string | null>("agent_status").then((activeRunId) => {
      if (activeRunId && !disposed) {
        setRunId(activeRunId);
        setRunning(true);
        addTimeline("Reattached to active run", "neutral", activeRunId);
      }
    });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const chooseRepository = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select repository for the read-only spike",
    });
    if (typeof selected === "string") setRepository(selected);
  };

  const startRun = async () => {
    if (!configured || running) return;
    setOutput("");
    setTimeline([]);
    setRunId(undefined);
    setRunning(true);
    addTimeline(
      "Submitting read-only run",
      "neutral",
      `${DEFAULT_MAX_TURNS}-turn limit`,
    );

    try {
      const response = await invoke<StartResponse>("start_agent", {
        request: {
          cwd: repository,
          prompt,
          maxTurns: DEFAULT_MAX_TURNS,
          provider:
            provider === "claude"
              ? { kind: "claude", model }
              : { kind: "local", model, endpoint },
        },
      });
      setRunId(response.runId);
    } catch (error) {
      setRunning(false);
      addTimeline(String(error), "error");
    }
  };

  const cancelRun = async () => {
    if (!runId || !running) return;
    try {
      await invoke("cancel_agent", { runId });
      addTimeline("Cancellation sent", "warning");
    } catch (error) {
      addTimeline(String(error), "error");
    }
  };

  const changeProvider = (nextProvider: ProviderKind) => {
    setProvider(nextProvider);
    setModel(nextProvider === "claude" ? "sonnet" : "");
  };

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Tauri feasibility spike</p>
          <h1>Claude Code agent runtime</h1>
          <p className="subtitle">
            One read-only workflow, tested against Claude or a loopback
            OpenAI-compatible local model.
          </p>
        </div>
        <span className={`status-pill ${running ? "active" : ""}`}>
          <span className="status-dot" />
          {running ? "Agent running" : "Ready"}
        </span>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="section-heading">
            <span>01</span>
            <div>
              <h2>Runtime</h2>
              <p>Choose how Claude Code reaches the model.</p>
            </div>
          </div>

          <div className="segmented" role="group" aria-label="Provider">
            <button
              className={provider === "local" ? "selected" : ""}
              onClick={() => changeProvider("local")}
              type="button"
            >
              Local LLM
            </button>
            <button
              className={provider === "claude" ? "selected" : ""}
              onClick={() => changeProvider("claude")}
              type="button"
            >
              Claude API
            </button>
          </div>

          <label>
            <span>Model ID</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={provider === "claude" ? "sonnet" : "loaded model ID"}
              spellCheck={false}
            />
          </label>

          {provider === "local" ? (
            <label>
              <span>OpenAI-compatible endpoint</span>
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="http://127.0.0.1:1234/v1"
                spellCheck={false}
              />
              <small>Loopback endpoints only in this spike.</small>
            </label>
          ) : (
            <div className="notice">
              The host reads <code>ANTHROPIC_API_KEY</code> from its environment.
              The key never enters React state.
            </div>
          )}

          <div className="divider" />

          <div className="section-heading compact">
            <span>02</span>
            <div>
              <h2>Repository</h2>
              <p>Exact folder, never inferred upward.</p>
            </div>
          </div>

          <div className="picker-row">
            <input
              aria-label="Repository path"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              placeholder="Select a repository"
              spellCheck={false}
            />
            <button type="button" className="secondary" onClick={chooseRepository}>
              Browse
            </button>
          </div>

          <label>
            <span>Read-only task</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={7}
            />
          </label>

          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={!configured || running}
              onClick={startRun}
            >
              Start plan-only run
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
        </aside>

        <section className="results-panel">
          <div className="result-header">
            <div>
              <p className="eyebrow">Normalized output</p>
              <h2>Agent result</h2>
            </div>
            {runId ? <code className="run-id">{runId.slice(0, 8)}</code> : null}
          </div>

          <article className={`output ${output ? "has-output" : ""}`}>
            {output || "The streamed plan will appear here."}
          </article>

          <div className="timeline-header">
            <h3>Run timeline</h3>
            <span>{timeline.length} events</span>
          </div>
          <ol className="timeline">
            {timeline.length === 0 ? (
              <li className="empty">No run events yet.</li>
            ) : (
              timeline.map((item) => (
                <li key={item.id} className={item.tone}>
                  <span className="timeline-marker" />
                  <div>
                    <strong>{item.label}</strong>
                    {item.detail ? <small>{item.detail}</small> : null}
                  </div>
                </li>
              ))
            )}
          </ol>
        </section>
      </section>
    </main>
  );
}
