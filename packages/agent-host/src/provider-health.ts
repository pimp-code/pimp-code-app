import { assertLoopbackEndpoint } from "./validation.js";
import type { ProviderConfig } from "./protocol.js";

const HEALTH_TIMEOUT_MS = 5_000;
const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 500;

export interface ProviderModel {
  id: string;
  label?: string;
}

export interface ProviderHealth {
  healthy: boolean;
  status: "ready" | "degraded" | "unavailable";
  message: string;
  models: ProviderModel[];
  checkedAt: string;
  discovery: "provider" | "static-aliases" | "unavailable";
}

function localModelsUrl(endpoint: string): URL {
  const url = assertLoopbackEndpoint(endpoint);
  const normalizedPath = url.pathname.replace(/\/$/, "");
  url.pathname = normalizedPath.endsWith("/chat/completions")
    ? normalizedPath.replace(/\/chat\/completions$/, "/models")
    : normalizedPath.endsWith("/models")
      ? normalizedPath
      : `${normalizedPath}/models`.replace(/\/+/g, "/");
  return url;
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MODELS_RESPONSE_BYTES) {
    throw new Error("Model-list response exceeds the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_MODELS_RESPONSE_BYTES) {
        await reader.cancel("Model-list response exceeds the size limit");
        throw new Error("Model-list response exceeds the size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks, totalBytes),
  );
}

function parseModels(value: unknown): ProviderModel[] {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new Error("Model-list response must contain a data array");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Model-list response data must be an array");
  }

  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const item of data.slice(0, MAX_MODELS)) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string") continue;
    const id = candidate.id.trim();
    if (!id || id.length > 200 || /\p{Cc}/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label =
      typeof candidate.display_name === "string" &&
      candidate.display_name.trim() &&
      candidate.display_name.length <= 200
        ? candidate.display_name.trim()
        : undefined;
    models.push({ id, ...(label ? { label } : {}) });
  }
  return models;
}

async function localHealth(provider: Extract<ProviderConfig, { kind: "local" }>): Promise<ProviderHealth> {
  const target = localModelsUrl(provider.endpoint);
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error("Provider health check timed out")),
    HEALTH_TIMEOUT_MS,
  );
  timeout.unref();

  try {
    const response = await fetch(target, {
      headers: process.env.LOCAL_LLM_API_KEY
        ? { authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` }
        : undefined,
      redirect: "error",
      signal: abortController.signal,
    });
    const text = await boundedText(response);
    if (!response.ok) {
      throw new Error(
        `Model endpoint returned ${response.status}${text.trim() ? `: ${text.trim().slice(0, 500)}` : ""}`,
      );
    }
    const models = parseModels(JSON.parse(text) as unknown);
    const selected = models.some((model) => model.id === provider.model);
    return {
      healthy: true,
      status: selected || !provider.model ? "ready" : "degraded",
      message: selected
        ? `Connected; selected model ${provider.model} is available`
        : provider.model
          ? `Connected, but selected model ${provider.model} was not returned`
          : `Connected; discovered ${models.length} model${models.length === 1 ? "" : "s"}`,
      models,
      checkedAt: new Date().toISOString(),
      discovery: "provider",
    };
  } catch (error) {
    return {
      healthy: false,
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
      models: [],
      checkedAt: new Date().toISOString(),
      discovery: "unavailable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkProviderHealth(
  provider: ProviderConfig,
): Promise<ProviderHealth> {
  if (provider.kind === "local") return localHealth(provider);

  const configured = Boolean(process.env.ANTHROPIC_API_KEY);
  return {
    healthy: configured,
    status: configured ? "ready" : "unavailable",
    message: configured
      ? "Claude credentials are available to the agent host"
      : "ANTHROPIC_API_KEY is not available to the agent host",
    models: [
      { id: "sonnet", label: "Sonnet alias" },
      { id: "opus", label: "Opus alias" },
      { id: "haiku", label: "Haiku alias" },
    ],
    checkedAt: new Date().toISOString(),
    discovery: "static-aliases",
  };
}
