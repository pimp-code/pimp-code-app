import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { startAgentRun } from "../src/agent-runner.js";
import type { HostEvent } from "../src/protocol.js";

test(
  "runs the bundled Claude Code binary through the local bridge",
  { timeout: 45_000 },
  async () => {
    let requests = 0;
    const upstream = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ data: [{ id: "local-test-model" }] }),
        );
        return;
      }
      for await (const _chunk of request) {
        // Drain the request before responding.
      }
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "fake-local-response",
          choices: [
            {
              delta: { content: "The local runtime is connected." },
              finish_reason: "stop",
            },
          ],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as AddressInfo;
    const events: HostEvent[] = [];

    try {
      const run = startAgentRun(
        {
          type: "start",
          runId: "local-sdk-smoke",
          cwd: process.cwd(),
          prompt: "Return one sentence confirming the local runtime connection.",
          maxTurns: 1,
          provider: {
            kind: "local",
            model: "local-test-model",
            endpoint: `http://127.0.0.1:${address.port}/v1`,
          },
        },
        (event) => events.push(event),
      );

      await run.done;
      const result = [...events].reverse().find((event) => event.type === "result");
      assert.ok(result && result.type === "result", JSON.stringify(events, null, 2));
      assert.equal(
        events.filter((event) => event.type === "result").length,
        1,
        JSON.stringify(events, null, 2),
      );
      assert.equal(result.success, true, JSON.stringify(events, null, 2));
      assert.equal(typeof result.result, "string", JSON.stringify(events, null, 2));
      assert.match(
        typeof result.result === "string" ? result.result : "",
        /local runtime is connected/i,
      );
      assert.ok(requests > 0, "Claude Code did not call the local endpoint");
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test(
  "aborts a local Claude Code run and its upstream request",
  { timeout: 20_000 },
  async () => {
    let resolveRequest!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const upstream = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ data: [{ id: "local-test-model" }] }),
        );
        return;
      }
      for await (const _chunk of request) {
        // Drain the request before waiting for cancellation.
      }
      resolveRequest();
      response.writeHead(200, { "content-type": "text/event-stream" });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as AddressInfo;
    const events: HostEvent[] = [];

    try {
      const run = startAgentRun(
        {
          type: "start",
          runId: "local-sdk-cancel",
          cwd: process.cwd(),
          prompt: "Wait for a response.",
          maxTurns: 1,
          provider: {
            kind: "local",
            model: "local-test-model",
            endpoint: `http://127.0.0.1:${address.port}/v1`,
          },
        },
        (event) => events.push(event),
      );

      await requestSeen;
      run.abort();
      await run.done;

      const result = [...events].reverse().find((event) => event.type === "result");
      assert.ok(result && result.type === "result", JSON.stringify(events, null, 2));
      assert.equal(
        events.filter((event) => event.type === "result").length,
        1,
        JSON.stringify(events, null, 2),
      );
      assert.equal(result.cancelled, true, JSON.stringify(events, null, 2));
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
