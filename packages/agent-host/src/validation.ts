import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { HostCommand, StartCommand } from "./protocol.js";

const MAX_PROMPT_LENGTH = 20_000;
const MAX_MODEL_LENGTH = 200;

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

export async function validateStartCommand(value: unknown): Promise<StartCommand> {
  const command = requireObject(value, "command");
  if (command.type !== "start") {
    throw new Error("Expected a start command");
  }

  const provider = requireObject(command.provider, "provider");
  const kind = provider.kind;
  if (kind !== "claude" && kind !== "local") {
    throw new Error("provider.kind must be claude or local");
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

  const model = requireString(provider.model, "provider.model", {
    maxLength: MAX_MODEL_LENGTH,
  });

  return {
    type: "start",
    runId: requireString(command.runId, "runId", { maxLength: 100 }),
    cwd: canonicalPath,
    prompt: requireString(command.prompt, "prompt", {
      maxLength: MAX_PROMPT_LENGTH,
    }),
    maxTurns,
    provider:
      kind === "claude"
        ? { kind, model }
        : {
            kind,
            model,
            endpoint: assertLoopbackEndpoint(
              requireString(provider.endpoint, "provider.endpoint", {
                maxLength: 2_000,
              }),
            ).toString(),
          },
  };
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
