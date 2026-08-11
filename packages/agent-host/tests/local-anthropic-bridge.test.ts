import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  startLocalAnthropicBridge,
  translateAnthropicRequest,
} from "../src/local-anthropic-bridge.js";
import { assertLoopbackEndpoint } from "../src/validation.js";

test("rejects a non-loopback local endpoint", () => {
  assert.throws(
    () => assertLoopbackEndpoint("https://example.com/v1"),
    /only permits loopback/,
  );
});

test("fails fast when the local endpoint is offline", async () => {
  const unavailable = createServer();
  await new Promise<void>((resolve) =>
    unavailable.listen(0, "127.0.0.1", resolve),
  );
  const address = unavailable.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    unavailable.close((error) => (error ? reject(error) : resolve())),
  );

  await assert.rejects(
    startLocalAnthropicBridge({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      model: "local-model",
    }),
    /Local LLM endpoint is unavailable/,
  );
});

test("rejects redirects from the local endpoint model preflight", async () => {
  let followedRedirect = false;
  const upstream = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(302, { location: "/redirected-models" });
      response.end();
      return;
    }
    followedRedirect = true;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as AddressInfo;

  try {
    await assert.rejects(
      startLocalAnthropicBridge({
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: "local-model",
      }),
      /Local LLM endpoint is unavailable/,
    );
    assert.equal(followedRedirect, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("translates Anthropic text and tool messages", () => {
  const translated = translateAnthropicRequest(
    {
      system: "Be concise",
      messages: [
        { role: "user", content: "Inspect the project" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { path: "package.json" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "{}",
            },
          ],
        },
      ],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object" },
        },
      ],
      stream: true,
    },
    "local-model",
  );

  assert.equal(translated.model, "local-model");
  assert.equal(translated.messages[0]?.role, "system");
  assert.equal(translated.messages[2]?.tool_calls?.[0]?.function.name, "Read");
  assert.equal(translated.messages[3]?.role, "tool");
  assert.equal(translated.tools?.[0]?.function.name, "Read");
});

test("streams an OpenAI-compatible response as Anthropic SSE", async () => {
  const upstream = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
      return;
    }
    for await (const _chunk of request) {
      // Drain the request before writing a response.
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: " local" }, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address() as AddressInfo;

  const bridge = await startLocalAnthropicBridge({
    endpoint: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    model: "local-model",
  });

  try {
    const response = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ignored",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: message_start/);
    assert.match(body, /"text":"Hello"/);
    assert.match(body, /"text":" local"/);
    assert.match(body, /event: message_stop/);
  } finally {
    await bridge.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects redirects from the local chat-completions endpoint", async () => {
  let followedRedirect = false;
  const upstream = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
      return;
    }
    for await (const _chunk of request) {
      // Drain the request before responding.
    }
    if (request.url === "/v1/chat/completions") {
      response.writeHead(307, { location: "/redirected-completion" });
      response.end();
      return;
    }
    followedRedirect = true;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as AddressInfo;
  const bridge = await startLocalAnthropicBridge({
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    model: "local-model",
  });

  try {
    const response = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /fetch failed/i);
    assert.equal(followedRedirect, false);
  } finally {
    await bridge.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test(
  "keeps the timeout active while consuming a non-streaming response",
  { timeout: 5_000 },
  async () => {
    const upstream = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
        return;
      }
      for await (const _chunk of request) {
        // Drain the request before writing a partial response.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"choices":[');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address() as AddressInfo;
    const bridge = await startLocalAnthropicBridge({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      model: "local-model",
      requestTimeoutMs: 100,
    });

    try {
      const response = await fetch(`${bridge.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
          stream: false,
        }),
      });
      assert.equal(response.status, 500);
      await response.text();
    } finally {
      await bridge.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test(
  "keeps the timeout active while consuming a streaming response",
  { timeout: 5_000 },
  async () => {
    const upstream = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
        return;
      }
      for await (const _chunk of request) {
        // Drain the request before writing a partial stream.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address() as AddressInfo;
    const bridge = await startLocalAnthropicBridge({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      model: "local-model",
      requestTimeoutMs: 100,
    });

    try {
      await assert.rejects(
        (async () => {
          const response = await fetch(`${bridge.baseUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: "Hello" }],
              stream: true,
            }),
          });
          await response.text();
        })(),
      );
    } finally {
      await bridge.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
