import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

const [mode, ...tauriArgs] = process.argv.slice(2);
if (mode !== "dev" && mode !== "build") {
  throw new Error("Usage: node scripts/run-tauri.mjs <dev|build> [tauri arguments]");
}

const cargoBin = join(homedir(), ".cargo", "bin");
const repositoryRoot = process.cwd();
const tauriCli = join(
  repositoryRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const child = spawn(
  process.execPath,
  [tauriCli, mode, ...tauriArgs],
  {
    cwd: join(repositoryRoot, "apps", "desktop"),
    env: {
      ...process.env,
      PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Tauri terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
