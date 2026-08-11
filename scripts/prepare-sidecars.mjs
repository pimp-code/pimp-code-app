import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(scriptsDirectory, "..");
const runtimeRoot = join(
  workspace,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "runtime",
);
const cacheRoot = join(workspace, ".runtime-cache");
const lock = JSON.parse(
  await readFile(join(scriptsDirectory, "runtime-lock.json"), "utf8"),
);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The current sidecar preparation script supports Windows x64 only");
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function verify(path, expected, label) {
  const actual = await sha256(path);
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, received ${actual}`);
  }
  return actual;
}

async function download(url, destination, expectedSha256, label) {
  try {
    await verify(destination, expectedSha256, label);
    return;
  } catch {
    // A missing or stale cache entry is replaced only after the new bytes verify.
  }

  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`${label} download failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 200 * 1024 * 1024) {
    throw new Error(`${label} download exceeds the size limit`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 200 * 1024 * 1024) {
    throw new Error(`${label} download exceeds the size limit`);
  }
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await verify(temporary, expectedSha256, label);
  await copyFile(temporary, destination);
  await unlink(temporary);
}

await mkdir(cacheRoot, { recursive: true });
await mkdir(join(runtimeRoot, "agent-host"), { recursive: true });
await mkdir(join(runtimeRoot, "licenses"), { recursive: true });

const cachedNode = join(cacheRoot, `node-v${lock.node.version}-win-x64.exe`);
await download(
  lock.node.windowsX64.url,
  cachedNode,
  lock.node.windowsX64.sha256,
  `Node ${lock.node.version}`,
);
const nodeDestination = join(runtimeRoot, "node.exe");
await copyFile(cachedNode, nodeDestination);

const sdkDirectory = join(
  workspace,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
);
const platformDirectory = join(
  workspace,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk-win32-x64",
);
const sdkPackage = JSON.parse(
  await readFile(join(sdkDirectory, "package.json"), "utf8"),
);
const sdkManifest = JSON.parse(
  await readFile(join(sdkDirectory, "manifest.json"), "utf8"),
);
if (
  sdkPackage.version !== lock.claudeCode.sdkVersion ||
  sdkPackage.claudeCodeVersion !== lock.claudeCode.binaryVersion
) {
  throw new Error("Installed Claude Agent SDK does not match scripts/runtime-lock.json");
}
const claudeSource = join(platformDirectory, "claude.exe");
await verify(
  claudeSource,
  lock.claudeCode.windowsX64Sha256,
  `Claude Code ${lock.claudeCode.binaryVersion}`,
);
if (
  sdkManifest.platforms?.["win32-x64"]?.checksum !==
  lock.claudeCode.windowsX64Sha256
) {
  throw new Error("Claude SDK manifest checksum does not match the runtime lock");
}
const claudeDestination = join(runtimeRoot, "claude.exe");
await copyFile(claudeSource, claudeDestination);

const bundleOptions = {
  banner: {
    js: 'import { createRequire as __pimpCreateRequire } from "node:module"; const require = __pimpCreateRequire(import.meta.url);',
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info",
};
await build({
  ...bundleOptions,
  entryPoints: [join(workspace, "packages", "agent-host", "dist", "src", "cli.js")],
  outfile: join(runtimeRoot, "agent-host", "cli.mjs"),
});
await build({
  ...bundleOptions,
  entryPoints: [
    join(workspace, "packages", "agent-host", "dist", "src", "utility-cli.js"),
  ],
  outfile: join(runtimeRoot, "agent-host", "utility-cli.mjs"),
});

await copyFile(
  join(platformDirectory, "LICENSE.md"),
  join(runtimeRoot, "licenses", "claude-code-LICENSE.md"),
);
await copyFile(
  join(sdkDirectory, "LICENSE.md"),
  join(runtimeRoot, "licenses", "claude-agent-sdk-LICENSE.md"),
);
const nodeLicenseDestination = join(runtimeRoot, "licenses", "node-LICENSE.txt");
const cachedNodeLicense = join(cacheRoot, `node-v${lock.node.version}-LICENSE.txt`);
try {
  await verify(nodeLicenseDestination, lock.node.licenseSha256, "Node license");
  await copyFile(nodeLicenseDestination, cachedNodeLicense);
} catch {
  // A clean checkout has no prepared license to seed the cache from.
}
await download(
  lock.node.licenseUrl,
  cachedNodeLicense,
  lock.node.licenseSha256,
  `Node ${lock.node.version} license`,
);
await copyFile(cachedNodeLicense, nodeLicenseDestination);

const artifacts = {};
for (const relativePath of [
  "node.exe",
  "claude.exe",
  "agent-host/cli.mjs",
  "agent-host/utility-cli.mjs",
  "licenses/node-LICENSE.txt",
  "licenses/claude-code-LICENSE.md",
  "licenses/claude-agent-sdk-LICENSE.md",
]) {
  const path = join(runtimeRoot, relativePath);
  artifacts[relativePath] = {
    bytes: (await stat(path)).size,
    sha256: await sha256(path),
  };
}
await writeFile(
  join(runtimeRoot, "runtime-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      platform: "windows-x64",
      nodeVersion: lock.node.version,
      claudeAgentSdkVersion: lock.claudeCode.sdkVersion,
      claudeCodeVersion: lock.claudeCode.binaryVersion,
      artifacts,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(`Prepared pinned sidecars in ${runtimeRoot}\n`);
