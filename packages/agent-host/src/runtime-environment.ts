import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

const SAFE_ENV_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
] as const;

function configuredExecutable(variable: string, label: string): string | undefined {
  const executable = process.env[variable];
  if (!executable) return undefined;
  if (!isAbsolute(executable) || !statSync(executable).isFile()) {
    throw new Error(`The packaged ${label} executable path is invalid`);
  }
  return executable;
}

export function configuredClaudeExecutable(): string | undefined {
  return configuredExecutable("PIMP_CLAUDE_CODE_PATH", "Claude Code");
}

export function configuredCodexExecutable(): string | undefined {
  return configuredExecutable("PIMP_CODEX_PATH", "Codex");
}

export function buildBaseEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export function buildClaudeEnvironment(): Record<string, string | undefined> {
  return {
    ...buildBaseEnvironment(),
    CLAUDE_AGENT_SDK_CLIENT_APP: "pimp-code-tauri-spike/0.0.0",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
  };
}

export function redactDiagnostic(value: string): string {
  let redacted = value;
  for (const secret of [
    process.env.ANTHROPIC_API_KEY,
    process.env.LOCAL_LLM_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.CODEX_API_KEY,
  ]) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.slice(0, 4_000);
}
