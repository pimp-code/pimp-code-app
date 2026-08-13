import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { build } from "vite";

let directory;
let dom;
let harness;
let host;
let root;

function tauriMockPlugin() {
  const modules = new Map([
    [
      "@tauri-apps/api/core",
      `export const invoke = (command, args) => globalThis.__PIMP_CODE_TAURI_TEST__.invoke(command, args);`,
    ],
    [
      "@tauri-apps/api/event",
      `export const listen = (event, handler) => globalThis.__PIMP_CODE_TAURI_TEST__.listen(event, handler);`,
    ],
    [
      "@tauri-apps/plugin-dialog",
      `export const open = (options) => globalThis.__PIMP_CODE_TAURI_TEST__.open(options);`,
    ],
  ]);
  return {
    name: "pimp-code-tauri-test-mocks",
    enforce: "pre",
    resolveId(id) {
      return modules.has(id) ? `\0pimp-code-test:${id}` : undefined;
    },
    load(id) {
      const prefix = "\0pimp-code-test:";
      return id.startsWith(prefix) ? modules.get(id.slice(prefix.length)) : undefined;
    },
  };
}

function project(id, name, path, profileId, model) {
  return {
    id,
    name,
    configuredPath: path,
    canonicalPath: path,
    defaultProviderProfileId: profileId,
    defaultModel: model,
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: 2,
  };
}

function profile(id, name, model) {
  return {
    id,
    name,
    kind: "local",
    endpoint: "http://127.0.0.1:1234/v1",
    defaultModel: model,
    credentialRef: "environment:LOCAL_LLM_API_KEY",
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

function createHost() {
  const firstProfile = profile(
    "9ac14f43-e848-41b8-a0c1-036a47322d0c",
    "Local workstation",
    "local-default",
  );
  const secondProfile = profile(
    "202af11c-66ae-4097-90ed-87dc54b07617",
    "Local laptop",
    "laptop-default",
  );
  const firstProject = project(
    "5d6260e5-cadc-46e8-a661-38612af1bd09",
    "Alpha project",
    "C:\\alpha",
    firstProfile.id,
    "alpha-model",
  );
  const secondProject = project(
    "8fcc2f24-a696-41ba-9ad3-47efda7f78ac",
    "Beta project",
    "C:\\beta",
    secondProfile.id,
    undefined,
  );
  const state = {
    projects: {
      version: 1,
      activeProjectId: firstProject.id,
      projects: [firstProject, secondProject],
    },
    profiles: { version: 1, profiles: [firstProfile, secondProfile] },
    applicationSettings: {
      version: 1,
      jobRetention: {
        enabled: false,
        maxTerminalJobs: 500,
        maxAgeDays: 365,
      },
    },
    jobs: { version: 1, jobs: [] },
    credentialProfileIds: new Set(),
  };
  const calls = [];
  return {
    state,
    calls,
    async invoke(command, args = {}) {
      calls.push({ command, args });
      switch (command) {
        case "list_projects":
          return structuredClone(state.projects);
        case "list_provider_profiles":
          return structuredClone(state.profiles);
        case "list_application_settings":
          return structuredClone(state.applicationSettings);
        case "list_jobs":
          return structuredClone(state.jobs);
        case "load_skill_roots":
          return [];
        case "agent_status":
          return null;
        case "provider_credential_status": {
          const profile = state.profiles.profiles.find(
            (item) => item.id === args.profileId,
          );
          const vaultBacked = profile?.credentialRef?.startsWith("vault:provider:");
          return {
            profileId: args.profileId,
            source: vaultBacked ? "windowsVault" : "environment",
            configured:
              vaultBacked && state.credentialProfileIds.has(args.profileId),
          };
        }
        case "save_provider_credential": {
          const profile = state.profiles.profiles.find(
            (item) => item.id === args.profileId,
          );
          if (!profile) throw new Error("Profile not found");
          profile.credentialRef = `vault:provider:${profile.id}`;
          profile.revision += 1;
          state.credentialProfileIds.add(profile.id);
          return structuredClone(state.profiles);
        }
        case "select_saved_project":
          state.projects.activeProjectId = args.projectId;
          return structuredClone(state.projects);
        case "save_application_settings":
          state.applicationSettings = structuredClone(args.settings);
          return structuredClone(state.applicationSettings);
        default:
          throw new Error(`Unexpected desktop command: ${command}`);
      }
    },
    async listen() {
      return () => undefined;
    },
    async open() {
      return null;
    },
  };
}

function installDom() {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1:1420/",
  });
  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "Node",
    "Event",
    "MouseEvent",
  ]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: dom.window[name],
    });
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.confirm = () => true;
}

async function settle(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${message}\nBody: ${document.body.textContent}\nCalls: ${JSON.stringify(host.calls)}`,
      );
    }
    await harness.runAct(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function button(label) {
  const candidates = [...document.querySelectorAll("button")];
  return (
    candidates.find((candidate) => candidate.textContent.trim() === label) ??
    candidates.find((candidate) => candidate.textContent.trim().endsWith(label))
  );
}

async function click(element) {
  assert.ok(element, "expected an interactive element");
  await harness.runAct(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function enter(input, value) {
  assert.ok(input instanceof HTMLInputElement, "expected an input element");
  await harness.runAct(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

before(async () => {
  installDom();
  directory = await mkdtemp(join(tmpdir(), "pimp-code-shell-test-"));
  const outfile = join(directory, "desktop-shell-harness.mjs");
  const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  await build({
    root: appDirectory,
    configFile: false,
    plugins: [tauriMockPlugin(), react()],
    build: {
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: join(appDirectory, "tests", "desktop-shell-harness.tsx"),
        formats: ["es"],
        fileName: () => "desktop-shell-harness.mjs",
      },
      codeSplitting: false,
    },
  });
  harness = await import(pathToFileURL(outfile));
});

beforeEach(async () => {
  host = createHost();
  globalThis.__PIMP_CODE_TAURI_TEST__ = host;
  document.body.innerHTML = '<div id="root"></div>';
  root = await harness.mount(document.getElementById("root"));
  await settle(
    () => document.body.textContent.includes("Alpha project"),
    "desktop shell did not restore its saved project",
  );
});

afterEach(async () => {
  await harness.unmount(root);
  delete globalThis.__PIMP_CODE_TAURI_TEST__;
  document.body.replaceChildren();
});

after(async () => {
  dom.window.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

test("restores persisted project, provider defaults, and overview navigation", () => {
  assert.match(document.body.textContent, /Project overview/u);
  assert.match(document.body.textContent, /Alpha project/u);
  assert.match(document.body.textContent, /Local workstation/u);
  assert.match(document.body.textContent, /alpha-model/u);
  assert.deepEqual(
    host.calls.slice(0, 4).map((call) => call.command),
    [
      "list_projects",
      "list_provider_profiles",
      "list_application_settings",
      "list_jobs",
    ],
  );
});

test("switches projects through the persisted host boundary", async () => {
  const select = document.getElementById("active-project");
  assert.ok(select instanceof HTMLSelectElement);
  await harness.runAct(async () => {
    select.value = host.state.projects.projects[1].id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle(
    () => document.body.textContent.includes("Beta project"),
    "project switch did not update the shell",
  );
  assert.equal(
    host.calls.findLast((call) => call.command === "select_saved_project")?.args.projectId,
    host.state.projects.projects[1].id,
  );
  assert.match(document.body.textContent, /Local laptop/u);
  assert.match(document.body.textContent, /laptop-default/u);
});

test("navigates to Settings and persists an enabled retention policy", async () => {
  await click(button("Settings"));
  await settle(
    () => document.body.textContent.includes("Job-history retention"),
    "settings surface did not open",
  );
  const toggle = document.querySelector(".retention-toggle input");
  assert.ok(toggle instanceof HTMLInputElement);
  await click(toggle);
  assert.equal(toggle.checked, true);
  await click(button("Save retention policy"));
  await settle(
    () => host.calls.some((call) => call.command === "save_application_settings"),
    "retention policy was not persisted",
  );
  const saved = host.calls.findLast(
    (call) => call.command === "save_application_settings",
  );
  assert.equal(saved.args.settings.jobRetention.enabled, true);
  assert.equal(saved.args.settings.jobRetention.maxTerminalJobs, 500);
  assert.equal(saved.args.settings.jobRetention.maxAgeDays, 365);
  assert.match(document.body.textContent, /Retention settings saved\./u);
});

test("stores a profile credential through the vault boundary and clears the input", async () => {
  await click(button("LLM profiles"));
  await settle(
    () => document.body.textContent.includes("Profile credential"),
    "provider credential surface did not open",
  );
  const input = document.getElementById("profile-credential");
  await enter(input, "desktop-test-secret");
  await click(button("Save to Windows vault"));
  await settle(
    () => host.calls.some((call) => call.command === "save_provider_credential"),
    "credential was not submitted to the trusted host",
  );
  assert.equal(input.value, "");
  assert.doesNotMatch(document.body.textContent, /desktop-test-secret/u);
  const saved = host.calls.findLast(
    (call) => call.command === "save_provider_credential",
  );
  assert.equal(saved.args.profileId, host.state.profiles.profiles[0].id);
  assert.equal(saved.args.secret, "desktop-test-secret");
  await settle(
    () => document.body.textContent.includes("Stored in Windows vault"),
    "vault-backed status was not refreshed",
  );
});
