use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::Mutex,
    time::{Duration, sleep},
};
use uuid::Uuid;
use zeroize::Zeroizing;

mod credential_vault;
mod jobs;
mod settings;

use credential_vault::{
    CredentialVaultState, is_vault_reference_for_profile, validate_secret, vault_reference,
};
use jobs::{
    CreateJobRequest, JobProviderKind, JobRecord, JobStore, UpdateJobSetupRequest,
    apply_job_retention, attach_preflight, begin_attempt, create_job as create_job_record,
    delete_job as delete_job_record, fail_start, load_jobs, read_job_events as load_job_events,
    read_job_result as load_job_result, reconcile_jobs, record_agent_event,
    resume_interrupted_job as resume_interrupted_job_record,
    update_job_setup as update_job_setup_record,
};
use settings::{
    ApplicationSettings, ProjectSettings, ProjectUpdateInput, ProviderProfileInput,
    ProviderProfileKind, ProviderProfileRecord, ProviderProfileSettings, add_project,
    delete_provider_profile, load_application_settings, load_projects, load_provider_profiles,
    remove_project, save_application_settings as save_application_settings_record, save_projects,
    save_provider_profiles, select_project, update_project, upsert_provider_profile,
};

const MAX_UTILITY_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_AGENT_EVENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SKILL_ROOTS: usize = 16;
const MAX_SKILL_ROOT_LENGTH: usize = 2_000;
const MAX_REPOSITORY_LENGTH: usize = 2_000;
const MAX_SKILL_ID_LENGTH: usize = 200;

#[derive(Default)]
struct AgentProcessState {
    active: Mutex<Option<ActiveAgent>>,
}

#[derive(Clone)]
struct ActiveAgent {
    cancellation_requested: Arc<AtomicBool>,
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
    #[serde(default)]
    provider_profile_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ProviderConfig {
    Claude { model: String },
    Local { model: String, endpoint: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanStartRequest {
    job_id: String,
    preflight_id: String,
    max_turns: u8,
    provider: ProviderConfig,
    remote_egress_approved: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillRootsSettings {
    version: u8,
    roots: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UtilityResponse {
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStartResponse {
    run_id: String,
}

#[derive(Clone)]
struct ResolvedCredential {
    environment_key: &'static str,
    secret: Arc<Zeroizing<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCredentialStatus {
    profile_id: String,
    source: &'static str,
    configured: bool,
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

fn host_entry_path(app: &AppHandle, entry: &str) -> Result<PathBuf, String> {
    if !matches!(entry, "cli.js" | "utility-cli.js") {
        return Err("Unknown agent-host entry point".to_string());
    }

    #[cfg(debug_assertions)]
    let _ = app;

    #[cfg(not(debug_assertions))]
    let path = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve packaged resources: {error}"))?
        .join("runtime/agent-host")
        .join(entry.replace(".js", ".mjs"));

    #[cfg(debug_assertions)]
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/agent-host/dist/src")
        .join(entry);
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

fn host_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    host_entry_path(app, "cli.js")
}

fn utility_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    host_entry_path(app, "utility-cli.js")
}

fn node_runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(PathBuf::from("node"))
    }

    #[cfg(not(debug_assertions))]
    {
        let path = app
            .path()
            .resource_dir()
            .map_err(|error| format!("Could not resolve packaged resources: {error}"))?
            .join("runtime/node.exe")
            .canonicalize()
            .map_err(|error| format!("Packaged Node runtime is unavailable: {error}"))?;
        Ok(node_compatible_path(&path))
    }
}

fn claude_runtime_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(None)
    }

    #[cfg(not(debug_assertions))]
    {
        let path = app
            .path()
            .resource_dir()
            .map_err(|error| format!("Could not resolve packaged resources: {error}"))?
            .join("runtime/claude.exe")
            .canonicalize()
            .map_err(|error| format!("Packaged Claude Code runtime is unavailable: {error}"))?;
        Ok(Some(node_compatible_path(&path)))
    }
}

fn runtime_working_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("runtime");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
    directory
        .canonicalize()
        .map(|path| node_compatible_path(&path))
        .map_err(|error| format!("Could not resolve {}: {error}", directory.display()))
}

fn minimal_environment() -> HashMap<String, String> {
    const SAFE_KEYS: [&str; 12] = [
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

fn redact_host_credentials(message: impl Into<String>) -> String {
    let mut result = message.into();
    for key in ["ANTHROPIC_API_KEY", "LOCAL_LLM_API_KEY"] {
        if let Ok(secret) = std::env::var(key)
            && !secret.is_empty()
        {
            result = result.replace(&secret, "[REDACTED]");
        }
    }
    result
}

fn sanitize_diagnostic(message: impl Into<String>) -> String {
    redact_host_credentials(message)
        .chars()
        .take(4_000)
        .collect()
}

fn sanitize_provider_text(
    message: impl Into<String>,
    credential: Option<&ResolvedCredential>,
) -> String {
    let mut result = redact_host_credentials(message);
    if let Some(credential) = credential
        && !credential.secret.is_empty()
    {
        result = result.replace(credential.secret.as_str(), "[REDACTED]");
    }
    result
}

fn sanitize_provider_diagnostic(
    message: impl Into<String>,
    credential: Option<&ResolvedCredential>,
) -> String {
    sanitize_provider_text(message, credential)
        .chars()
        .take(4_000)
        .collect()
}

fn sanitize_provider_value(value: &mut Value, credential: Option<&ResolvedCredential>) {
    match value {
        Value::String(text) => {
            *text = sanitize_provider_text(std::mem::take(text), credential);
        }
        Value::Array(values) => {
            for value in values {
                sanitize_provider_value(value, credential);
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                sanitize_provider_value(value, credential);
            }
        }
        _ => {}
    }
}

fn normalize_skill_roots(roots: Vec<String>) -> Result<Vec<String>, String> {
    if roots.len() > MAX_SKILL_ROOTS {
        return Err(format!("At most {MAX_SKILL_ROOTS} skill roots are allowed"));
    }

    let mut normalized = Vec::new();
    for root in roots {
        let value = root.trim();
        if value.is_empty() {
            continue;
        }
        if value.len() > MAX_SKILL_ROOT_LENGTH || value.chars().any(char::is_control) {
            return Err("A skill root is invalid or too long".to_string());
        }
        if !normalized
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(value))
        {
            normalized.push(value.to_string());
        }
    }
    Ok(normalized)
}

fn skill_roots_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("skill-roots.json"))
        .map_err(|error| format!("Could not resolve app configuration directory: {error}"))
}

fn project_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("projects.json"))
        .map_err(|error| format!("Could not resolve app configuration directory: {error}"))
}

fn provider_profiles_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("provider-profiles.json"))
        .map_err(|error| format!("Could not resolve app configuration directory: {error}"))
}

fn provider_environment_key(kind: ProviderProfileKind) -> &'static str {
    match kind {
        ProviderProfileKind::Claude => "ANTHROPIC_API_KEY",
        ProviderProfileKind::Local => "LOCAL_LLM_API_KEY",
    }
}

fn provider_profile(app: &AppHandle, profile_id: &str) -> Result<ProviderProfileRecord, String> {
    load_provider_profiles(&provider_profiles_settings_path(app)?)?
        .profiles
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "The selected provider profile no longer exists".to_string())
}

fn validate_provider_config(
    profile: &ProviderProfileRecord,
    provider: &ProviderConfig,
) -> Result<(), String> {
    let matches = match (&profile.kind, provider) {
        (ProviderProfileKind::Claude, ProviderConfig::Claude { .. }) => true,
        (ProviderProfileKind::Local, ProviderConfig::Local { endpoint, .. }) => {
            profile.endpoint.as_deref() == Some(endpoint.trim())
        }
        _ => false,
    };
    if matches {
        Ok(())
    } else {
        Err("The provider request does not match the selected profile".to_string())
    }
}

fn update_profile_credential_reference(
    settings: &mut ProviderProfileSettings,
    profile_id: &str,
    credential_ref: Option<String>,
) -> Result<(), String> {
    let profile = settings
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| "The selected provider profile no longer exists".to_string())?;
    upsert_provider_profile(
        settings,
        ProviderProfileInput {
            id: Some(profile.id),
            name: profile.name,
            kind: profile.kind,
            endpoint: profile.endpoint,
            default_model: profile.default_model,
            credential_ref,
        },
    )?;
    Ok(())
}

async fn resolve_provider_credential(
    app: &AppHandle,
    vault: &CredentialVaultState,
    profile_id: &str,
    provider: &ProviderConfig,
) -> Result<Option<ResolvedCredential>, String> {
    let profile = provider_profile(app, profile_id)?;
    validate_provider_config(&profile, provider)?;
    let environment_key = provider_environment_key(profile.kind);
    let Some(reference) = profile.credential_ref.as_deref() else {
        return Ok(None);
    };

    let secret = if is_vault_reference_for_profile(reference, profile_id) {
        vault
            .get(profile_id.to_string())
            .await?
            .ok_or_else(|| "The selected profile's stored credential is unavailable".to_string())?
    } else if let Some(key) = reference.strip_prefix("environment:") {
        if key != environment_key {
            return Err("The profile credential reference does not match its provider".to_string());
        }
        let Ok(secret) = std::env::var(key) else {
            return Ok(None);
        };
        if secret.is_empty() {
            return Ok(None);
        }
        validate_secret(&secret)?;
        Zeroizing::new(secret)
    } else {
        return Err("The profile credential reference is unsupported".to_string());
    };

    Ok(Some(ResolvedCredential {
        environment_key,
        secret: Arc::new(secret),
    }))
}

fn application_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("application-settings.json"))
        .map_err(|error| format!("Could not resolve app configuration directory: {error}"))
}

fn job_storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("jobs"))
        .map_err(|error| format!("Could not resolve app data directory: {error}"))
}

#[cfg(debug_assertions)]
fn development_skill_root() -> Option<String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../skills")
        .canonicalize()
        .ok()
        .filter(|path| path.is_dir())
        .map(|path| node_compatible_path(&path).to_string_lossy().into_owned())
}

#[cfg(not(debug_assertions))]
fn development_skill_root() -> Option<String> {
    None
}

fn read_skill_roots(app: &AppHandle) -> Result<Vec<String>, String> {
    let path = skill_roots_settings_path(app)?;
    if !path.exists() {
        return Ok(development_skill_root().into_iter().collect());
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if bytes.len() > 64 * 1024 {
        return Err("Skill-root settings exceed the size limit".to_string());
    }
    let settings: SkillRootsSettings = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Skill-root settings are malformed: {error}"))?;
    if settings.version != 1 {
        return Err(format!(
            "Unsupported skill-root settings version {}",
            settings.version
        ));
    }
    normalize_skill_roots(settings.roots)
}

#[tauri::command]
fn load_skill_roots(app: AppHandle) -> Result<Vec<String>, String> {
    read_skill_roots(&app)
}

#[tauri::command]
fn save_skill_roots(app: AppHandle, roots: Vec<String>) -> Result<Vec<String>, String> {
    let roots = normalize_skill_roots(roots)?;
    let path = skill_roots_settings_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Skill-root settings path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let payload = serde_json::to_vec_pretty(&SkillRootsSettings {
        version: 1,
        roots: roots.clone(),
    })
    .map_err(|error| format!("Could not encode skill-root settings: {error}"))?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, payload)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Could not replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not publish {}: {error}", path.display()))?;
    Ok(roots)
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<ProjectSettings, String> {
    load_projects(&project_settings_path(&app)?)
}

#[tauri::command]
fn add_saved_project(
    app: AppHandle,
    path: String,
    name: Option<String>,
) -> Result<ProjectSettings, String> {
    let settings_path = project_settings_path(&app)?;
    let mut settings = load_projects(&settings_path)?;
    add_project(&mut settings, path, name)?;
    save_projects(&settings_path, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn select_saved_project(app: AppHandle, project_id: String) -> Result<ProjectSettings, String> {
    let settings_path = project_settings_path(&app)?;
    let mut settings = load_projects(&settings_path)?;
    select_project(&mut settings, &project_id)?;
    save_projects(&settings_path, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn remove_saved_project(app: AppHandle, project_id: String) -> Result<ProjectSettings, String> {
    let settings_path = project_settings_path(&app)?;
    let mut settings = load_projects(&settings_path)?;
    remove_project(&mut settings, &project_id)?;
    save_projects(&settings_path, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn update_saved_project(
    app: AppHandle,
    project: ProjectUpdateInput,
) -> Result<ProjectSettings, String> {
    if let Some(profile_id) = &project.default_provider_profile_id {
        let profiles = load_provider_profiles(&provider_profiles_settings_path(&app)?)?;
        if !profiles
            .profiles
            .iter()
            .any(|profile| &profile.id == profile_id)
        {
            return Err("The selected default provider profile no longer exists".to_string());
        }
    }
    let settings_path = project_settings_path(&app)?;
    let mut settings = load_projects(&settings_path)?;
    update_project(&mut settings, project)?;
    save_projects(&settings_path, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn list_provider_profiles(app: AppHandle) -> Result<ProviderProfileSettings, String> {
    load_provider_profiles(&provider_profiles_settings_path(&app)?)
}

#[tauri::command]
async fn save_provider_profile(
    app: AppHandle,
    vault: State<'_, CredentialVaultState>,
    mut profile: ProviderProfileInput,
) -> Result<ProviderProfileSettings, String> {
    let settings_path = provider_profiles_settings_path(&app)?;
    let mut settings = load_provider_profiles(&settings_path)?;
    let existing = profile.id.as_deref().and_then(|profile_id| {
        settings
            .profiles
            .iter()
            .find(|stored| stored.id == profile_id)
            .cloned()
    });
    if let Some(reference) = profile.credential_ref.as_deref() {
        if let Some(key) = reference.strip_prefix("environment:") {
            if key != provider_environment_key(profile.kind) {
                return Err(
                    "The profile credential reference does not match its provider".to_string(),
                );
            }
        } else if reference.starts_with("vault:provider:") {
            let profile_id = profile.id.as_deref().ok_or_else(|| {
                "A new profile cannot reference a credential before it is saved".to_string()
            })?;
            if !is_vault_reference_for_profile(reference, profile_id) {
                return Err(
                    "The profile credential reference points to another profile".to_string()
                );
            }
            if existing
                .as_ref()
                .and_then(|stored| stored.credential_ref.as_deref())
                != Some(reference)
            {
                return Err(
                    "Use the dedicated credential command to create a vault reference".to_string(),
                );
            }
        } else {
            return Err("The profile credential reference is unsupported".to_string());
        }
    }
    if existing
        .as_ref()
        .is_some_and(|stored| stored.kind != profile.kind)
        && existing.as_ref().is_some_and(|stored| {
            stored
                .credential_ref
                .as_deref()
                .is_some_and(|reference| is_vault_reference_for_profile(reference, &stored.id))
        })
    {
        profile.credential_ref = None;
    }
    upsert_provider_profile(&mut settings, profile)?;
    let vault_profile_id = existing.as_ref().and_then(|stored| {
        stored
            .credential_ref
            .as_deref()
            .filter(|reference| is_vault_reference_for_profile(reference, &stored.id))
            .and_then(|old_reference| {
                settings
                    .profiles
                    .iter()
                    .find(|profile| profile.id == stored.id)
                    .filter(|profile| profile.credential_ref.as_deref() != Some(old_reference))
                    .map(|_| stored.id.clone())
            })
    });
    let previous = if let Some(profile_id) = vault_profile_id.as_ref() {
        let secret = vault.get(profile_id.clone()).await?;
        vault.delete(profile_id.clone()).await?;
        secret
    } else {
        None
    };
    if let Err(error) = save_provider_profiles(&settings_path, &settings) {
        let rollback = if let Some(profile_id) = vault_profile_id.as_deref() {
            restore_vault_credential(&vault, profile_id, previous).await
        } else {
            Ok(())
        };
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; additionally, the credential rollback failed: {rollback_error}")
            }
        });
    }
    Ok(settings)
}

#[tauri::command]
async fn provider_credential_status(
    app: AppHandle,
    vault: State<'_, CredentialVaultState>,
    profile_id: String,
) -> Result<ProviderCredentialStatus, String> {
    let profile = provider_profile(&app, &profile_id)?;
    let expected_environment_key = provider_environment_key(profile.kind);
    match profile.credential_ref.as_deref() {
        Some(reference) if is_vault_reference_for_profile(reference, &profile_id) => {
            Ok(ProviderCredentialStatus {
                profile_id: profile_id.clone(),
                source: "windowsVault",
                configured: vault.get(profile_id).await?.is_some(),
            })
        }
        Some(reference) if reference.starts_with("vault:provider:") => {
            Err("The profile credential reference points to another profile".to_string())
        }
        Some(reference) if reference.starts_with("environment:") => {
            let key = reference.trim_start_matches("environment:");
            if key != expected_environment_key {
                return Err(
                    "The profile credential reference does not match its provider".to_string(),
                );
            }
            Ok(ProviderCredentialStatus {
                profile_id,
                source: "environment",
                configured: std::env::var(key).is_ok_and(|secret| !secret.is_empty()),
            })
        }
        Some(_) => Err("The profile credential reference is unsupported".to_string()),
        None => Ok(ProviderCredentialStatus {
            profile_id,
            source: "none",
            configured: false,
        }),
    }
}

async fn restore_vault_credential(
    vault: &CredentialVaultState,
    profile_id: &str,
    previous: Option<Zeroizing<String>>,
) -> Result<(), String> {
    match previous {
        Some(secret) => vault.set(profile_id.to_string(), secret.to_string()).await,
        None => vault.delete(profile_id.to_string()).await,
    }
}

#[tauri::command]
async fn save_provider_credential(
    app: AppHandle,
    vault: State<'_, CredentialVaultState>,
    profile_id: String,
    secret: String,
) -> Result<ProviderProfileSettings, String> {
    validate_secret(&secret)?;
    let settings_path = provider_profiles_settings_path(&app)?;
    let mut settings = load_provider_profiles(&settings_path)?;
    update_profile_credential_reference(
        &mut settings,
        &profile_id,
        Some(vault_reference(&profile_id)?),
    )?;
    let previous = vault.get(profile_id.clone()).await?;
    vault.set(profile_id.clone(), secret).await?;
    if let Err(error) = save_provider_profiles(&settings_path, &settings) {
        let rollback = restore_vault_credential(&vault, &profile_id, previous).await;
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; additionally, the credential rollback failed: {rollback_error}")
            }
        });
    }
    Ok(settings)
}

#[tauri::command]
async fn delete_provider_credential(
    app: AppHandle,
    vault: State<'_, CredentialVaultState>,
    profile_id: String,
) -> Result<ProviderProfileSettings, String> {
    let settings_path = provider_profiles_settings_path(&app)?;
    let mut settings = load_provider_profiles(&settings_path)?;
    let profile = settings
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| "The selected provider profile no longer exists".to_string())?;
    update_profile_credential_reference(&mut settings, &profile_id, None)?;
    let was_vault_backed = profile
        .credential_ref
        .as_deref()
        .is_some_and(|reference| is_vault_reference_for_profile(reference, &profile_id));
    let previous = if was_vault_backed {
        let secret = vault.get(profile_id.clone()).await?;
        vault.delete(profile_id.clone()).await?;
        secret
    } else {
        None
    };
    if let Err(error) = save_provider_profiles(&settings_path, &settings) {
        let rollback = if was_vault_backed {
            restore_vault_credential(&vault, &profile_id, previous).await
        } else {
            Ok(())
        };
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; additionally, the credential rollback failed: {rollback_error}")
            }
        });
    }
    Ok(settings)
}

#[tauri::command]
async fn delete_saved_provider_profile(
    app: AppHandle,
    vault: State<'_, CredentialVaultState>,
    profile_id: String,
) -> Result<ProviderProfileSettings, String> {
    let projects = load_projects(&project_settings_path(&app)?)?;
    if projects
        .projects
        .iter()
        .any(|project| project.default_provider_profile_id.as_deref() == Some(profile_id.as_str()))
    {
        return Err(
            "This profile is a project default. Choose another project default before deleting it."
                .to_string(),
        );
    }
    let settings_path = provider_profiles_settings_path(&app)?;
    let mut settings = load_provider_profiles(&settings_path)?;
    let profile = settings
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| "Provider profile was not found".to_string())?;
    let was_vault_backed = profile
        .credential_ref
        .as_deref()
        .is_some_and(|reference| is_vault_reference_for_profile(reference, &profile_id));
    let previous = if was_vault_backed {
        let secret = vault.get(profile_id.clone()).await?;
        vault.delete(profile_id.clone()).await?;
        secret
    } else {
        None
    };
    delete_provider_profile(&mut settings, &profile_id)?;
    if let Err(error) = save_provider_profiles(&settings_path, &settings) {
        let rollback = if was_vault_backed {
            restore_vault_credential(&vault, &profile_id, previous).await
        } else {
            Ok(())
        };
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => {
                format!("{error}; additionally, the credential rollback failed: {rollback_error}")
            }
        });
    }
    Ok(settings)
}

#[tauri::command]
fn list_application_settings(app: AppHandle) -> Result<ApplicationSettings, String> {
    load_application_settings(&application_settings_path(&app)?)
}

#[tauri::command]
fn save_application_settings(
    app: AppHandle,
    settings: ApplicationSettings,
) -> Result<ApplicationSettings, String> {
    let path = application_settings_path(&app)?;
    save_application_settings_record(&path, &settings)?;
    load_application_settings(&path)
}

fn validate_job_provider_snapshot(
    app: &AppHandle,
    snapshot: &jobs::JobProviderSnapshot,
) -> Result<(), String> {
    let profiles = load_provider_profiles(&provider_profiles_settings_path(app)?)?;
    let profile = profiles
        .profiles
        .iter()
        .find(|profile| profile.id == snapshot.profile_id)
        .ok_or_else(|| "The selected provider profile no longer exists".to_string())?;
    let kind_matches = matches!(
        (&profile.kind, snapshot.kind),
        (ProviderProfileKind::Claude, JobProviderKind::Claude)
            | (ProviderProfileKind::Local, JobProviderKind::Local)
    );
    if profile.revision != snapshot.profile_revision
        || profile.name != snapshot.profile_name
        || !kind_matches
        || profile.endpoint != snapshot.endpoint
    {
        return Err("The provider profile changed; select it again before continuing".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn list_jobs(
    app: AppHandle,
    state: State<'_, AgentProcessState>,
) -> Result<JobStore, String> {
    let active_run_id = state
        .active
        .lock()
        .await
        .as_ref()
        .map(|active| active.run_id.clone());
    let root = job_storage_root(&app)?;
    let store = reconcile_jobs(&root, active_run_id.as_deref())?;
    let application_settings = load_application_settings(&application_settings_path(&app)?)?;
    if apply_job_retention(&root, &application_settings.job_retention)?.is_empty() {
        Ok(store)
    } else {
        load_jobs(&root)
    }
}

#[tauri::command]
fn create_durable_job(app: AppHandle, mut request: CreateJobRequest) -> Result<JobRecord, String> {
    let projects = load_projects(&project_settings_path(&app)?)?;
    let project = projects
        .projects
        .iter()
        .find(|project| project.id == request.project_id)
        .ok_or_else(|| "The selected project no longer exists".to_string())?;
    let expected_repository = project
        .workspace_path
        .as_ref()
        .unwrap_or(&project.canonical_path);
    if !expected_repository.eq_ignore_ascii_case(request.canonical_repository.trim()) {
        return Err("The durable job repository does not match the saved project".to_string());
    }
    if !read_skill_roots(&app)?
        .iter()
        .any(|root| root.eq_ignore_ascii_case(request.skill_root.trim()))
    {
        return Err("The selected skill root is not configured".to_string());
    }
    if let Some(provider) = &request.provider {
        validate_job_provider_snapshot(&app, provider)?;
    }
    request.project_name = project.name.clone();
    request.canonical_repository = expected_repository.clone();
    create_job_record(&job_storage_root(&app)?, request)
}

#[tauri::command]
fn update_durable_job_setup(
    app: AppHandle,
    request: UpdateJobSetupRequest,
) -> Result<JobRecord, String> {
    validate_job_provider_snapshot(&app, &request.provider)?;
    update_job_setup_record(&job_storage_root(&app)?, request)
}

#[tauri::command]
fn read_job_result(app: AppHandle, job_id: String) -> Result<Option<Value>, String> {
    load_job_result(&job_storage_root(&app)?, &job_id)
}

#[tauri::command]
fn read_job_events(app: AppHandle, job_id: String) -> Result<Vec<Value>, String> {
    load_job_events(&job_storage_root(&app)?, &job_id)
}

#[tauri::command]
fn resume_interrupted_job(app: AppHandle, job_id: String) -> Result<JobRecord, String> {
    resume_interrupted_job_record(&job_storage_root(&app)?, &job_id)
}

#[tauri::command]
fn delete_saved_job(app: AppHandle, job_id: String) -> Result<JobStore, String> {
    let root = job_storage_root(&app)?;
    delete_job_record(&root, &job_id)?;
    load_jobs(&root)
}

async fn run_agent_utility(
    app: &AppHandle,
    request: Value,
    credential: Option<ResolvedCredential>,
) -> Result<Value, String> {
    let utility_script = utility_script_path(app)?;
    let node_runtime = node_runtime_path(app)?;
    let runtime_directory = runtime_working_directory(app)?;
    let mut command = Command::new(node_runtime);
    command
        .arg(utility_script)
        .current_dir(runtime_directory)
        .env_clear()
        .envs(minimal_environment())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(credential) = credential.as_ref() {
        command.env(credential.environment_key, credential.secret.as_str());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the agent utility: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Agent utility stdin is unavailable".to_string())?;
    let encoded = serde_json::to_vec(&request)
        .map_err(|error| format!("Could not encode utility request: {error}"))?;
    stdin
        .write_all(&encoded)
        .await
        .map_err(|error| format!("Could not send utility request: {error}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("Could not wait for the agent utility: {error}"))?;
    if output.stdout.len() > MAX_UTILITY_OUTPUT_BYTES
        || output.stderr.len() > MAX_UTILITY_OUTPUT_BYTES
    {
        return Err("Agent utility output exceeded the size limit".to_string());
    }
    if !output.status.success() {
        let detail = sanitize_provider_diagnostic(
            String::from_utf8_lossy(&output.stderr),
            credential.as_ref(),
        );
        return Err(if detail.trim().is_empty() {
            format!("Agent utility exited with {}", output.status)
        } else {
            format!("Agent utility failed: {}", detail.trim())
        });
    }
    let mut response: UtilityResponse = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Agent utility returned invalid JSON: {error}"))?;
    if !response.ok {
        return Err(sanitize_provider_diagnostic(
            response
                .error
                .unwrap_or_else(|| "Agent utility failed without details".to_string()),
            credential.as_ref(),
        ));
    }
    let mut data = response
        .data
        .take()
        .ok_or_else(|| "Agent utility returned no data".to_string())?;
    sanitize_provider_value(&mut data, credential.as_ref());
    Ok(data)
}

#[tauri::command]
async fn scan_skill_catalog(app: AppHandle, roots: Vec<String>) -> Result<Value, String> {
    let roots = normalize_skill_roots(roots)?;
    run_agent_utility(
        &app,
        json!({
            "operation": "scan_skill_catalog",
            "roots": roots,
        }),
        None,
    )
    .await
}

#[tauri::command]
async fn provider_health(
    app: AppHandle,
    vault: State<'_, CredentialVaultState>,
    profile_id: String,
    provider: ProviderConfig,
) -> Result<Value, String> {
    let credential = resolve_provider_credential(&app, &vault, &profile_id, &provider).await?;
    run_agent_utility(
        &app,
        json!({
            "operation": "provider_health",
            "provider": provider,
        }),
        credential,
    )
    .await
}

fn prepare_plan_utility_request(
    repository: &str,
    skill_id: &str,
    skill_root: &str,
    configured_roots: &[String],
    preflight_root: &Path,
) -> Value {
    json!({
        "operation": "prepare_plan",
        "repository": repository.trim(),
        "skillId": skill_id.trim(),
        "skillRoot": skill_root.trim(),
        "configuredRoots": configured_roots,
        "preflightRoot": node_compatible_path(preflight_root).to_string_lossy(),
    })
}

#[tauri::command]
async fn prepare_plan(
    app: AppHandle,
    repository: String,
    skill_id: String,
    skill_root: String,
    job_id: Option<String>,
) -> Result<Value, String> {
    if repository.trim().is_empty()
        || repository.len() > MAX_REPOSITORY_LENGTH
        || repository.chars().any(char::is_control)
    {
        return Err("The repository path is invalid or too long".to_string());
    }
    let configured_roots = read_skill_roots(&app)?;
    if !configured_roots
        .iter()
        .any(|root| root.eq_ignore_ascii_case(skill_root.trim()))
    {
        return Err("The selected skill root is not configured".to_string());
    }
    if skill_id.trim().is_empty()
        || skill_id.len() > MAX_SKILL_ID_LENGTH
        || skill_id.chars().any(char::is_control)
    {
        return Err("The selected skill ID is invalid".to_string());
    }
    let preflight_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("preflights");
    fs::create_dir_all(&preflight_root).map_err(|error| {
        format!(
            "Could not create preflight storage at {}: {error}",
            preflight_root.display()
        )
    })?;
    let request = prepare_plan_utility_request(
        &repository,
        &skill_id,
        &skill_root,
        &configured_roots,
        &preflight_root,
    );
    let preflight = run_agent_utility(&app, request, None).await?;
    if let Some(job_id) = job_id {
        attach_preflight(&job_storage_root(&app)?, &job_id, &preflight)?;
    }
    Ok(preflight)
}

fn emit_agent_event(app: &AppHandle, job_id: Option<&str>, event: Value) {
    if let Some(job_id) = job_id
        && let Ok(root) = job_storage_root(app)
        && let Err(error) = record_agent_event(&root, job_id, &event)
    {
        let run_id = event
            .get("runId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let _ = app.emit(
            "agent-event",
            json!({
                "type": "diagnostic",
                "runId": run_id,
                "level": "error",
                "message": sanitize_diagnostic(format!("Could not persist job history: {error}"))
            }),
        );
    }
    let _ = app.emit("agent-event", event);
}

fn emit_diagnostic(
    app: &AppHandle,
    run_id: &str,
    level: &str,
    message: impl Into<String>,
    job_id: Option<&str>,
) {
    emit_agent_event(
        app,
        job_id,
        json!({
            "type": "diagnostic",
            "runId": run_id,
            "level": level,
            "message": sanitize_diagnostic(message)
        }),
    );
}

fn emit_host_exit_result(
    app: &AppHandle,
    run_id: &str,
    cancelled: bool,
    message: impl Into<String>,
    job_id: Option<&str>,
) {
    emit_agent_event(
        app,
        job_id,
        json!({
            "type": "result",
            "runId": run_id,
            "success": false,
            "cancelled": cancelled,
            "error": sanitize_diagnostic(message)
        }),
    );
}

fn validate_agent_event(event: Value, expected_run_id: &str) -> Result<Value, String> {
    let object = event
        .as_object()
        .ok_or_else(|| "Agent event must be an object".to_string())?;
    if object.get("runId").and_then(Value::as_str) != Some(expected_run_id) {
        return Err("Agent event run ID does not match the active run".to_string());
    }
    let event_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent event type is missing".to_string())?;
    let require_string = |key: &str, maximum: usize| -> Result<&str, String> {
        let value = object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Agent {event_type} event field {key} must be a string"))?;
        if value.len() > maximum {
            return Err(format!("Agent {event_type} event field {key} is too long"));
        }
        Ok(value)
    };
    match event_type {
        "status" => {
            require_string("phase", 200)?;
            require_string("message", 4_000)?;
            if object
                .get("details")
                .is_some_and(|value| !value.is_object())
            {
                return Err("Agent status details must be an object".to_string());
            }
        }
        "text_delta" => {
            require_string("text", 1024 * 1024)?;
        }
        "tool_call" => {
            require_string("name", 200)?;
            if !object.contains_key("input") {
                return Err("Agent tool_call event is missing input".to_string());
            }
        }
        "diagnostic" => {
            require_string("message", 4_000)?;
            if !matches!(
                object.get("level").and_then(Value::as_str),
                Some("info" | "warning" | "error")
            ) {
                return Err("Agent diagnostic level is invalid".to_string());
            }
        }
        "result" => {
            if !object.get("success").is_some_and(Value::is_boolean)
                || !object.get("cancelled").is_some_and(Value::is_boolean)
            {
                return Err("Agent result flags must be booleans".to_string());
            }
            if object.get("error").is_some_and(|value| !value.is_string()) {
                return Err("Agent result error must be a string".to_string());
            }
            if let Some(result) = object.get("result")
                && !result.is_string()
                && !result.is_object()
            {
                return Err("Agent result payload must be text or an object".to_string());
            }
        }
        _ => return Err(format!("Unknown agent event type: {event_type}")),
    }
    Ok(event)
}

async fn clear_active_run(app: &AppHandle, run_id: &str) {
    let state = app.state::<AgentProcessState>();
    let mut active = state.active.lock().await;
    if active.as_ref().is_some_and(|agent| agent.run_id == run_id) {
        *active = None;
    }
}

async fn spawn_agent_host(
    app: AppHandle,
    state: State<'_, AgentProcessState>,
    run_id: String,
    start_message: Value,
    credential: Option<ResolvedCredential>,
    job_id: Option<String>,
) -> Result<AgentStartResponse, String> {
    let mut active_guard = state.active.lock().await;
    if let Some(active) = active_guard.as_ref() {
        return Err(format!("Run {} is already active", active.run_id));
    }

    let host_script = host_script_path(&app)?;
    let node_runtime = node_runtime_path(&app)?;
    let claude_runtime = claude_runtime_path(&app)?;
    let runtime_directory = runtime_working_directory(&app)?;
    let mut command = Command::new(node_runtime);
    command
        .arg(host_script)
        .current_dir(runtime_directory)
        .env_clear()
        .envs(minimal_environment())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(credential) = credential.as_ref() {
        command.env(credential.environment_key, credential.secret.as_str());
    }
    if let Some(path) = claude_runtime {
        command.env("PIMP_CLAUDE_CODE_PATH", path);
    }

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

    let cancellation_requested = Arc::new(AtomicBool::new(false));
    *active_guard = Some(ActiveAgent {
        cancellation_requested: cancellation_requested.clone(),
        run_id: run_id.clone(),
        stdin: Arc::new(Mutex::new(child_stdin)),
        pid,
    });
    drop(active_guard);

    let stdout_app = app.clone();
    let stdout_run_id = run_id.clone();
    let stdout_job_id = job_id.clone();
    let stdout_credential = credential.clone();
    let terminal_result_seen = Arc::new(AtomicBool::new(false));
    let stdout_terminal_result_seen = terminal_result_seen.clone();
    let stdout_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) if line.len() > MAX_AGENT_EVENT_BYTES => emit_diagnostic(
                    &stdout_app,
                    &stdout_run_id,
                    "error",
                    "Rejected oversized agent event",
                    stdout_job_id.as_deref(),
                ),
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line)
                    .map_err(|error| error.to_string())
                    .and_then(|event| validate_agent_event(event, &stdout_run_id))
                {
                    Ok(mut event) => {
                        sanitize_provider_value(&mut event, stdout_credential.as_ref());
                        if event.get("type").and_then(Value::as_str) == Some("result") {
                            stdout_terminal_result_seen.store(true, Ordering::Release);
                        }
                        emit_agent_event(&stdout_app, stdout_job_id.as_deref(), event);
                    }
                    Err(error) => emit_diagnostic(
                        &stdout_app,
                        &stdout_run_id,
                        "warning",
                        format!("Rejected agent event: {error}"),
                        stdout_job_id.as_deref(),
                    ),
                },
                Ok(None) => break,
                Err(error) => {
                    emit_diagnostic(
                        &stdout_app,
                        &stdout_run_id,
                        "error",
                        format!("Agent stdout failed: {error}"),
                        stdout_job_id.as_deref(),
                    );
                    break;
                }
            }
        }
    });

    let stderr_app = app.clone();
    let stderr_run_id = run_id.clone();
    let stderr_job_id = job_id.clone();
    let stderr_credential = credential;
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                emit_diagnostic(
                    &stderr_app,
                    &stderr_run_id,
                    "warning",
                    sanitize_provider_text(line, stderr_credential.as_ref()),
                    stderr_job_id.as_deref(),
                );
            }
        }
    });

    let wait_app = app.clone();
    let wait_run_id = run_id.clone();
    let wait_job_id = job_id;
    tauri::async_runtime::spawn(async move {
        let exit = child.wait().await;
        let _ = stdout_task.await;
        if !terminal_result_seen.load(Ordering::Acquire) {
            let detail = match exit {
                Ok(status) => format!("Agent host exited with {status} before a terminal result"),
                Err(error) => format!("Could not wait for agent host: {error}"),
            };
            emit_host_exit_result(
                &wait_app,
                &wait_run_id,
                cancellation_requested.load(Ordering::Acquire),
                detail,
                wait_job_id.as_deref(),
            );
        }
        clear_active_run(&wait_app, &wait_run_id).await;
    });

    Ok(AgentStartResponse { run_id })
}

#[tauri::command]
async fn start_agent(
    app: AppHandle,
    state: State<'_, AgentProcessState>,
    vault: State<'_, CredentialVaultState>,
    request: AgentStartRequest,
) -> Result<AgentStartResponse, String> {
    if request.cwd.trim().is_empty() || request.prompt.trim().is_empty() {
        return Err("Repository path and prompt are required".to_string());
    }
    if !(1..=20).contains(&request.max_turns) {
        return Err("maxTurns must be between 1 and 20".to_string());
    }
    let credential = match request.provider_profile_id.as_deref() {
        Some(profile_id) => {
            resolve_provider_credential(&app, &vault, profile_id, &request.provider).await?
        }
        None => None,
    };

    let run_id = Uuid::new_v4().to_string();
    let start_message = json!({
        "type": "start",
        "runId": run_id,
        "cwd": request.cwd,
        "prompt": request.prompt,
        "maxTurns": request.max_turns,
        "provider": request.provider,
    });

    spawn_agent_host(app, state, run_id, start_message, credential, None).await
}

#[tauri::command]
async fn start_plan(
    app: AppHandle,
    state: State<'_, AgentProcessState>,
    vault: State<'_, CredentialVaultState>,
    request: PlanStartRequest,
) -> Result<AgentStartResponse, String> {
    let parsed_preflight_id = Uuid::parse_str(request.preflight_id.trim())
        .map_err(|_| "preflightId must be a UUID".to_string())?;
    if parsed_preflight_id.to_string() != request.preflight_id.trim().to_lowercase() {
        return Err("preflightId must use canonical UUID form".to_string());
    }
    if !(1..=20).contains(&request.max_turns) {
        return Err("maxTurns must be between 1 and 20".to_string());
    }
    let (model, job_provider_kind) = match &request.provider {
        ProviderConfig::Claude { model } => (model.trim().to_string(), JobProviderKind::Claude),
        ProviderConfig::Local { model, .. } => (model.trim().to_string(), JobProviderKind::Local),
    };
    if model.is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        return Err("A valid provider model is required".to_string());
    }
    if matches!(&request.provider, ProviderConfig::Claude { .. }) && !request.remote_egress_approved
    {
        return Err("Explicit remote-egress approval is required for Claude".to_string());
    }

    let preflight_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("preflights")
        .canonicalize()
        .map_err(|error| format!("Preflight storage is unavailable: {error}"))?;
    let preflight_path = preflight_root
        .join(parsed_preflight_id.to_string())
        .join("preflight.json")
        .canonicalize()
        .map_err(|error| format!("Prepared context is unavailable: {error}"))?;
    if !preflight_path.starts_with(&preflight_root) || !preflight_path.is_file() {
        return Err("Prepared context path is invalid".to_string());
    }

    let run_id = Uuid::new_v4().to_string();
    let jobs_root = job_storage_root(&app)?;
    let provider_snapshot = load_jobs(&jobs_root)?
        .jobs
        .into_iter()
        .find(|job| job.id == request.job_id)
        .and_then(|job| job.provider)
        .ok_or_else(|| "Job does not have a provider snapshot".to_string())?;
    validate_job_provider_snapshot(&app, &provider_snapshot)?;
    let credential = resolve_provider_credential(
        &app,
        &vault,
        &provider_snapshot.profile_id,
        &request.provider,
    )
    .await?;
    begin_attempt(
        &jobs_root,
        &request.job_id,
        &run_id,
        &request.preflight_id,
        job_provider_kind,
        &model,
        request.max_turns,
    )?;
    let start_message = json!({
        "type": "start_plan",
        "runId": run_id,
        "preflightPath": node_compatible_path(&preflight_path).to_string_lossy(),
        "maxTurns": request.max_turns,
        "provider": request.provider,
        "remoteEgressApproved": request.remote_egress_approved,
    });
    let job_id = request.job_id;
    match spawn_agent_host(
        app,
        state,
        run_id.clone(),
        start_message,
        credential,
        Some(job_id.clone()),
    )
    .await
    {
        Ok(response) => Ok(response),
        Err(error) => {
            let _ = fail_start(&jobs_root, &job_id, &run_id, &error);
            Err(error)
        }
    }
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

    active.cancellation_requested.store(true, Ordering::Release);

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
    let credential_vault = CredentialVaultState::native()
        .expect("the operating-system credential vault must be available");
    tauri::Builder::default()
        .manage(AgentProcessState::default())
        .manage(credential_vault)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_skill_roots,
            save_skill_roots,
            list_projects,
            add_saved_project,
            select_saved_project,
            remove_saved_project,
            update_saved_project,
            list_provider_profiles,
            save_provider_profile,
            provider_credential_status,
            save_provider_credential,
            delete_provider_credential,
            delete_saved_provider_profile,
            list_application_settings,
            save_application_settings,
            list_jobs,
            create_durable_job,
            update_durable_job_setup,
            read_job_result,
            read_job_events,
            resume_interrupted_job,
            delete_saved_job,
            scan_skill_catalog,
            prepare_plan,
            provider_health,
            start_agent,
            start_plan,
            cancel_agent,
            agent_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{
        ResolvedCredential, minimal_environment, node_compatible_path,
        prepare_plan_utility_request, sanitize_provider_value,
    };
    use serde_json::json;
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
    };
    use zeroize::Zeroizing;

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

    #[test]
    fn prepare_plan_utility_request_uses_generic_contract() {
        let configured_roots = vec![r"C:\workspace\skills".to_string()];
        let request = prepare_plan_utility_request(
            r" C:\workspace\repository ",
            " skill-entry-id ",
            r" C:\workspace\skills ",
            &configured_roots,
            Path::new(r"C:\app-data\preflights"),
        );

        assert_eq!(request["operation"], "prepare_plan");
        assert_eq!(request["repository"], r"C:\workspace\repository");
        assert_eq!(request["skillId"], "skill-entry-id");
        assert_eq!(request["skillRoot"], r"C:\workspace\skills");
        assert_eq!(request["configuredRoots"], json!(configured_roots));
        assert_eq!(request["preflightRoot"], r"C:\app-data\preflights");
    }

    #[test]
    fn base_child_environment_excludes_all_provider_credentials() {
        let environment = minimal_environment();
        assert!(!environment.contains_key("ANTHROPIC_API_KEY"));
        assert!(!environment.contains_key("LOCAL_LLM_API_KEY"));
    }

    #[test]
    fn provider_output_redaction_preserves_non_secret_payloads() {
        let credential = ResolvedCredential {
            environment_key: "LOCAL_LLM_API_KEY",
            secret: Arc::new(Zeroizing::new("vault-secret-fixture".to_string())),
        };
        let mut value = json!({
            "result": format!("{}vault-secret-fixture-tail", "a".repeat(5_000)),
            "nested": ["vault-secret-fixture"]
        });
        sanitize_provider_value(&mut value, Some(&credential));
        let result = value["result"].as_str().expect("redacted result");
        assert!(result.ends_with("[REDACTED]-tail"));
        assert!(result.len() > 5_000);
        assert_eq!(value["nested"][0], "[REDACTED]");
    }
}
