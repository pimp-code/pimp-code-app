# Tauri + Claude Code runtime spike

This spike validates a local Tauri shell driving the official Claude Agent SDK through a separate TypeScript process.

## What works

- Tauri 2 shell with a React/TypeScript renderer.
- Rust-owned lifecycle for exactly one agent-host process.
- JSONL process protocol and normalized status, text, tool, diagnostic, and result events.
- Claude API profile using `ANTHROPIC_API_KEY` from the host environment.
- Local compatibility profile using the same Claude Code binary through an in-process Anthropic Messages to OpenAI Chat Completions bridge. This is a transitional runtime adapter, not the universal backend or native LM Studio/Ollama support.
- Loopback-only local endpoints.
- Read-only `plan` mode with only `Read`, `Glob`, and `Grep` exposed.
- User cancellation through `AbortController`, with a five-second Windows process-tree kill fallback.
- Non-essential Claude Code telemetry, error reporting, feedback, auto-memory, project settings, and marketplace auto-install disabled for the run.

## Intentional limitations

- This is a feasibility spike, not the secure repository executor described in `PROJECT_PLAN.md`.
- Claude Code's built-in `Read`, `Glob`, and `Grep` tools are read-only but are not yet constrained to an immutable approved file manifest. Use only non-sensitive fixtures until the engine-owned context snapshot replaces direct repository tools.
- The bridge implements the protocol subset needed by the current test. It does not promise parity with Claude features such as thinking blocks, prompt caching, image blocks, or every tool-streaming edge case.
- A local model must support the OpenAI Chat Completions API and should support tool calling. A successful connection does not prove that the model can follow long skills safely.
- Only loopback endpoints (`localhost`, `127.0.0.1`, or `::1`) are accepted.
- The current release executable is not self-contained. It still launches system Node and the built agent-host JavaScript from this workspace. Packaging Node/the host/Claude binary as Tauri sidecars is the next spike gate.
- The Claude API path has not been live-tested without a user-provided API key.
- No real local model was available at `127.0.0.1:1234` during implementation. The full local path is covered with a controlled fake OpenAI-compatible server and the real bundled Claude Code binary.

## Run the desktop spike

Requirements:

- Node 24 or 26.
- Rust stable MSVC toolchain under the standard `.cargo/bin` location.
- Microsoft C++ Build Tools and WebView2.

Install dependencies and run:

```powershell
npm.cmd install
npm.cmd run dev
```

The launcher adds the standard Rust toolchain directory to the child `PATH`; it does not modify the user's system environment.

### Claude profile

Set the API key only in the process environment, then start the app:

```powershell
$env:ANTHROPIC_API_KEY = "your-api-key"
npm.cmd run dev
```

Select **Claude API**, use a Claude Code model alias such as `sonnet`, choose a repository, and start a plan-only run. Do not put the API key into the UI or a repository file.

### LM Studio or another local OpenAI-compatible server

1. Start the local server and load a model with reliable tool-call support.
2. Obtain the exact model ID from the server's `/v1/models` response.
3. Run the app without `ANTHROPIC_API_KEY`.
4. Select **Local LLM**.
5. Enter the exact model ID and a loopback base URL such as `http://127.0.0.1:1234/v1`.

If the local server needs a key, set it as `LOCAL_LLM_API_KEY` in the app process environment. The key is forwarded only to the configured loopback endpoint.

For Ollama's OpenAI-compatible API, use the loopback `/v1` endpoint exposed by the Ollama server and the exact installed model name.

## Verification

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build:desktop
```

The tests include a real Claude Agent SDK/Claude Code binary invocation against a controlled local OpenAI-compatible test server. No cloud model is called by that test.

## Next decision gate

Before treating Tauri as the product shell:

1. Run one live Claude API plan against a non-sensitive fixture repository.
2. Run one live LM Studio or Ollama plan with a tool-capable local model.
3. Verify cancellation while each model is generating.
4. Package the agent host and platform Claude Code binary so the installed app needs neither system Node nor workspace files.
5. Observe outbound traffic and confirm the promised local-only mode.
6. Keep `PROJECT_PLAN.md` aligned with the selected Tauri architecture while recording any unmet release gates explicitly.
