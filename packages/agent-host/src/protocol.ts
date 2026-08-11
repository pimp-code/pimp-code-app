export type ProviderConfig =
  | {
      kind: "claude";
      model: string;
    }
  | {
      kind: "local";
      model: string;
      endpoint: string;
    };
export interface StartCommand {
  type: "start";
  runId: string;
  cwd: string;
  prompt: string;
  maxTurns: number;
  provider: ProviderConfig;
}

export interface CancelCommand {
  type: "cancel";
  runId: string;
}

export type HostCommand = StartCommand | CancelCommand;

export type HostEvent =
  | {
      type: "status";
      runId: string;
      phase: string;
      message: string;
      details?: Record<string, unknown>;
    }
  | {
      type: "text_delta";
      runId: string;
      text: string;
    }
  | {
      type: "tool_call";
      runId: string;
      name: string;
      input: unknown;
    }
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
      sessionId?: string;
      durationMs?: number;
      turns?: number;
      costUsd?: number;
      usage?: unknown;
    };
