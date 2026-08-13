import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Run workspace sequences through npm so npm_execpath is available");
}

const npmRun = (...args) => ({ executable: process.execPath, args: [npmCli, ...args] });
const nodeRun = (...args) => ({ executable: process.execPath, args });
const sequences = {
  build: [
    npmRun("run", "build:skills"),
    npmRun("run", "build:agent:only"),
    npmRun("run", "build", "-w", "@pimp-code/desktop"),
  ],
  "build-agent": [
    npmRun("run", "build:skills"),
    npmRun("run", "build:agent:only"),
  ],
  dev: [
    npmRun("run", "build:agent"),
    nodeRun(resolve(workspace, "scripts", "run-tauri.mjs"), "dev"),
  ],
  test: [
    npmRun("run", "test", "-w", "@pimp-code/skill-runtime"),
    npmRun("run", "test", "-w", "@pimp-code/agent-host"),
    npmRun("run", "test", "-w", "@pimp-code/desktop"),
  ],
  typecheck: [
    npmRun("run", "typecheck", "-w", "@pimp-code/skill-runtime"),
    npmRun("run", "typecheck", "-w", "@pimp-code/agent-host"),
    npmRun("run", "typecheck", "-w", "@pimp-code/desktop"),
  ],
};

const sequenceName = process.argv[2];
const steps = sequences[sequenceName];
if (!steps) {
  throw new Error(`Unknown workspace sequence: ${sequenceName ?? "<missing>"}`);
}

for (const step of steps) {
  const result = spawnSync(step.executable, step.args, {
    cwd: workspace,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Workspace step terminated by ${result.signal}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
