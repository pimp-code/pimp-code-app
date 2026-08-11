import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Run the desktop release build through npm so npm_execpath is available");
}

const steps = [
  { label: "agent-host build", args: [npmCli, "run", "build:agent"] },
  { label: "sidecar preparation", args: [npmCli, "run", "prepare:sidecars"] },
  {
    label: "Tauri release build",
    args: [resolve(workspace, "scripts", "run-tauri.mjs"), "build"],
  },
];

for (const step of steps) {
  const result = spawnSync(process.execPath, step.args, {
    cwd: workspace,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`${step.label} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
