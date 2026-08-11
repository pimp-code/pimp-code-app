import {
  query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { HostEvent, StartCommand } from "./protocol.js";
import { startLocalAnthropicBridge, type LocalBridge } from "./local-anthropic-bridge.js";

const SAFE_ENV_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
] as const;

export interface ActiveRun {
  abort(): void;
  done: Promise<void>;
}

function buildBaseEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) environment[key] = process.env[key];
  }

  return {
    ...environment,
    CLAUDE_AGENT_SDK_CLIENT_APP: "pimp-code-tauri-spike/0.0.0",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
  };
}

function redactDiagnostic(value: string): string {
  let redacted = value;
  for (const secret of [
    process.env.ANTHROPIC_API_KEY,
    process.env.LOCAL_LLM_API_KEY,
  ]) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.slice(0, 4_000);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeSdkMessage(runId: string, message: SDKMessage): HostEvent[] {
  if (message.type === "stream_event") {
    const event = asRecord(message.event);
    const delta = asRecord(event?.delta);
    if (event?.type === "content_block_delta" && delta?.type === "text_delta") {
      return [
        {
          type: "text_delta",
          runId,
          text: typeof delta.text === "string" ? delta.text : "",
        },
      ];
    }
    return [];
  }

  if (message.type === "system" && message.subtype === "init") {
    return [
      {
        type: "status",
        runId,
        phase: "agent_initialized",
        message: `Claude Code ${message.claude_code_version} initialized`,
        details: {
          model: message.model,
          tools: message.tools,
          permissionMode: message.permissionMode,
        },
      },
    ];
  }

  if (message.type === "assistant") {
    const events: HostEvent[] = [];
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        events.push({
          type: "tool_call",
          runId,
          name: block.name,
          input: block.input,
        });
      }
    }
    return events;
  }

  if (message.type === "system" && message.subtype === "permission_denied") {
    return [
      {
        type: "diagnostic",
        runId,
        level: "warning",
        message: `Denied tool ${message.tool_name}: ${message.decision_reason ?? "not approved"}`,
      },
    ];
  }

  return [];
}

function resultEvent(
  runId: string,
  message: SDKResultMessage,
  cancelled: boolean,
): Extract<HostEvent, { type: "result" }> {
  if (message.subtype === "success") {
    return {
      type: "result",
      runId,
      success: true,
      cancelled,
      result: message.result,
      sessionId: message.session_id,
      durationMs: message.duration_ms,
      turns: message.num_turns,
      costUsd: message.total_cost_usd,
      usage: message.usage,
    };
  }

  return {
    type: "result",
    runId,
    success: false,
    cancelled,
    error: message.errors.join("\n") || `Agent finished with ${message.subtype}`,
    sessionId: message.session_id,
    durationMs: message.duration_ms,
    turns: message.num_turns,
    costUsd: message.total_cost_usd,
    usage: message.usage,
  };
}

export function startAgentRun(
  command: StartCommand,
  emit: (event: HostEvent) => void,
): ActiveRun {
  const abortController = new AbortController();
  let cancelled = false;

  const done = (async () => {
    let bridge: LocalBridge | undefined;
    let terminalResultEmitted = false;
    const emitTerminalResult = (
      event: Extract<HostEvent, { type: "result" }>,
    ): void => {
      if (terminalResultEmitted) return;
      terminalResultEmitted = true;
      emit(event);
    };

    try {
      const environment = buildBaseEnvironment();
      if (command.provider.kind === "claude") {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new Error("ANTHROPIC_API_KEY is required for the Claude profile");
        }
        environment.ANTHROPIC_API_KEY = apiKey;
      } else {
        bridge = await startLocalAnthropicBridge({
          endpoint: command.provider.endpoint,
          model: command.provider.model,
          apiKey: process.env.LOCAL_LLM_API_KEY,
        });
        environment.ANTHROPIC_API_KEY = "local-spike-key";
        environment.ANTHROPIC_AUTH_TOKEN = "local-spike-token";
        environment.ANTHROPIC_BASE_URL = bridge.baseUrl;
        environment.ANTHROPIC_MODEL = command.provider.model;
        environment.ANTHROPIC_CUSTOM_MODEL_OPTION = command.provider.model;
        environment.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
      }

      emit({
        type: "status",
        runId: command.runId,
        phase: "starting_agent",
        message:
          command.provider.kind === "local"
            ? `Starting Claude Code through local bridge for ${command.provider.model}`
            : `Starting Claude Code with ${command.provider.model}`,
      });

      const agentQuery = query({
        prompt: command.prompt,
        options: {
          abortController,
          allowedTools: ["Read", "Glob", "Grep"],
          cwd: command.cwd,
          env: environment,
          includePartialMessages: true,
          maxTurns: command.maxTurns,
          model: command.provider.model,
          permissionMode: "plan",
          settingSources: [],
          strictMcpConfig: true,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append:
              "This is a read-only feasibility spike. Inspect only the selected directory. Do not request shell, write, edit, network, or Git mutation tools. Return a concise evidence-based plan.",
          },
          tools: ["Read", "Glob", "Grep"],
          stderr: (data) => {
            const diagnostic = redactDiagnostic(data).trim();
            if (diagnostic) {
              emit({
                type: "diagnostic",
                runId: command.runId,
                level: "warning",
                message: diagnostic,
              });
            }
          },
        },
      });

      for await (const message of agentQuery) {
        for (const event of normalizeSdkMessage(command.runId, message)) {
          emit(event);
        }
        if (message.type === "result") {
          emitTerminalResult(resultEvent(command.runId, message, cancelled));
        }
      }

      if (!terminalResultEmitted) {
        emitTerminalResult({
          type: "result",
          runId: command.runId,
          success: false,
          cancelled,
          error: cancelled
            ? "Run cancelled"
            : "Agent stream ended without a terminal result",
        });
      }
    } catch (error) {
      emitTerminalResult({
        type: "result",
        runId: command.runId,
        success: false,
        cancelled,
        error: redactDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
      });
    } finally {
      await bridge?.close().catch(() => undefined);
    }
  })();

  return {
    abort() {
      cancelled = true;
      abortController.abort("Cancelled by user");
    },
    done,
  };
}
