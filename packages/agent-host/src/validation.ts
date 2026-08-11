import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  HostCommand,
  ProviderConfig,
  RunCommand,
  StartCommand,
  StartPlanCommand,
} from "./protocol.js";

const MAX_PROMPT_LENGTH = 20_000;
const MAX_MODEL_LENGTH = 200;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  label: string,
  options: { maxLength?: number } = {},
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  const normalized = value.trim();
  if (options.maxLength !== undefined && normalized.length > options.maxLength) {
    throw new Error(`${label} is too long`);
  }

  if (/\p{Cc}/u.test(normalized)) {
    throw new Error(`${label} contains control characters`);
  }

  return normalized;
}

export function assertLoopbackEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Local endpoint must use HTTP or HTTPS");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowed =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";

  if (!allowed) {
    throw new Error("The spike only permits loopback local-LLM endpoints");
  }

  if (url.username || url.password) {
    throw new Error("Credentials must not be embedded in the local endpoint URL");
  }

  return url;
}

export function validateProviderConfig(
  value: unknown,
  options: { allowEmptyModel?: boolean } = {},
): ProviderConfig {
  const provider = requireObject(value, "provider");
  const kind = provider.kind;
  if (kind !== "claude" && kind !== "local") {
    throw new Error("provider.kind must be claude or local");
  }

  const model =
    options.allowEmptyModel && provider.model === ""
      ? ""
      : requireString(provider.model, "provider.model", {
          maxLength: MAX_MODEL_LENGTH,
        });
  return kind === "claude"
    ? { kind, model }
    : {
        kind,
        model,
        endpoint: assertLoopbackEndpoint(
          requireString(provider.endpoint, "provider.endpoint", {
            maxLength: 2_000,
          }),
        ).toString(),
      };
}

export async function validateStartCommand(value: unknown): Promise<StartCommand> {
  const command = requireObject(value, "command");
  if (command.type !== "start") {
    throw new Error("Expected a start command");
  }

  const requestedPath = resolve(requireString(command.cwd, "cwd"));
  const canonicalPath = await realpath(requestedPath);
  const metadata = await stat(canonicalPath);
  if (!metadata.isDirectory()) {
    throw new Error("cwd must resolve to a directory");
  }

  const rawMaxTurns = command.maxTurns;
  const maxTurns =
    typeof rawMaxTurns === "number" && Number.isInteger(rawMaxTurns)
      ? rawMaxTurns
      : 10;
  if (maxTurns < 1 || maxTurns > 20) {
    throw new Error("maxTurns must be between 1 and 20");
  }

  return {
    type: "start",
    runId: requireString(command.runId, "runId", { maxLength: 100 }),
    cwd: canonicalPath,
    prompt: requireString(command.prompt, "prompt", {
      maxLength: MAX_PROMPT_LENGTH,
    }),
    maxTurns,
    provider: validateProviderConfig(command.provider),
  };
}

function validateMaxTurns(value: unknown): number {
  const maxTurns =
    typeof value === "number" && Number.isInteger(value) ? value : 10;
  if (maxTurns < 1 || maxTurns > 20) {
    throw new Error("maxTurns must be between 1 and 20");
  }
  return maxTurns;
}

export async function validateStartPlanCommand(
  value: unknown,
): Promise<StartPlanCommand> {
  const command = requireObject(value, "command");
  if (command.type !== "start_plan") {
    throw new Error("Expected a start_plan command");
  }

  const runId = requireString(command.runId, "runId", { maxLength: 100 });
  if (!UUID_V4_PATTERN.test(runId)) {
    throw new Error("runId must be a version 4 UUID");
  }
  const requestedPath = resolve(
    requireString(command.preflightPath, "preflightPath", {
      maxLength: 2_000,
    }),
  );
  const canonicalPath = await realpath(requestedPath);
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) {
    throw new Error("preflightPath must resolve to a regular file");
  }

  if (typeof command.remoteEgressApproved !== "boolean") {
    throw new Error("remoteEgressApproved must be a boolean");
  }
  const provider = validateProviderConfig(command.provider);
  if (provider.kind === "claude" && !command.remoteEgressApproved) {
    throw new Error("Explicit remote-egress approval is required for Claude");
  }

  return {
    type: "start_plan",
    runId,
    preflightPath: canonicalPath,
    maxTurns: validateMaxTurns(command.maxTurns),
    provider,
    remoteEgressApproved: command.remoteEgressApproved,
  };
}

export async function validateRunCommand(value: unknown): Promise<RunCommand> {
  const command = requireObject(value, "command");
  return command.type === "start_plan"
    ? validateStartPlanCommand(command)
    : validateStartCommand(command);
}

export function parseHostCommand(line: string): HostCommand {
  const parsed: unknown = JSON.parse(line);
  const command = requireObject(parsed, "command");

  if (command.type === "cancel") {
    return {
      type: "cancel",
      runId: requireString(command.runId, "runId", { maxLength: 100 }),
    };
  }

  return parsed as HostCommand;
}
