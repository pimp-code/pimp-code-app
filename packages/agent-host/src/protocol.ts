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

export interface StartPlanCommand {
  type: "start_plan";
  runId: string;
  preflightPath: string;
  maxTurns: number;
  provider: ProviderConfig;
  remoteEgressApproved: boolean;
}

export interface CancelCommand {
  type: "cancel";
  runId: string;
}

export type RunCommand = StartCommand | StartPlanCommand;

export type HostCommand = RunCommand | CancelCommand;

export interface RunArtifactPaths {
  runDirectory?: string;
  markdown?: string;
  json?: string;
  context?: string;
  preflight?: string;
  metadata?: string;
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
  json?: unknown;
  metadata?: RunResultMetadata;
  artifacts?: RunArtifactPaths;
}

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
      result?: string | StructuredRunResult;
      error?: string;
      sessionId?: string;
      durationMs?: number;
      turns?: number;
      costUsd?: number;
      usage?: unknown;
      metadata?: RunResultMetadata;
      artifacts?: RunArtifactPaths;
    };
