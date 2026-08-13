import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";

process.env.WDIO_LOG_LEVEL ??= "error";
const {
  cleanupWdioSession,
  createTauriCapabilities,
  startWdioSession,
} = await import("@wdio/tauri-service");

const workspace = resolve(import.meta.dirname, "..");
const systemTempRoot = tmpdir();
const originalTempEnvironment = {
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};
const smokeTarget = join(
  workspace,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "restart-smoke",
);
const smokeBinary = join(smokeTarget, "release", "pimp-code-desktop.exe");
const smokeIdentifierPrefix = "dev.pimpcode.desktop.restartsmoke.run";
const secretMarker = "pimp-smoke-vault-";
const waitTimeout = 30_000;
const requiredRuntimeArtifacts = [
  "agent-host/cli.mjs",
  "agent-host/utility-cli.mjs",
  "claude.exe",
  "licenses/claude-agent-sdk-LICENSE.md",
  "licenses/claude-code-LICENSE.md",
  "licenses/node-LICENSE.txt",
  "node.exe",
];
const tauriDriverVersion = "2.0.6";
const tauriDriverRoot = join(
  workspace,
  ".runtime-cache",
  "tauri-driver",
  tauriDriverVersion,
);
const tauriDriverBinary = join(tauriDriverRoot, "bin", "tauri-driver.exe");
const smokeLockPath = join(workspace, ".runtime-cache", "desktop-restart-smoke.lock");

if (process.platform !== "win32") {
  throw new Error("The desktop restart smoke requires Windows Credential Manager");
}

const roamingRoot = process.env.APPDATA;
const localRoot = process.env.LOCALAPPDATA;
const npmCli = process.env.npm_execpath;
if (!roamingRoot || !localRoot) {
  throw new Error("APPDATA and LOCALAPPDATA must be available");
}
if (!npmCli) {
  throw new Error("Run the desktop restart smoke through npm");
}

const runSuffix = randomBytes(6).toString("hex");
const appIdentifier = `${smokeIdentifierPrefix}${runSuffix}`;
const roamingAppData = join(roamingRoot, appIdentifier);
const localAppData = join(localRoot, appIdentifier);
const credentialProfileId = randomUUID();
const credentialTarget = `PimpCode/provider/${credentialProfileId}`;

let fixtureRoot;
let toolTempRoot;
let activeBrowser;
let smokeLockHandle;

function runChecked(label, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: workspace,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} terminated by ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status ?? "unknown"}`);
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function acquireSmokeLock() {
  await mkdir(dirname(smokeLockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      smokeLockHandle = await open(smokeLockPath, "wx");
      await smokeLockHandle.writeFile(`${process.pid}\n`);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number.parseInt(await readFile(smokeLockPath, "utf8"), 10);
      if (attempt === 0 && Number.isInteger(owner) && !processIsRunning(owner)) {
        await rm(smokeLockPath, { force: true });
        continue;
      }
      throw new Error(`Another desktop restart smoke owns ${smokeLockPath}`);
    }
  }
}

async function releaseSmokeLock() {
  if (!smokeLockHandle) return;
  const handle = smokeLockHandle;
  smokeLockHandle = undefined;
  await handle.close();
  await rm(smokeLockPath, { force: true });
}

function assertExactChild(root, target, expectedName) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  assert.equal(dirname(resolvedTarget), resolvedRoot);
  assert.equal(basename(resolvedTarget), expectedName);
}

function assertDescendant(root, target, expectedPrefix) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const pathFromRoot = relative(resolvedRoot, resolvedTarget);
  assert.ok(pathFromRoot && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
  assert.ok(basename(resolvedTarget).startsWith(expectedPrefix));
}

async function removeOwnedPaths() {
  assert.ok(appIdentifier.startsWith(smokeIdentifierPrefix));
  assertExactChild(roamingRoot, roamingAppData, appIdentifier);
  assertExactChild(localRoot, localAppData, appIdentifier);
  const removalOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  await rm(roamingAppData, removalOptions);
  await rm(localAppData, removalOptions);
  if (fixtureRoot) {
    assertDescendant(systemTempRoot, fixtureRoot, "pimp-code-restart-smoke-");
    await rm(fixtureRoot, removalOptions);
  }
}

function restoreTempEnvironment() {
  for (const [key, value] of Object.entries(originalTempEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function credentialTargetExists() {
  const result = spawnSync("cmdkey.exe", ["/list"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect Windows Credential Manager (status ${result.status})`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes(credentialTarget);
}

function deleteSmokeCredential() {
  if (!credentialTargetExists()) return;
  const result = spawnSync("cmdkey.exe", [`/delete:${credentialTarget}`], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (credentialTargetExists()) {
    throw new Error(`Could not remove the owned smoke credential target ${credentialTarget}`);
  }
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function ownedProcessCommand(executablePath, processName, action) {
  const binary = powershellLiteral(resolve(executablePath));
  const operation =
    action === "stop"
      ? "$matches | Stop-Process -Force -ErrorAction Stop; Write-Output $matches.Count"
      : "Write-Output $matches.Count";
  return [
    "$target = [IO.Path]::GetFullPath(" + binary + ")",
    `$matches = @(Get-Process -Name ${powershellLiteral(processName)} -ErrorAction SilentlyContinue | ForEach-Object {`,
    "  try {",
    "    if ($_.Path -and [String]::Equals([IO.Path]::GetFullPath($_.Path), $target, [StringComparison]::OrdinalIgnoreCase)) { $_ }",
    "  } catch {}",
    "})",
    operation,
  ].join("; ");
}

function ownedProcessCount(executablePath, processName) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ownedProcessCommand(executablePath, processName, "count"),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect the owned ${processName} process (status ${result.status})`);
  }
  const count = Number.parseInt((result.stdout ?? "").trim(), 10);
  if (!Number.isInteger(count)) {
    throw new Error(`Could not parse the owned ${processName} process count`);
  }
  return count;
}

function smokeProcessCount() {
  return ownedProcessCount(smokeBinary, "pimp-code-desktop");
}

async function waitForSmokeProcessExit() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (smokeProcessCount() === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error("The smoke release process did not exit after WebDriver cleanup");
}

function terminateOwnedProcesses(executablePath, processName) {
  if (ownedProcessCount(executablePath, processName) === 0) return false;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ownedProcessCommand(executablePath, processName, "stop"),
    ],
    { stdio: "ignore", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || ownedProcessCount(executablePath, processName) !== 0) {
    throw new Error(`Could not terminate the exact owned ${processName} process`);
  }
  return true;
}

function terminateSmokeProcesses() {
  return terminateOwnedProcesses(smokeBinary, "pimp-code-desktop");
}

function terminateTauriDriverProcesses() {
  return terminateOwnedProcesses(tauriDriverBinary, "tauri-driver");
}

async function terminateOwnedEdgeDriverProcesses() {
  if (!toolTempRoot) return;
  const edgeDriverRoot = join(toolTempRoot, "msedgedriver");
  if (!(await pathExists(edgeDriverRoot))) return;
  assertExactChild(toolTempRoot, edgeDriverRoot, "msedgedriver");
  const entries = await readdir(edgeDriverRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(edgeDriverRoot, entry.name);
    const name = basename(directory);
    assert.match(name, /^\d+-[0-9a-f]{16}$/);
    assertExactChild(edgeDriverRoot, directory, name);
    terminateOwnedProcesses(join(directory, "msedgedriver.exe"), "msedgedriver");
  }
}

async function installPinnedTauriDriver() {
  if (!(await pathExists(tauriDriverBinary))) {
    const cargo = join(homedir(), ".cargo", "bin", "cargo.exe");
    assert.ok(await pathExists(cargo), `Missing Cargo executable: ${cargo}`);
    await mkdir(tauriDriverRoot, { recursive: true });
    runChecked(
      "pinned tauri-driver installation",
      cargo,
      [
        "install",
        "--locked",
        "--version",
        tauriDriverVersion,
        "--root",
        tauriDriverRoot,
        "tauri-driver",
      ],
      {
        env: {
          ...process.env,
          CARGO_TARGET_DIR: join(workspace, ".runtime-cache", "tauri-driver-build"),
        },
      },
    );
  }
  assert.ok(await pathExists(tauriDriverBinary), "Pinned tauri-driver was not installed");
  const driverDirectory = dirname(tauriDriverBinary);
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  if (!pathEntries.some((entry) => entry.toLowerCase() === driverDirectory.toLowerCase())) {
    process.env.PATH = `${driverDirectory}${delimiter}${process.env.PATH ?? ""}`;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assertContainedPath(root, path) {
  const pathFromRoot = relative(resolve(root), resolve(path));
  assert.ok(pathFromRoot && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

async function verifyReleasePayload() {
  const binary = await readFile(smokeBinary);
  assert.ok(binary.includes(Buffer.from(appIdentifier)), "The release binary lacks its smoke identifier");
  assert.ok(
    binary.includes(Buffer.from("Pimp Code Restart Smoke")),
    "The release binary lacks its smoke product name",
  );

  const runtimeRoot = join(dirname(smokeBinary), "runtime");
  const manifestPath = join(runtimeRoot, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.artifacts && typeof manifest.artifacts === "object");
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), requiredRuntimeArtifacts);
  for (const [relativePath, expected] of Object.entries(manifest.artifacts)) {
    const artifactPath = join(runtimeRoot, ...relativePath.split("/"));
    assertContainedPath(runtimeRoot, artifactPath);
    const metadata = await stat(artifactPath);
    assert.equal(metadata.size, expected.bytes, `Unexpected size for ${relativePath}`);
    assert.equal(await sha256File(artifactPath), expected.sha256, `Hash mismatch for ${relativePath}`);
  }
}

async function buildReleaseBinary() {
  const configOverride = JSON.stringify({
    productName: "Pimp Code Restart Smoke",
    identifier: appIdentifier,
  });
  runChecked("agent-host build", process.execPath, [npmCli, "run", "build:agent"]);
  runChecked("sidecar preparation", process.execPath, [
    npmCli,
    "run",
    "prepare:sidecars",
  ]);
  runChecked(
    "isolated Tauri release build",
    process.execPath,
    [
      join(workspace, "scripts", "run-tauri.mjs"),
      "build",
      "--no-bundle",
      "--config",
      configOverride,
    ],
    {
      env: {
        ...process.env,
        CARGO_TARGET_DIR: smokeTarget,
      },
    },
  );
  assert.ok(await pathExists(smokeBinary), `Missing release binary: ${smokeBinary}`);
  await verifyReleasePayload();
}

async function seedSettings() {
  assert.equal(await pathExists(roamingAppData), false, "Smoke roaming data already exists");
  assert.equal(await pathExists(localAppData), false, "Smoke local data already exists");

  fixtureRoot = await mkdtemp(join(systemTempRoot, "pimp-code-restart-smoke-"));
  toolTempRoot = join(fixtureRoot, "tool-temp");
  assertExactChild(fixtureRoot, toolTempRoot, "tool-temp");
  await mkdir(toolTempRoot);
  process.env.TEMP = toolTempRoot;
  process.env.TMP = toolTempRoot;
  const alphaRoot = join(fixtureRoot, "alpha-project");
  const betaRoot = join(fixtureRoot, "beta-project");
  await mkdir(alphaRoot);
  await mkdir(betaRoot);
  const [alphaCanonicalPath, betaCanonicalPath] = await Promise.all([
    realpath(alphaRoot),
    realpath(betaRoot),
  ]);

  const alphaProjectId = randomUUID();
  const betaProjectId = randomUUID();
  const alphaProfileId = randomUUID();
  const timestamp = Date.now();
  const fixture = {
    alphaProjectId,
    betaProjectId,
    alphaProfileId,
    betaProfileId: credentialProfileId,
    alphaProjectName: "Restart Smoke Alpha",
    betaProjectName: "Restart Smoke Beta",
    alphaProfileName: "Restart Smoke Local",
    betaProfileName: "Restart Smoke Claude",
    alphaModel: "restart-local-model",
    betaModel: "restart-claude-model",
  };

  const projects = {
    version: 1,
    activeProjectId: alphaProjectId,
    projects: [
      {
        id: alphaProjectId,
        name: fixture.alphaProjectName,
        configuredPath: alphaCanonicalPath,
        canonicalPath: alphaCanonicalPath,
        workspacePath: null,
        defaultProviderProfileId: alphaProfileId,
        defaultModel: fixture.alphaModel,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      },
      {
        id: betaProjectId,
        name: fixture.betaProjectName,
        configuredPath: betaCanonicalPath,
        canonicalPath: betaCanonicalPath,
        workspacePath: null,
        defaultProviderProfileId: credentialProfileId,
        defaultModel: fixture.betaModel,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      },
    ],
  };
  const profiles = {
    version: 1,
    profiles: [
      {
        id: alphaProfileId,
        name: fixture.alphaProfileName,
        kind: "local",
        endpoint: "http://127.0.0.1:1234/v1",
        defaultModel: fixture.alphaModel,
        credentialRef: null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: credentialProfileId,
        name: fixture.betaProfileName,
        kind: "claude",
        endpoint: null,
        defaultModel: fixture.betaModel,
        credentialRef: null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };

  await mkdir(roamingAppData, { recursive: true });
  await Promise.all([
    writeFile(join(roamingAppData, "projects.json"), `${JSON.stringify(projects, null, 2)}\n`),
    writeFile(
      join(roamingAppData, "provider-profiles.json"),
      `${JSON.stringify(profiles, null, 2)}\n`,
    ),
  ]);
  return fixture;
}

async function startSession() {
  const capabilities = createTauriCapabilities(smokeBinary, {
    driverProvider: "external",
    autoInstallTauriDriver: false,
    logLevel: "error",
    commandTimeout: waitTimeout,
    startTimeout: 120_000,
  });
  capabilities["wdio:tauriServiceOptions"] = {
    ...capabilities["wdio:tauriServiceOptions"],
    tauriDriverPath: tauriDriverBinary,
  };
  return startWdioSession(capabilities, {
    rootDir: workspace,
    driverProvider: "external",
    autoInstallTauriDriver: false,
    autoDownloadEdgeDriver: true,
    logLevel: "error",
  });
}

async function waitUntil(browser, condition, message) {
  await browser.waitUntil(condition, {
    timeout: waitTimeout,
    interval: 150,
    timeoutMsg: message,
  });
}

async function bodyContains(browser, expected) {
  const text = await (await browser.$("body")).getText();
  return expected.every((value) => text.includes(value));
}

async function waitForBody(browser, expected, label) {
  await waitUntil(
    browser,
    () => bodyContains(browser, expected),
    `Timed out waiting for ${label}`,
  );
}

async function clickButton(browser, label) {
  const button = await browser.$(`button=${label}`);
  await button.waitForClickable({ timeout: waitTimeout });
  await button.click();
}

async function assertProjectSelector(browser, selectedId, fixture) {
  const projectSelector = await browser.$("#active-project");
  await projectSelector.waitForExist({ timeout: waitTimeout });
  await waitUntil(
    browser,
    async () => (await projectSelector.getValue()) === selectedId,
    "Timed out waiting for the active project",
  );
  const optionLabels = await browser.execute(() =>
    [...document.querySelectorAll("#active-project option")].map(
      (option) => option.textContent?.trim() ?? "",
    ),
  );
  assert.deepEqual(
    optionLabels,
    [fixture.alphaProjectName, fixture.betaProjectName],
  );
}

async function assertSelectedProfile(browser, profileName) {
  await waitUntil(
    browser,
    async () => {
      const selected = await browser.$('[aria-label="Saved LLM profiles"] button.selected');
      return (await selected.isExisting()) && (await selected.getText()).includes(profileName);
    },
    `Timed out waiting for ${profileName} to be selected`,
  );
  const profileButtonCount = await browser.execute(
    () => document.querySelectorAll('section[aria-label="Saved LLM profiles"] button').length,
  );
  assert.equal(profileButtonCount, 2);
}

async function waitForCredentialStatus(browser, status) {
  let lastStatus = "<missing>";
  try {
    await waitUntil(
      browser,
      async () => {
        lastStatus = await browser.execute(
          () => document.querySelector(".credential-status-row span")?.textContent?.trim() ?? "<missing>",
        );
        return lastStatus === status;
      },
      `Timed out waiting for credential status: ${status}`,
    );
  } catch (error) {
    throw new Error(
      `Timed out waiting for credential status ${JSON.stringify(status)}; last observed ${JSON.stringify(lastStatus)}`,
      { cause: error },
    );
  }
}

async function assertRendererHasNoCredential(browser) {
  const safe = await browser.execute((marker) => {
    const html = document.documentElement.innerHTML;
    const values = [...document.querySelectorAll("input")].map((input) => input.value);
    return !html.includes(marker) && values.every((value) => !value.includes(marker));
  }, secretMarker);
  assert.equal(safe, true, "The renderer retained the smoke credential marker");
}

async function submitCredentialWithoutReturningIt(browser) {
  const submitted = await browser.execute((marker) => {
    const input = document.querySelector("#profile-credential");
    const button = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Save to Windows vault"),
    );
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) {
      return false;
    }
    const random = new Uint8Array(24);
    crypto.getRandomValues(random);
    input.value = `${marker}${[...random]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
    button.click();
    return true;
  }, secretMarker);
  assert.equal(submitted, true, "Could not submit the smoke credential");
}

async function inspectPersistedState(fixture, expectedCredentialRef, expectedRevision) {
  const [projects, profiles] = await Promise.all([
    readFile(join(roamingAppData, "projects.json"), "utf8").then(JSON.parse),
    readFile(join(roamingAppData, "provider-profiles.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(projects.projects.length, 2);
  assert.equal(projects.activeProjectId, fixture.betaProjectId);
  assert.equal(profiles.profiles.length, 2);
  const profile = profiles.profiles.find((item) => item.id === fixture.betaProfileId);
  assert.ok(profile, "The credential-backed profile was not persisted");
  assert.equal(profile.credentialRef, expectedCredentialRef);
  assert.equal(profile.revision, expectedRevision);
}

async function assertNoMarkerInDirectory(root) {
  if (!(await pathExists(root))) return;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const marker = Buffer.from(secretMarker);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    let overlap = Buffer.alloc(0);
    for await (const chunk of createReadStream(path)) {
      const window = Buffer.concat([overlap, chunk]);
      assert.equal(window.includes(marker), false, `Credential marker leaked into ${path}`);
      overlap = window.subarray(Math.max(0, window.length - marker.length + 1));
    }
  }
}

async function assertNoCredentialMarkerOnDisk() {
  await assertNoMarkerInDirectory(roamingAppData);
  await assertNoMarkerInDirectory(localAppData);
}

async function closeActiveSession() {
  const browser = activeBrowser;
  if (!browser) return;
  activeBrowser = undefined;
  await cleanupWdioSession(browser);
  await waitForSmokeProcessExit();
  terminateTauriDriverProcesses();
}

async function firstLaunch(fixture) {
  activeBrowser = await startSession();
  try {
    await assertProjectSelector(activeBrowser, fixture.alphaProjectId, fixture);
    await waitForBody(
      activeBrowser,
      [fixture.alphaProjectName, fixture.alphaProfileName, fixture.alphaModel],
      "the first saved project",
    );

    await (await activeBrowser.$("#active-project")).selectByAttribute(
      "value",
      fixture.betaProjectId,
    );
    await assertProjectSelector(activeBrowser, fixture.betaProjectId, fixture);
    await waitForBody(
      activeBrowser,
      [fixture.betaProjectName, fixture.betaProfileName, fixture.betaModel],
      "the switched project",
    );

    await clickButton(activeBrowser, "LLM profiles");
    await waitForBody(activeBrowser, ["LLM profiles"], "provider-profile management");
    await assertSelectedProfile(activeBrowser, fixture.betaProfileName);
    await waitForCredentialStatus(activeBrowser, "Not configured");
    await submitCredentialWithoutReturningIt(activeBrowser);
    await waitForCredentialStatus(activeBrowser, "Stored in Windows vault");
    await waitForBody(
      activeBrowser,
      ["Credential saved in Windows Credential Manager."],
      "the credential-save notice",
    );
    assert.equal(await (await activeBrowser.$("#profile-credential")).getValue(), "");
    await assertRendererHasNoCredential(activeBrowser);
  } finally {
    await closeActiveSession();
  }
}

async function secondLaunch(fixture) {
  activeBrowser = await startSession();
  try {
    await assertProjectSelector(activeBrowser, fixture.betaProjectId, fixture);
    await waitForBody(
      activeBrowser,
      [fixture.betaProjectName, fixture.betaProfileName, fixture.betaModel],
      "the restored project",
    );
    await clickButton(activeBrowser, "LLM profiles");
    await assertSelectedProfile(activeBrowser, fixture.betaProfileName);
    await waitForCredentialStatus(activeBrowser, "Stored in Windows vault");
    assert.equal(await (await activeBrowser.$("#profile-credential")).getValue(), "");
    await assertRendererHasNoCredential(activeBrowser);

    await activeBrowser.execute(() => {
      window.confirm = () => true;
    });
    await clickButton(activeBrowser, "Remove credential");
    await waitForCredentialStatus(activeBrowser, "Not configured");
    await waitForBody(activeBrowser, ["Profile credential removed."], "the removal notice");
    await assertRendererHasNoCredential(activeBrowser);
  } finally {
    await closeActiveSession();
  }
}

async function runSmoke() {
  await acquireSmokeLock();
  await installPinnedTauriDriver();
  await buildReleaseBinary();
  const fixture = await seedSettings();
  await firstLaunch(fixture);
  await inspectPersistedState(
    fixture,
    `vault:provider:${fixture.betaProfileId}`,
    2,
  );
  await assertNoCredentialMarkerOnDisk();
  await secondLaunch(fixture);
  await inspectPersistedState(fixture, null, 3);
  assert.equal(
    credentialTargetExists(),
    false,
    "The UI cleared its vault reference without deleting the Windows credential",
  );
  await assertNoCredentialMarkerOnDisk();
  console.log(
    "Desktop release restart smoke passed: two projects, two profiles, active selection, and Windows-vault presence survived a fresh process.",
  );
}

async function cleanupOwnedState() {
  const errors = [];
  const ownsSmokeLock = Boolean(smokeLockHandle);
  if (activeBrowser) {
    try {
      await closeActiveSession();
    } catch (error) {
      errors.push(error);
    }
  }
  if (ownsSmokeLock) {
    try {
      terminateTauriDriverProcesses();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (terminateSmokeProcesses()) {
        errors.push(new Error("The owned smoke release process required forced termination"));
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await terminateOwnedEdgeDriverProcesses();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    deleteSmokeCredential();
  } catch (error) {
    errors.push(error);
  }
  restoreTempEnvironment();
  try {
    await removeOwnedPaths();
  } catch (error) {
    errors.push(error);
  }
  try {
    await releaseSmokeLock();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

let primaryError;
try {
  await runSmoke();
} catch (error) {
  primaryError = error;
}
const cleanupErrors = await cleanupOwnedState();
if (primaryError && cleanupErrors.length > 0) {
  throw new AggregateError(
    [primaryError, ...cleanupErrors],
    "Desktop restart smoke failed and cleanup also reported errors",
  );
}
if (primaryError) throw primaryError;
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "Desktop restart smoke cleanup failed");
}
