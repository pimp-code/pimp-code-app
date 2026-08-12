import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

let harness;
let server;

before(async () => {
  const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  server = await createServer({
    root: appDirectory,
    configFile: false,
    appType: "custom",
    plugins: [react()],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
  });
  harness = await server.ssrLoadModule("/tests/project-management-harness.tsx");
});

after(async () => {
  await server?.close();
});

test("project library exposes defaults and management actions", () => {
  const html = harness.renderProjectLibrary();
  assert.match(html, /Local workstation · fixture-model/u);
  assert.match(html, />Project settings</u);
  assert.match(html, />Remove from app</u);
});

test("project editor renders rename, default profile, model, and relink controls", () => {
  const html = harness.renderProjectEditor();
  assert.match(html, /aria-label="Edit Fixture"/u);
  assert.match(html, /value="Fixture"/u);
  assert.match(html, /Local workstation · fixture-model/u);
  assert.match(html, /Default model override/u);
  assert.match(html, /placeholder="fixture-model"/u);
  assert.match(html, />Relink folder</u);
  assert.match(html, />Save project</u);
});

test("interrupted job offers safe restart and guarded history deletion", () => {
  const html = harness.renderInterruptedJob();
  assert.match(html, />Restart from setup</u);
  assert.match(html, />Delete history</u);
  assert.match(html, /The host restarted\./u);
});

test("project overview exposes context and the primary workflow entry points", () => {
  const html = harness.renderProjectOverview();
  assert.match(html, /Project overview/u);
  assert.match(html, />Fixture</u);
  assert.match(html, />Browse skills</u);
  assert.match(html, /Local workstation/u);
  assert.match(html, />Project settings</u);
  assert.match(html, />Start the first job</u);
});

test("global settings centralizes skill roots and safety boundaries", () => {
  const html = harness.renderSettingsPage();
  assert.match(html, />Settings</u);
  assert.match(html, /value="C:\\skills"/u);
  assert.match(html, />Save &amp; scan</u);
  assert.match(html, />Manage LLM profiles</u);
  assert.match(html, /2 projects · 3 jobs/u);
  assert.match(html, /Apply disabled/u);
  assert.match(html, /Job-history retention/u);
  assert.match(html, /value="250"/u);
  assert.match(html, /value="180"/u);
  assert.match(html, />Save retention policy</u);
});
