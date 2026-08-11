import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlanRun, type PlanRunnerDependencies } from "../src/plan-runner.js";
import type { HostEvent } from "../src/protocol.js";
import {
  CERTIFIED_PLANNING_ADAPTERS,
  PlanValidationError,
  UPGRADE_REACT_ROUTER_TO_V8_PLAN_SCHEMA_VERSION,
  UPGRADE_REACT_ROUTER_TO_V8_PLAN_V1_SCHEMA,
  buildUpgradeReactRouterToV8PlanPrompt,
  detectReactRouterV8Applicability,
  getPlanningAdapter,
  isCertifiedPlanningSkillIdentity,
  isPlanningSkillSupported,
  pathIsWithin,
  prepareUpgradeReactRouterToV8Preflight,
  renderUpgradeReactRouterToV8PlanMarkdown,
  validateUpgradeReactRouterToV8PlanV1,
  writePlanningPlanArtifacts,
  type RepositoryContextBundle,
  type UpgradeReactRouterToV8PlanV1,
  type UpgradeReactRouterToV8Preflight,
} from "../src/planning/index.js";

const ROUTER_CERTIFIED_DIGEST =
  CERTIFIED_PLANNING_ADAPTERS["upgrade-react-router-to-v8"].packageDigests[0];

interface Fixture {
  base: string;
  repository: string;
  outputRoot: string;
  preflight: UpgradeReactRouterToV8Preflight;
}

async function makeFixture(options: { version?: string; legacy?: boolean } = {}): Promise<Fixture> {
  const version = options.version ?? "5.3.4";
  const legacy = options.legacy ?? true;
  const base = await mkdtemp(join(tmpdir(), "pimp-router-planning-"));
  const repository = join(base, "logo-client");
  const outputRoot = join(base, "artifacts");
  await mkdir(join(repository, "src", "router"), { recursive: true });
  await mkdir(join(repository, "src", "features"), { recursive: true });
  await mkdir(join(repository, "tests"), { recursive: true });
  await mkdir(join(repository, ".github", "workflows"), { recursive: true });
  await mkdir(outputRoot);
  await writeFile(join(repository, "package.json"), `${JSON.stringify({
    name: "logo-client",
    scripts: { build: "vite build", test: "vitest run" },
    dependencies: { react: "^19.0.0", "react-router-dom": `^${version}` },
    devDependencies: { vite: "^7.0.0", vitest: "^3.0.0" },
  }, null, 2)}\n`);
  await writeFile(join(repository, "package-lock.json"), `${JSON.stringify({
    name: "logo-client",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "react-router-dom": `^${version}` } },
      "node_modules/react-router-dom": { version },
    },
  }, null, 2)}\n`);
  await writeFile(join(repository, "vite.config.ts"), "export default { base: '/' };\n");
  await writeFile(join(repository, "vitest.config.ts"), "export default { test: {} };\n");
  await writeFile(join(repository, "src", "index.tsx"), 'import "./router/index.js";\n');
  await writeFile(
    join(repository, "src", "features", "navigation-shell.tsx"),
    'import { useNavigate } from "react-router-dom";\nexport const NavigationShell = () => { void useNavigate; return null; };\n',
  );
  await writeFile(
    join(repository, "src", "router", "index.tsx"),
    legacy
      ? 'import { BrowserRouter, Redirect, Route, Switch, useHistory } from "react-router-dom";\nexport const Router = () => <BrowserRouter><Switch><Route component={() => null} /><Redirect to="/" /></Switch></BrowserRouter>;\nvoid useHistory;\n'
      : 'import { BrowserRouter, Route, Routes } from "react-router-dom";\nexport const Router = () => <BrowserRouter><Routes><Route path="/" element={null} /></Routes></BrowserRouter>;\n',
  );
  await writeFile(join(repository, "tests", "router.test.tsx"), 'import { Router } from "../src/router/index.js";\nvoid Router;\n');
  await writeFile(join(repository, ".github", "workflows", "deploy.yml"), "name: deploy\n");
  await writeFile(join(repository, "vercel.json"), '{"rewrites":[{"source":"/(.*)","destination":"/"}]}\n');
  const preflight = await prepareUpgradeReactRouterToV8Preflight({
    repositoryPath: repository,
    outputRoot,
    skill: {
      name: "upgrade-react-router-to-v8",
      digest: ROUTER_CERTIFIED_DIGEST,
      instructions: "Plan a React Router v8 upgrade without modifying the repository.",
    },
  });
  return { base, repository, outputRoot, preflight };
}

function planFor(preflight: UpgradeReactRouterToV8Preflight): UpgradeReactRouterToV8PlanV1 {
  const approved = preflight.context.manifest.files.map((file) => file.relativePath);
  const routerFiles = preflight.context.manifest.files
    .filter((file) => file.reason === "router-source")
    .map((file) => file.relativePath);
  const testFiles = preflight.context.manifest.files
    .filter((file) => file.reason === "test-source")
    .map((file) => file.relativePath);
  const deploymentFiles = preflight.context.manifest.files
    .filter((file) => file.reason === "deployment-config" || file.reason === "ci-workflow")
    .map((file) => file.relativePath);
  const applicable = preflight.applicability.status === "applicable";
  return {
    schemaVersion: UPGRADE_REACT_ROUTER_TO_V8_PLAN_SCHEMA_VERSION,
    title: "Upgrade React Router to v8",
    summary: "Replace legacy route APIs while preserving route and deployment behavior.",
    applicability: preflight.applicability,
    inventory: {
      routerMode: "declarative",
      currentVersions: preflight.applicability.versions,
      legacyApis: preflight.applicability.legacyApis,
      routerFiles,
      testFiles,
      deploymentFiles,
    },
    routeParity: applicable ? [{
      routePattern: "/",
      currentBehavior: "The legacy router redirects unmatched navigation to the root route.",
      proposedV8Behavior: "The v8 route tree preserves the root destination and fallback behavior.",
      evidence: [{
        relativePath: routerFiles[0] ?? "src/router/index.tsx",
        fact: "The approved route module declares the root redirect behavior.",
      }],
      risks: ["Redirect replacement must retain history semantics."],
    }] : [],
    migrationSteps: applicable ? [{
      id: "replace-legacy-routes",
      title: "Replace v5-only route APIs",
      rationale: "The approved router module contains APIs removed before v8.",
      affectedPaths: [routerFiles[0] ?? "src/router/index.tsx", "package.json"],
      evidence: [{
        relativePath: routerFiles[0] ?? "src/router/index.tsx",
        fact: "Legacy Switch and Redirect APIs are used.",
      }],
      dependsOn: [],
      actions: [
        { kind: "dependency", subject: "react-router-dom", action: "replace", description: "Upgrade the direct dependency to v8." },
        { kind: "route-api", subject: "Switch and Redirect", action: "replace", description: "Use the v8 declarative route API." },
      ],
    }] : [],
    verification: [{
      id: "route-tests",
      title: "Run route tests",
      executable: "npm",
      args: ["test", "--", "router"],
      purpose: "Confirm route matching and navigation behavior.",
      expectedOutcome: "All approved route tests pass.",
      requiresApproval: true,
    }],
    assumptions: [],
    risks: ["Redirect and navigation semantics may differ across majors."],
    followUps: [],
    filesInspected: approved,
  };
}

function syntheticContext(version?: string, legacy = false): RepositoryContextBundle {
  const documents = [
    ...(version === undefined ? [] : [{
      relativePath: "package.json",
      reason: "package-manifest" as const,
      contentKind: "text" as const,
      content: JSON.stringify({ dependencies: { "react-router-dom": version } }),
      contextSha256: "x",
    }]),
    ...(legacy ? [{
      relativePath: "src/router/index.tsx",
      reason: "router-source" as const,
      contentKind: "text" as const,
      content: 'import { Switch } from "react-router-dom"; void Switch;',
      contextSha256: "y",
    }] : []),
  ];
  return {
    documents,
    manifest: {
      schemaVersion: "repository-context-manifest/v1",
      repositoryRoot: "C:/repo",
      files: [], excluded: [], environmentVariableNames: [], scannedPathCount: 0,
      totalContextBytes: 0, manifestSha256: "z",
    },
  };
}

test("router context captures deterministic manifest, lock, source, test, config, and deploy evidence", async () => {
  const fixture = await makeFixture();
  try {
    assert.equal(fixture.preflight.applicability.status, "applicable");
    assert.ok(fixture.preflight.applicability.versions.some((item) => item.kind === "declared" && item.major === 5));
    assert.ok(fixture.preflight.applicability.versions.some((item) => item.kind === "resolved" && item.major === 5));
    assert.ok(fixture.preflight.applicability.legacyApis.includes("Switch"));
    const files = new Map(fixture.preflight.context.manifest.files.map((file) => [file.relativePath, file.reason]));
    assert.equal(files.get("package.json"), "package-manifest");
    assert.equal(files.get("package-lock.json"), "package-manager-lockfile");
    const lockDocument = fixture.preflight.context.documents.find((item) => item.relativePath === "package-lock.json");
    assert.equal(lockDocument?.contentKind, "lockfile-summary");
    assert.doesNotMatch(lockDocument?.content ?? "", /integrity|resolved.*https/iu);
    assert.doesNotThrow(() => JSON.parse(lockDocument?.content ?? ""));
    assert.equal(files.get("src/router/index.tsx"), "router-source");
    assert.equal(files.get("src/features/navigation-shell.tsx"), "router-source");
    assert.equal(files.get("tests/router.test.tsx"), "test-source");
    assert.equal(files.get("vite.config.ts"), "vite-config");
    assert.equal(files.get("vitest.config.ts"), "test-config");
    assert.equal(files.get(".github/workflows/deploy.yml"), "ci-workflow");
    assert.equal(files.get("vercel.json"), "deployment-config");
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("router applicability follows the certified version and legacy API matrix", () => {
  for (const major of [4, 5, 6, 7]) {
    assert.equal(detectReactRouterV8Applicability(syntheticContext(`^${major}.0.0`)).status, "applicable");
  }
  assert.equal(detectReactRouterV8Applicability(syntheticContext("^8.0.0")).status, "already-v8");
  assert.equal(detectReactRouterV8Applicability(syntheticContext("^8.0.0", true)).status, "applicable");
  assert.equal(detectReactRouterV8Applicability(syntheticContext(undefined, true)).status, "uncertain");
  assert.equal(detectReactRouterV8Applicability(syntheticContext()).status, "not-applicable");
});

test("router plan schema, validator, prompt, renderer, and generic artifacts stay strict", async () => {
  const fixture = await makeFixture();
  try {
    const plan = planFor(fixture.preflight);
    assert.deepEqual(validateUpgradeReactRouterToV8PlanV1(plan, fixture.preflight), plan);
    assert.equal(
      renderUpgradeReactRouterToV8PlanMarkdown(plan, fixture.preflight),
      renderUpgradeReactRouterToV8PlanMarkdown(plan, fixture.preflight),
    );
    const prompt = buildUpgradeReactRouterToV8PlanPrompt({ preflight: fixture.preflight });
    assert.match(prompt, /Do not call tools/u);
    assert.ok(!prompt.includes(fixture.preflight.repository.repositoryRoot));
    assert.equal(UPGRADE_REACT_ROUTER_TO_V8_PLAN_V1_SCHEMA.additionalProperties, false);
    assert.equal(UPGRADE_REACT_ROUTER_TO_V8_PLAN_V1_SCHEMA.properties.migrationSteps.items.additionalProperties, false);
    assert.throws(
      () => validateUpgradeReactRouterToV8PlanV1({ ...plan, unexpected: true }, fixture.preflight),
      PlanValidationError,
    );
    const unsafe = structuredClone(plan);
    unsafe.migrationSteps[0]!.evidence[0]!.relativePath = "../outside.ts";
    assert.throws(() => validateUpgradeReactRouterToV8PlanV1(unsafe, fixture.preflight), PlanValidationError);
    const adapter = getPlanningAdapter(fixture.preflight);
    assert.equal(adapter.skillName, "upgrade-react-router-to-v8");
    assert.equal(isPlanningSkillSupported("upgrade-react-router-to-v8"), true);
    assert.equal(
      isCertifiedPlanningSkillIdentity(
        "upgrade-react-router-to-v8",
        ROUTER_CERTIFIED_DIGEST,
      ),
      true,
    );
    assert.equal(
      isCertifiedPlanningSkillIdentity(
        "upgrade-react-router-to-v8",
        "0".repeat(64),
      ),
      false,
    );
    assert.equal(isPlanningSkillSupported("unknown"), false);
    const artifacts = await writePlanningPlanArtifacts({ preflight: fixture.preflight, plan, runId: "router-run" });
    assert.ok(pathIsWithin(fixture.outputRoot, artifacts.runDirectory));
    assert.match(await readFile(artifacts.planMarkdown.path, "utf8"), /^# Upgrade React Router/u);
    assert.equal(
      (JSON.parse(await readFile(artifacts.planJson.path, "utf8")) as { schemaVersion: string }).schemaVersion,
      UPGRADE_REACT_ROUTER_TO_V8_PLAN_SCHEMA_VERSION,
    );
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("non-applicable router preflights cannot carry migration steps", async () => {
  const fixture = await makeFixture({ version: "8.1.0", legacy: false });
  try {
    assert.equal(fixture.preflight.applicability.status, "already-v8");
    const plan = planFor(fixture.preflight);
    validateUpgradeReactRouterToV8PlanV1(plan, fixture.preflight);
    plan.migrationSteps.push({
      id: "unapproved-work", title: "Change routes", rationale: "No migration is applicable.",
      affectedPaths: ["src/router/index.tsx"], evidence: [], dependsOn: [],
      actions: [{ kind: "route-api", subject: "routes", action: "replace", description: "Do work anyway." }],
    });
    assert.throws(() => validateUpgradeReactRouterToV8PlanV1(plan, fixture.preflight), PlanValidationError);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("plan runner dispatches router plans while preserving the zero-tool boundary", async () => {
  const fixture = await makeFixture();
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "router-planning-test-key";
  try {
    const events: HostEvent[] = [];
    let captured: unknown;
    const fakeQuery = ((request: unknown) => {
      captured = request;
      return { async *[Symbol.asyncIterator]() {
        yield {
          type: "system", subtype: "init", claude_code_version: "test",
          model: "sonnet", tools: [],
        };
        yield {
          type: "result", subtype: "success", duration_ms: 10, num_turns: 1,
          result: "", session_id: "router-session", structured_output: planFor(fixture.preflight),
          total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 20 },
        };
      } };
    }) as unknown as NonNullable<PlanRunnerDependencies["query"]>;
    const run = startPlanRun({
      type: "start_plan",
      runId: "90b2be91-c7ea-4d62-a56f-0cecf4ef4462",
      preflightPath: join(fixture.outputRoot, "preflight.json"),
      maxTurns: 3,
      provider: { kind: "claude", model: "sonnet" },
      remoteEgressApproved: true,
    }, (event) => events.push(event), {
      query: fakeQuery,
      loadPreflight: async () => ({
        schemaVersion: "pimp.preflight-record.v1",
        id: "b3ca0ed7-a932-486c-9b0a-f4277ccb2684",
        createdAt: "2026-08-11T00:00:00.000Z",
        skillCatalogEntryId: "router-skill",
        skillPackageRoot: join(fixture.base, "skill"),
        preflight: fixture.preflight,
      }),
      assertCurrent: async () => undefined,
    });
    await run.done;
    const request = captured as { prompt: string; options: Record<string, unknown> };
    assert.match(request.prompt, /upgrade-react-router-to-v8 plan only/u);
    assert.deepEqual(request.options.tools, []);
    assert.deepEqual(request.options.allowedTools, []);
    assert.deepEqual(request.options.mcpServers, {});
    assert.deepEqual(request.options.outputFormat, { type: "json_schema", schema: UPGRADE_REACT_ROUTER_TO_V8_PLAN_V1_SCHEMA });
    const result = events.find((event) => event.type === "result");
    assert.ok(result?.type === "result" && result.success);
    const structured = typeof result.result === "object" && result.result !== null
      ? result.result
      : undefined;
    assert.equal(
      (structured?.json as { schemaVersion?: string } | undefined)?.schemaVersion,
      UPGRADE_REACT_ROUTER_TO_V8_PLAN_SCHEMA_VERSION,
    );
  } finally {
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
    await rm(fixture.base, { recursive: true, force: true });
  }
});
