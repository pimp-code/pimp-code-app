use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::Mutex,
    time::{Duration, sleep},
};
use uuid::Uuid;

#[derive(Default)]
struct AgentProcessState {
    active: Mutex<Option<ActiveAgent>>,
}

#[derive(Clone)]
struct ActiveAgent {
    run_id: String,
    stdin: Arc<Mutex<ChildStdin>>,
    pid: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStartRequest {
    cwd: String,
    prompt: String,
    max_turns: u8,
    provider: ProviderConfig,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ProviderConfig {
    Claude { model: String },
    Local { model: String, endpoint: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStartResponse {
    run_id: String,
}

#[cfg(target_os = "windows")]
fn node_compatible_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();

    if let Some(unc_path) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc_path}"))
    } else if let Some(drive_path) = value.strip_prefix(r"\\?\") {
        PathBuf::from(drive_path)
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(target_os = "windows"))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn host_script_path() -> Result<PathBuf, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/agent-host/dist/src/cli.js");
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Agent host is not built at {}: {error}", path.display()))?;

    if !canonical.is_file() {
        return Err(format!(
            "Agent host path is not a file: {}",
            canonical.display()
        ));
    }

    // Windows canonicalization returns a verbatim path (`\\?\C:\...`). Node 26
    // cannot use that form for its main script and resolves it as the `C:` directory.
    Ok(node_compatible_path(&canonical))
}

fn minimal_environment() -> HashMap<String, String> {
    const SAFE_KEYS: [&str; 14] = [
        "ANTHROPIC_API_KEY",
        "APPDATA",
        "COMSPEC",
        "HOME",
        "LOCALAPPDATA",
        "LOCAL_LLM_API_KEY",
        "PATH",
        "PATHEXT",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
    ];

    SAFE_KEYS
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| ((*key).to_string(), value))
        })
        .collect()
}

fn emit_diagnostic(app: &AppHandle, run_id: &str, level: &str, message: impl Into<String>) {
    let _ = app.emit(
        "agent-event",
        json!({
            "type": "diagnostic",
            "runId": run_id,
            "level": level,
            "message": message.into().chars().take(4_000).collect::<String>()
        }),
    );
}

async fn clear_active_run(app: &AppHandle, run_id: &str) {
    let state = app.state::<AgentProcessState>();
    let mut active = state.active.lock().await;
    if active.as_ref().is_some_and(|agent| agent.run_id == run_id) {
        *active = None;
    }
}

#[tauri::command]
async fn start_agent(
    app: AppHandle,
    state: State<'_, AgentProcessState>,
    request: AgentStartRequest,
) -> Result<AgentStartResponse, String> {
    if request.cwd.trim().is_empty() || request.prompt.trim().is_empty() {
        return Err("Repository path and prompt are required".to_string());
    }
    if !(1..=20).contains(&request.max_turns) {
        return Err("maxTurns must be between 1 and 20".to_string());
    }

    let mut active_guard = state.active.lock().await;
    if let Some(active) = active_guard.as_ref() {
        return Err(format!("Run {} is already active", active.run_id));
    }

    let host_script = host_script_path()?;
    let run_id = Uuid::new_v4().to_string();
    let start_message = json!({
        "type": "start",
        "runId": run_id,
        "cwd": request.cwd,
        "prompt": request.prompt,
        "maxTurns": request.max_turns,
        "provider": request.provider,
    });

    let mut command = Command::new("node");
    command
        .arg(host_script)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env_clear()
        .envs(minimal_environment())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the agent host: {error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "Agent host has no process ID".to_string())?;
    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Agent host stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Agent host stdout is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Agent host stderr is unavailable".to_string())?;

    child_stdin
        .write_all(format!("{start_message}\n").as_bytes())
        .await
        .map_err(|error| format!("Could not send start command: {error}"))?;
    child_stdin
        .flush()
        .await
        .map_err(|error| format!("Could not flush start command: {error}"))?;

    *active_guard = Some(ActiveAgent {
        run_id: run_id.clone(),
        stdin: Arc::new(Mutex::new(child_stdin)),
        pid,
    });
    drop(active_guard);

    let stdout_app = app.clone();
    let stdout_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(event) => {
                        let _ = stdout_app.emit("agent-event", event);
                    }
                    Err(error) => emit_diagnostic(
                        &stdout_app,
                        &stdout_run_id,
                        "warning",
                        format!("Agent emitted invalid JSON: {error}"),
                    ),
                },
                Ok(None) => break,
                Err(error) => {
                    emit_diagnostic(
                        &stdout_app,
                        &stdout_run_id,
                        "error",
                        format!("Agent stdout failed: {error}"),
                    );
                    break;
                }
            }
        }
    });

    let stderr_app = app.clone();
    let stderr_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                emit_diagnostic(&stderr_app, &stderr_run_id, "warning", line);
            }
        }
    });

    let wait_app = app.clone();
    let wait_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        match child.wait().await {
            Ok(status) if !status.success() => emit_diagnostic(
                &wait_app,
                &wait_run_id,
                "error",
                format!("Agent host exited with {status}"),
            ),
            Err(error) => emit_diagnostic(
                &wait_app,
                &wait_run_id,
                "error",
                format!("Could not wait for agent host: {error}"),
            ),
            _ => {}
        }
        clear_active_run(&wait_app, &wait_run_id).await;
    });

    Ok(AgentStartResponse { run_id })
}

#[cfg(target_os = "windows")]
async fn force_kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

#[cfg(not(target_os = "windows"))]
async fn force_kill_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

#[tauri::command]
async fn cancel_agent(
    app: AppHandle,
    state: State<'_, AgentProcessState>,
    run_id: String,
) -> Result<(), String> {
    let active = {
        let guard = state.active.lock().await;
        guard
            .as_ref()
            .filter(|agent| agent.run_id == run_id)
            .cloned()
    }
    .ok_or_else(|| "The requested run is not active".to_string())?;

    {
        let mut stdin = active.stdin.lock().await;
        stdin
            .write_all(format!("{}\n", json!({ "type": "cancel", "runId": run_id })).as_bytes())
            .await
            .map_err(|error| format!("Could not request cancellation: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush cancellation: {error}"))?;
    }

    tauri::async_runtime::spawn(async move {
        sleep(Duration::from_secs(5)).await;
        let still_active = {
            let state = app.state::<AgentProcessState>();
            let guard = state.active.lock().await;
            guard.as_ref().is_some_and(|agent| agent.run_id == run_id)
        };
        if still_active {
            force_kill_tree(active.pid).await;
            clear_active_run(&app, &run_id).await;
        }
    });

    Ok(())
}

#[tauri::command]
async fn agent_status(state: State<'_, AgentProcessState>) -> Result<Option<String>, String> {
    Ok(state
        .active
        .lock()
        .await
        .as_ref()
        .map(|agent| agent.run_id.clone()))
}

pub fn run() {
    tauri::Builder::default()
        .manage(AgentProcessState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            start_agent,
            cancel_agent,
            agent_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::node_compatible_path;
    use std::path::{Path, PathBuf};

    #[test]
    fn converts_windows_verbatim_paths_for_node() {
        assert_eq!(
            node_compatible_path(Path::new(r"\\?\C:\workspace\agent-host\cli.js")),
            PathBuf::from(r"C:\workspace\agent-host\cli.js")
        );
        assert_eq!(
            node_compatible_path(Path::new(r"\\?\UNC\server\share\agent-host\cli.js")),
            PathBuf::from(r"\\server\share\agent-host\cli.js")
        );
    }

    #[test]
    fn preserves_regular_windows_paths() {
        let path = Path::new(r"C:\workspace\agent-host\cli.js");
        assert_eq!(node_compatible_path(path), path);
    }
}
