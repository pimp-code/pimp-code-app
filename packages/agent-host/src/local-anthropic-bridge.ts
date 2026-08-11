import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { assertLoopbackEndpoint } from "./validation.js";

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const ENDPOINT_PREFLIGHT_TIMEOUT_MS = 5_000;
const LOCAL_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type?: string; text?: string }>;
  messages?: AnthropicMessage[];
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?:
    | { type?: string; name?: string }
    | "auto"
    | "required"
    | "none";
  stream?: boolean;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAIRequest {
  model: string;
  max_tokens?: number;
  messages: OpenAIMessage[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: unknown;
  stream: boolean;
}

export interface LocalBridgeOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  requestTimeoutMs?: number;
}

export interface LocalBridge {
  baseUrl: string;
  close(): Promise<void>;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n");
  }

  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function systemText(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((block) => block.text ?? "").filter(Boolean).join("\n");
}

function translateMessages(messages: AnthropicMessage[]): OpenAIMessage[] {
  const translated: OpenAIMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      translated.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      const toolCalls = message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id ?? randomUUID(),
          type: "function" as const,
          function: {
            name: block.name ?? "unknown_tool",
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));

      translated.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const textBlocks = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .filter(Boolean);
    if (textBlocks.length > 0) {
      translated.push({ role: "user", content: textBlocks.join("\n") });
    }

    for (const block of message.content) {
      if (block.type === "tool_result") {
        translated.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "missing-tool-id",
          content: stringifyContent(block.content),
        });
      }
    }
  }

  return translated;
}

function translateToolChoice(choice: AnthropicRequest["tool_choice"]): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;

  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  return "auto";
}

export function translateAnthropicRequest(
  request: AnthropicRequest,
  configuredModel: string,
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  const system = systemText(request.system);
  if (system) messages.push({ role: "system", content: system });
  messages.push(...translateMessages(request.messages ?? []));

  const tools = request.tools?.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }));
  const toolChoice = translateToolChoice(request.tool_choice);

  return {
    model: configuredModel,
    ...(request.max_tokens ? { max_tokens: request.max_tokens } : {}),
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    stream: request.stream ?? true,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error("Request body exceeds the bridge limit");
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function chatCompletionsUrl(endpoint: URL): URL {
  const url = new URL(endpoint);
  const normalizedPath = url.pathname.replace(/\/$/, "");
  url.pathname = normalizedPath.endsWith("/chat/completions")
    ? normalizedPath
    : `${normalizedPath}/chat/completions`.replace(/\/+/g, "/");
  return url;
}

function modelsUrl(chatCompletionsEndpoint: URL): URL {
  const url = new URL(chatCompletionsEndpoint);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/models");
  return url;
}

async function assertLocalEndpointAvailable(
  endpoint: URL,
  apiKey?: string,
): Promise<void> {
  const target = modelsUrl(endpoint);
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error("Local endpoint preflight timed out")),
    ENDPOINT_PREFLIGHT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(target, {
      method: "GET",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      redirect: "error",
      signal: abortController.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 500);
      throw new Error(
        `Local LLM endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }

    await response.body?.cancel();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Local LLM endpoint is unavailable at ${target.origin}${target.pathname}. ` +
        `Start the local server and load the selected model. (${detail})`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function relayNonStreaming(
  response: ServerResponse,
  upstream: Response,
  request: AnthropicRequest,
  model: string,
): Promise<void> {
  const payload = (await upstream.json()) as {
    id?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = payload.choices?.[0];
  const content: unknown[] = [];
  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      input = { _raw: call.function?.arguments ?? "" };
    }
    content.push({
      type: "tool_use",
      id: call.id ?? randomUUID(),
      name: call.function?.name ?? "unknown_tool",
      input,
    });
  }

  sendJson(response, 200, {
    id: payload.id ?? `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason:
      choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens:
        payload.usage?.prompt_tokens ?? estimateTokens(request.messages),
      output_tokens:
        payload.usage?.completion_tokens ?? estimateTokens(content),
    },
  });
}

async function relayStreaming(
  response: ServerResponse,
  upstream: Response,
  request: AnthropicRequest,
  model: string,
): Promise<void> {
  if (!upstream.body) throw new Error("Local endpoint returned no stream body");

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
  });

  const messageId = `msg_${randomUUID()}`;
  writeSse(response, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: estimateTokens(request.messages), output_tokens: 0 },
    },
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextContentIndex = 0;
  let textIndex: number | undefined;
  const toolIndexes = new Map<number, number>();
  const openBlocks = new Set<number>();
  let finishReason = "end_turn";
  let outputTokens = 0;

  const processData = (data: string): void => {
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { completion_tokens?: number };
    };
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage?.completion_tokens !== undefined) {
      outputTokens = chunk.usage.completion_tokens;
    }

    const text = choice?.delta?.content;
    if (text) {
      if (textIndex === undefined) {
        textIndex = nextContentIndex++;
        openBlocks.add(textIndex);
        writeSse(response, "content_block_start", {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        });
      }
      writeSse(response, "content_block_delta", {
        type: "content_block_delta",
        index: textIndex,
        delta: { type: "text_delta", text },
      });
    }

    for (const toolCall of choice?.delta?.tool_calls ?? []) {
      const sourceIndex = toolCall.index ?? 0;
      let targetIndex = toolIndexes.get(sourceIndex);
      if (targetIndex === undefined) {
        targetIndex = nextContentIndex++;
        toolIndexes.set(sourceIndex, targetIndex);
        openBlocks.add(targetIndex);
        writeSse(response, "content_block_start", {
          type: "content_block_start",
          index: targetIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id ?? `tool_${randomUUID()}`,
            name: toolCall.function?.name ?? "unknown_tool",
            input: {},
          },
        });
      }
      const argumentsDelta = toolCall.function?.arguments;
      if (argumentsDelta) {
        writeSse(response, "content_block_delta", {
          type: "content_block_delta",
          index: targetIndex,
          delta: { type: "input_json_delta", partial_json: argumentsDelta },
        });
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("data:")) processData(line.slice(5).trim());
      }
    }
    if (done) break;
  }

  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith("data:")) processData(line.slice(5).trim());
    }
  }

  for (const index of [...openBlocks].sort((a, b) => a - b)) {
    writeSse(response, "content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }
  writeSse(response, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: outputTokens },
  });
  writeSse(response, "message_stop", { type: "message_stop" });
  response.end();
}

export async function startLocalAnthropicBridge(
  options: LocalBridgeOptions,
): Promise<LocalBridge> {
  const endpoint = assertLoopbackEndpoint(options.endpoint);
  const target = chatCompletionsUrl(endpoint);
  await assertLocalEndpointAvailable(target, options.apiKey);

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");

    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
        sendJson(response, 200, {
          data: [{ id: options.model, display_name: options.model }],
        });
        return;
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/v1/messages/count_tokens"
      ) {
        const body = await readJsonBody(request);
        sendJson(response, 200, { input_tokens: estimateTokens(body) });
        return;
      }

      if (request.method !== "POST" || requestUrl.pathname !== "/v1/messages") {
        sendJson(response, 404, {
          type: "error",
          error: { type: "not_found_error", message: "Not found" },
        });
        return;
      }

      const body = (await readJsonBody(request)) as AnthropicRequest;
      const translated = translateAnthropicRequest(body, options.model);
      const upstreamAbort = new AbortController();
      const timeout = setTimeout(
        () => upstreamAbort.abort(new Error("Local model request timed out")),
        options.requestTimeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS,
      );
      timeout.unref();
      request.once("aborted", () => upstreamAbort.abort());
      response.once("close", () => {
        if (!response.writableEnded) upstreamAbort.abort();
      });

      try {
        const upstream = await fetch(target, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey
              ? { authorization: `Bearer ${options.apiKey}` }
              : {}),
          },
          body: JSON.stringify(translated),
          redirect: "error",
          signal: upstreamAbort.signal,
        });

        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 4_000);
          sendJson(response, 502, {
            type: "error",
            error: {
              type: "api_error",
              message: `Local endpoint returned ${upstream.status}: ${detail}`,
            },
          });
          return;
        }

        if (translated.stream) {
          await relayStreaming(response, upstream, body, options.model);
        } else {
          await relayNonStreaming(response, upstream, body, options.model);
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
