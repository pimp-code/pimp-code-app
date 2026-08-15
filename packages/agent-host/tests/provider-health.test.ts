import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import test from "node:test";
import { checkProviderHealth } from "../src/provider-health.js";
import { validateProviderConfig } from "../src/validation.js";

async function listen(listener: RequestListener): Promise<{
  endpoint: string;
  server: Server;
}> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Test server did not bind a TCP port");
  }
  return { server, endpoint: `http://127.0.0.1:${address.port}/v1` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("local health discovers models and distinguishes a missing selection", async () => {
  const fixture = await listen((request, response) => {
    assert.equal(request.url, "/v1/models");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: [
          { id: "local-model-a", display_name: "Local model A" },
          { id: "local-model-b" },
        ],
      }),
    );
  });
  try {
    const discoveryProvider = validateProviderConfig(
      { kind: "local", model: "", endpoint: fixture.endpoint },
      { allowEmptyModel: true },
    );
    const discovery = await checkProviderHealth(discoveryProvider);
    assert.equal(discovery.healthy, true);
    assert.equal(discovery.status, "ready");
    assert.equal(discovery.discovery, "provider");
    assert.deepEqual(discovery.models, [
      { id: "local-model-a", label: "Local model A" },
      { id: "local-model-b" },
    ]);

    const missing = await checkProviderHealth({
      kind: "local",
      model: "not-loaded",
      endpoint: fixture.endpoint,
    });
    assert.equal(missing.healthy, true);
    assert.equal(missing.status, "degraded");
  } finally {
    await close(fixture.server);
  }
});

test("local health rejects model-list redirects", async () => {
  const fixture = await listen((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", "http://127.0.0.1:9/v1/models");
    response.end();
  });
  try {
    const health = await checkProviderHealth({
      kind: "local",
      model: "model",
      endpoint: fixture.endpoint,
    });
    assert.equal(health.healthy, false);
    assert.equal(health.status, "unavailable");
    assert.deepEqual(health.models, []);
  } finally {
    await close(fixture.server);
  }
});

test("local health bounds a model response without content-length", async () => {
  const fixture = await listen((_request, response) => {
    response.write("{");
    response.end("x".repeat(1024 * 1024));
  });
  try {
    const health = await checkProviderHealth({
      kind: "local",
      model: "model",
      endpoint: fixture.endpoint,
    });
    assert.equal(health.healthy, false);
    assert.match(health.message, /size limit/u);
  } finally {
    await close(fixture.server);
  }
});

test("Claude health reports credential presence and labels aliases as static", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    const unavailable = await checkProviderHealth({
      kind: "claude",
      model: "sonnet",
    });
    assert.equal(unavailable.healthy, false);
    assert.equal(unavailable.discovery, "static-aliases");

    process.env.ANTHROPIC_API_KEY = "provider-health-test-key";
    const ready = await checkProviderHealth({
      kind: "claude",
      model: "sonnet",
    });
    assert.equal(ready.healthy, true);
    assert.equal(ready.status, "ready");
    assert.ok(ready.models.some((model) => model.id === "sonnet"));
    assert.ok(!ready.message.includes("provider-health-test-key"));
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("Codex health requires OpenAI credentials and verifies the local SDK runtime", async () => {
  const previous = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    const unavailable = await checkProviderHealth({
      kind: "codex",
      model: "gpt-5.6-terra",
    });
    assert.equal(unavailable.healthy, false);
    assert.match(unavailable.message, /OPENAI_API_KEY/u);

    process.env.OPENAI_API_KEY = "codex-provider-health-test-key";
    const ready = await checkProviderHealth({
      kind: "codex",
      model: "gpt-5.6-terra",
    });
    assert.equal(ready.healthy, true);
    assert.equal(ready.status, "ready");
    assert.equal(ready.discovery, "static-aliases");
    assert.ok(ready.models.some((model) => model.id === "gpt-5.6-terra"));
    assert.ok(!ready.message.includes("codex-provider-health-test-key"));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
