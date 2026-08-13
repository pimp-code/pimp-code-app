use crate::settings::{JobRetentionSettings, read_versioned, write_versioned};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const JOB_STORE_VERSION: u8 = 1;
const MAX_JOBS: usize = 10_000;
const MAX_ATTEMPTS: usize = 100;
const MAX_EVENTS: usize = 20_000;
const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESULT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEXT: usize = 2_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobRunMode {
    Plan,
    Apply,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobApprovalMode {
    Guided,
    Continuous,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Draft,
    Ready,
    Planning,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Blocked,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobProviderKind {
    Claude,
    Local,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobProviderSnapshot {
    pub profile_id: String,
    pub profile_revision: u32,
    pub profile_name: String,
    pub kind: JobProviderKind,
    pub endpoint: Option<String>,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobAttempt {
    pub run_id: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub outcome: Option<JobStatus>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub canonical_repository: String,
    pub skill_id: String,
    pub skill_name: String,
    pub skill_digest: String,
    pub skill_root: String,
    pub provider: Option<JobProviderSnapshot>,
    pub run_mode: JobRunMode,
    pub approval_mode: JobApprovalMode,
    pub max_turns: u8,
    pub status: JobStatus,
    pub current_stage: String,
    pub preflight_id: Option<String>,
    pub active_run_id: Option<String>,
    pub attempts: Vec<JobAttempt>,
    pub result_path: Option<String>,
    pub artifact_paths: Vec<String>,
    pub last_error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobStore {
    pub version: u8,
    pub jobs: Vec<JobRecord>,
}

impl Default for JobStore {
    fn default() -> Self {
        Self {
            version: JOB_STORE_VERSION,
            jobs: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJobRequest {
    pub project_id: String,
    pub project_name: String,
    pub canonical_repository: String,
    pub skill_id: String,
    pub skill_name: String,
    pub skill_digest: String,
    pub skill_root: String,
    pub provider: Option<JobProviderSnapshot>,
    pub run_mode: JobRunMode,
    pub approval_mode: JobApprovalMode,
    pub max_turns: u8,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateJobSetupRequest {
    pub job_id: String,
    pub provider: JobProviderSnapshot,
    pub run_mode: JobRunMode,
    pub approval_mode: JobApprovalMode,
    pub max_turns: u8,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn validate_text(value: &str, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_TEXT || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid or too long"));
    }
    Ok(())
}

fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(value).map_err(|_| format!("{label} is invalid"))?;
    if parsed.to_string() != value.to_ascii_lowercase() {
        return Err(format!("{label} must use canonical UUID form"));
    }
    Ok(())
}

fn validate_provider(provider: &JobProviderSnapshot) -> Result<(), String> {
    validate_uuid(&provider.profile_id, "Provider-profile ID")?;
    validate_text(&provider.profile_name, "Provider-profile name")?;
    validate_text(&provider.model, "Provider model")?;
    if provider.profile_revision == 0 {
        return Err("Provider-profile revision must be positive".to_string());
    }
    match provider.kind {
        JobProviderKind::Local => validate_text(
            provider.endpoint.as_deref().unwrap_or_default(),
            "Local provider endpoint",
        ),
        JobProviderKind::Claude if provider.endpoint.is_some() => {
            Err("Claude job snapshots cannot contain a custom endpoint".to_string())
        }
        JobProviderKind::Claude => Ok(()),
    }
}

fn validate_store(store: JobStore) -> Result<JobStore, String> {
    if store.version != JOB_STORE_VERSION {
        return Err(format!("Unsupported job-store version {}", store.version));
    }
    if store.jobs.len() > MAX_JOBS {
        return Err(format!("Job history exceeds the {MAX_JOBS}-job limit"));
    }
    let mut ids = HashSet::new();
    for job in &store.jobs {
        validate_uuid(&job.id, "Job ID")?;
        validate_uuid(&job.project_id, "Project ID")?;
        validate_text(&job.project_name, "Project name")?;
        validate_text(&job.canonical_repository, "Canonical repository")?;
        validate_text(&job.skill_id, "Skill ID")?;
        validate_text(&job.skill_name, "Skill name")?;
        validate_text(&job.skill_digest, "Skill digest")?;
        validate_text(&job.skill_root, "Skill root")?;
        if let Some(provider) = &job.provider {
            validate_provider(provider)?;
        }
        if !(1..=20).contains(&job.max_turns) {
            return Err("Job maxTurns must be between 1 and 20".to_string());
        }
        if job.attempts.len() > MAX_ATTEMPTS {
            return Err("Job attempt history exceeds the limit".to_string());
        }
        if !ids.insert(job.id.clone()) {
            return Err("Job history contains a duplicate ID".to_string());
        }
    }
    Ok(store)
}

fn index_path(root: &Path) -> PathBuf {
    root.join("index.json")
}

fn job_directory(root: &Path, job_id: &str) -> Result<PathBuf, String> {
    validate_uuid(job_id, "Job ID")?;
    let directory = root.join(job_id);
    if directory.exists()
        && fs::symlink_metadata(&directory)
            .map_err(|error| format!("Could not inspect job directory: {error}"))?
            .file_type()
            .is_symlink()
    {
        return Err("Job directory cannot be a symbolic link".to_string());
    }
    Ok(directory)
}

pub fn load_jobs(root: &Path) -> Result<JobStore, String> {
    let mut store = validate_store(read_versioned(&index_path(root), "Job")?)?;
    store.jobs.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
    Ok(store)
}

pub fn reconcile_jobs(root: &Path, active_run_id: Option<&str>) -> Result<JobStore, String> {
    let mut store = load_jobs(root)?;
    let mut changed = false;
    let timestamp = now_millis();
    for job in &mut store.jobs {
        if job.status == JobStatus::Planning && job.active_run_id.as_deref() != active_run_id {
            if let Some(run_id) = job.active_run_id.take()
                && let Some(attempt) = job
                    .attempts
                    .iter_mut()
                    .rev()
                    .find(|attempt| attempt.run_id == run_id)
            {
                attempt.finished_at = Some(timestamp);
                attempt.outcome = Some(JobStatus::Interrupted);
            }
            job.status = JobStatus::Interrupted;
            job.current_stage = "interrupted".to_string();
            job.last_error = Some(
                "The desktop host restarted before this attempt produced a terminal result."
                    .to_string(),
            );
            job.updated_at = timestamp;
            changed = true;
        }
    }
    if changed {
        save_jobs(root, &store)?;
    }
    store
        .jobs
        .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(store)
}

fn save_jobs(root: &Path, store: &JobStore) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("Could not create job storage: {error}"))?;
    validate_store(store.clone())?;
    write_versioned(&index_path(root), store)
}

pub fn create_job(root: &Path, request: CreateJobRequest) -> Result<JobRecord, String> {
    if request.run_mode != JobRunMode::Plan {
        return Err("Apply jobs are not certified by the current engine".to_string());
    }
    validate_uuid(&request.project_id, "Project ID")?;
    validate_text(&request.project_name, "Project name")?;
    validate_text(&request.canonical_repository, "Canonical repository")?;
    validate_text(&request.skill_id, "Skill ID")?;
    validate_text(&request.skill_name, "Skill name")?;
    validate_text(&request.skill_digest, "Skill digest")?;
    validate_text(&request.skill_root, "Skill root")?;
    if let Some(provider) = &request.provider {
        validate_provider(provider)?;
    }
    if !(1..=20).contains(&request.max_turns) {
        return Err("Job maxTurns must be between 1 and 20".to_string());
    }
    let mut store = load_jobs(root)?;
    if store.jobs.len() >= MAX_JOBS {
        return Err(format!("Job history reached the {MAX_JOBS}-job limit"));
    }
    let timestamp = now_millis();
    let job = JobRecord {
        id: Uuid::new_v4().to_string(),
        project_id: request.project_id,
        project_name: request.project_name.trim().to_string(),
        canonical_repository: request.canonical_repository.trim().to_string(),
        skill_id: request.skill_id.trim().to_string(),
        skill_name: request.skill_name.trim().to_string(),
        skill_digest: request.skill_digest.trim().to_string(),
        skill_root: request.skill_root.trim().to_string(),
        provider: request.provider,
        run_mode: request.run_mode,
        approval_mode: request.approval_mode,
        max_turns: request.max_turns,
        status: JobStatus::Draft,
        current_stage: "setup".to_string(),
        preflight_id: None,
        active_run_id: None,
        attempts: Vec::new(),
        result_path: None,
        artifact_paths: Vec::new(),
        last_error: None,
        created_at: timestamp,
        updated_at: timestamp,
    };
    fs::create_dir_all(job_directory(root, &job.id)?)
        .map_err(|error| format!("Could not create job directory: {error}"))?;
    store.jobs.push(job.clone());
    save_jobs(root, &store)?;
    Ok(job)
}

pub fn update_job_setup(root: &Path, request: UpdateJobSetupRequest) -> Result<JobRecord, String> {
    if request.run_mode != JobRunMode::Plan {
        return Err("Apply jobs are not certified by the current engine".to_string());
    }
    validate_provider(&request.provider)?;
    if !(1..=20).contains(&request.max_turns) {
        return Err("Job maxTurns must be between 1 and 20".to_string());
    }
    let mut store = load_jobs(root)?;
    let job = store
        .jobs
        .iter_mut()
        .find(|job| job.id == request.job_id)
        .ok_or_else(|| "Job was not found".to_string())?;
    if !matches!(job.status, JobStatus::Draft | JobStatus::Ready) {
        return Err("Only draft or ready jobs can change setup".to_string());
    }
    let setup_is_unchanged = job.provider.as_ref() == Some(&request.provider)
        && job.run_mode == request.run_mode
        && job.approval_mode == request.approval_mode
        && job.max_turns == request.max_turns;
    if setup_is_unchanged {
        return Ok(job.clone());
    }
    job.provider = Some(request.provider);
    job.run_mode = request.run_mode;
    job.approval_mode = request.approval_mode;
    job.max_turns = request.max_turns;
    job.preflight_id = None;
    job.status = JobStatus::Draft;
    job.current_stage = "setup".to_string();
    job.updated_at = now_millis();
    let result = job.clone();
    save_jobs(root, &store)?;
    Ok(result)
}

pub fn resume_interrupted_job(root: &Path, job_id: &str) -> Result<JobRecord, String> {
    let mut store = load_jobs(root)?;
    let job = store
        .jobs
        .iter_mut()
        .find(|job| job.id == job_id)
        .ok_or_else(|| "Job was not found".to_string())?;
    if job.status != JobStatus::Interrupted {
        return Err("Only an interrupted job can resume from a safe checkpoint".to_string());
    }
    if job.active_run_id.is_some() {
        return Err("The interrupted job still has an active attempt".to_string());
    }
    job.status = JobStatus::Draft;
    job.current_stage = "setup".to_string();
    job.preflight_id = None;
    job.last_error = None;
    job.updated_at = now_millis();
    let result = job.clone();
    save_jobs(root, &store)?;
    Ok(result)
}

pub fn delete_job(root: &Path, job_id: &str) -> Result<(), String> {
    validate_uuid(job_id, "Job ID")?;
    let mut store = load_jobs(root)?;
    let job = store
        .jobs
        .iter()
        .find(|job| job.id == job_id)
        .ok_or_else(|| "Job was not found".to_string())?;
    if job.status == JobStatus::Planning || job.active_run_id.is_some() {
        return Err("An active job cannot be deleted".to_string());
    }

    let directory = job_directory(root, job_id)?;
    let staged = root.join(format!(".deleting-{job_id}-{}", Uuid::new_v4()));
    let had_directory = directory.exists();
    if had_directory {
        fs::rename(&directory, &staged)
            .map_err(|error| format!("Could not stage job history for deletion: {error}"))?;
    }
    store.jobs.retain(|job| job.id != job_id);
    if let Err(error) = save_jobs(root, &store) {
        if had_directory {
            let _ = fs::rename(&staged, &directory);
        }
        return Err(error);
    }
    if had_directory {
        fs::remove_dir_all(&staged).map_err(|error| {
            format!(
                "Job history was removed, but its staged storage could not be cleaned up: {error}"
            )
        })?;
    }
    Ok(())
}

fn is_terminal_history(status: JobStatus) -> bool {
    matches!(
        status,
        JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled | JobStatus::Blocked
    )
}

pub fn apply_job_retention(
    root: &Path,
    policy: &JobRetentionSettings,
) -> Result<Vec<String>, String> {
    if !policy.enabled {
        return Ok(Vec::new());
    }
    let store = load_jobs(root)?;
    let terminal_jobs = store
        .jobs
        .iter()
        .filter(|job| is_terminal_history(job.status))
        .collect::<Vec<_>>();
    let mut selected = HashSet::new();
    for job in terminal_jobs
        .iter()
        .skip(usize::from(policy.max_terminal_jobs))
    {
        selected.insert(job.id.clone());
    }
    if let Some(max_age_days) = policy.max_age_days {
        let max_age_millis = u64::from(max_age_days)
            .saturating_mul(24)
            .saturating_mul(60)
            .saturating_mul(60)
            .saturating_mul(1_000);
        let cutoff = now_millis().saturating_sub(max_age_millis);
        for job in &terminal_jobs {
            if job.updated_at < cutoff {
                selected.insert(job.id.clone());
            }
        }
    }

    let ids = terminal_jobs
        .iter()
        .rev()
        .filter(|job| selected.contains(&job.id))
        .map(|job| job.id.clone())
        .collect::<Vec<_>>();
    let mut deleted = Vec::with_capacity(ids.len());
    for job_id in ids {
        delete_job(root, &job_id)?;
        deleted.push(job_id);
    }
    Ok(deleted)
}

pub fn attach_preflight(root: &Path, job_id: &str, preflight: &Value) -> Result<JobRecord, String> {
    let preflight_id = preflight
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Preflight ID is missing".to_string())?;
    validate_uuid(preflight_id, "Preflight ID")?;
    let canonical_repository = preflight
        .get("canonicalRepository")
        .or_else(|| preflight.get("canonical_repository"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Preflight canonical repository is missing".to_string())?;
    let skill = preflight
        .get("skill")
        .and_then(Value::as_object)
        .ok_or_else(|| "Preflight skill snapshot is missing".to_string())?;
    let skill_id = skill
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Preflight skill ID is missing".to_string())?;
    let skill_name = skill
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Preflight skill name is missing".to_string())?;
    let skill_digest = skill
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| "Preflight skill digest is missing".to_string())?;
    let mut store = load_jobs(root)?;
    let job = store
        .jobs
        .iter_mut()
        .find(|job| job.id == job_id)
        .ok_or_else(|| "Job was not found".to_string())?;
    if job.status != JobStatus::Draft {
        return Err("Only a draft job can attach a new preflight".to_string());
    }
    if !job
        .canonical_repository
        .eq_ignore_ascii_case(canonical_repository)
        || job.skill_id != skill_id
        || job.skill_name != skill_name
        || job.skill_digest != skill_digest
    {
        return Err("Prepared context does not match the durable job snapshot".to_string());
    }
    job.preflight_id = Some(preflight_id.to_string());
    job.status = JobStatus::Ready;
    job.current_stage = "preflight_ready".to_string();
    job.updated_at = now_millis();
    let result = job.clone();
    save_jobs(root, &store)?;
    Ok(result)
}

pub fn begin_attempt(
    root: &Path,
    job_id: &str,
    run_id: &str,
    preflight_id: &str,
    provider_kind: JobProviderKind,
    model: &str,
    max_turns: u8,
) -> Result<JobRecord, String> {
    validate_uuid(run_id, "Run ID")?;
    validate_uuid(preflight_id, "Preflight ID")?;
    let mut store = load_jobs(root)?;
    let job = store
        .jobs
        .iter_mut()
        .find(|job| job.id == job_id)
        .ok_or_else(|| "Job was not found".to_string())?;
    if job.status != JobStatus::Ready || job.preflight_id.as_deref() != Some(preflight_id) {
        return Err("Job is not ready with the requested preflight".to_string());
    }
    let provider = job
        .provider
        .as_ref()
        .ok_or_else(|| "Job does not have a provider snapshot".to_string())?;
    if provider.kind != provider_kind || provider.model != model {
        return Err("Run provider does not match the durable job snapshot".to_string());
    }
    if job.max_turns != max_turns {
        return Err("Run limits do not match the durable job snapshot".to_string());
    }
    if job.attempts.len() >= MAX_ATTEMPTS {
        return Err("Job attempt history exceeds the limit".to_string());
    }
    let timestamp = now_millis();
    job.status = JobStatus::Planning;
    job.current_stage = "starting".to_string();
    job.active_run_id = Some(run_id.to_string());
    job.attempts.push(JobAttempt {
        run_id: run_id.to_string(),
        started_at: timestamp,
        finished_at: None,
        outcome: None,
    });
    job.updated_at = timestamp;
    let result = job.clone();
    save_jobs(root, &store)?;
    Ok(result)
}

fn artifact_paths(event: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    for source in [
        event.get("artifacts"),
        event
            .get("metadata")
            .and_then(|value| value.get("artifacts")),
        event.get("result").and_then(|value| value.get("artifacts")),
    ] {
        if let Some(object) = source.and_then(Value::as_object) {
            for value in object.values().filter_map(Value::as_str) {
                if !paths.iter().any(|path| path == value) {
                    paths.push(value.to_string());
                }
            }
        }
    }
    paths
}

fn append_event(root: &Path, job_id: &str, event: &Value) -> Result<(), String> {
    let directory = job_directory(root, job_id)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create job directory: {error}"))?;
    let wrapper = serde_json::json!({
        "recordedAt": now_millis(),
        "event": event,
    });
    let line = serde_json::to_vec(&wrapper)
        .map_err(|error| format!("Could not encode job event: {error}"))?;
    if line.len() > MAX_EVENT_BYTES {
        return Err("Job event exceeds the size limit".to_string());
    }
    let events_path = directory.join("events.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&events_path)
        .map_err(|error| format!("Could not open {}: {error}", events_path.display()))?;
    file.write_all(&line)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_data())
        .map_err(|error| format!("Could not persist job event: {error}"))
}

pub fn record_agent_event(root: &Path, job_id: &str, event: &Value) -> Result<(), String> {
    let run_id = event
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent event run ID is missing".to_string())?;
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent event type is missing".to_string())?;
    let mut store = load_jobs(root)?;
    let job = store
        .jobs
        .iter_mut()
        .find(|job| job.id == job_id)
        .ok_or_else(|| "Job was not found".to_string())?;
    if job.active_run_id.as_deref() != Some(run_id) {
        return Err("Agent event does not match the job's active attempt".to_string());
    }
    append_event(root, job_id, event)?;
    let timestamp = now_millis();
    match event_type {
        "status" => {
            if let Some(phase) = event.get("phase").and_then(Value::as_str) {
                job.current_stage = phase.to_string();
            }
            job.updated_at = timestamp;
            save_jobs(root, &store)?;
        }
        "result" => {
            let cancelled = event
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let success = event
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let outcome = if cancelled {
                JobStatus::Cancelled
            } else if success {
                JobStatus::Completed
            } else {
                JobStatus::Failed
            };
            let result_path = job_directory(root, job_id)?.join("result.json");
            write_versioned(&result_path, event)?;
            job.status = outcome;
            job.current_stage = if success {
                "completed".to_string()
            } else if cancelled {
                "cancelled".to_string()
            } else {
                "failed".to_string()
            };
            job.result_path = Some(result_path.to_string_lossy().into_owned());
            job.artifact_paths = artifact_paths(event);
            job.last_error = event
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string);
            job.active_run_id = None;
            if let Some(attempt) = job
                .attempts
                .iter_mut()
                .rev()
                .find(|attempt| attempt.run_id == run_id)
            {
                attempt.finished_at = Some(timestamp);
                attempt.outcome = Some(outcome);
            }
            job.updated_at = timestamp;
            save_jobs(root, &store)?;
        }
        _ => {}
    }
    Ok(())
}

pub fn fail_start(root: &Path, job_id: &str, run_id: &str, error: &str) -> Result<(), String> {
    let event = serde_json::json!({
        "type": "result",
        "runId": run_id,
        "success": false,
        "cancelled": false,
        "error": error,
    });
    record_agent_event(root, job_id, &event)
}

pub fn read_job_result(root: &Path, job_id: &str) -> Result<Option<Value>, String> {
    let store = load_jobs(root)?;
    let job = store
        .jobs
        .iter()
        .find(|job| job.id == job_id)
        .ok_or_else(|| "Job was not found".to_string())?;
    let Some(path) = &job.result_path else {
        return Ok(None);
    };
    let expected = job_directory(root, job_id)?.join("result.json");
    let path = PathBuf::from(path);
    if path != expected || !path.is_file() {
        return Err("Job result path is invalid".to_string());
    }
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not inspect job result: {error}"))?;
    if metadata.len() > MAX_RESULT_BYTES {
        return Err("Job result exceeds the size limit".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("Could not read job result: {error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Stored job result is malformed and cannot be displayed: {error}"))
}

pub fn read_job_events(root: &Path, job_id: &str) -> Result<Vec<Value>, String> {
    let store = load_jobs(root)?;
    if !store.jobs.iter().any(|job| job.id == job_id) {
        return Err("Job was not found".to_string());
    }
    let path = job_directory(root, job_id)?.join("events.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not inspect job events: {error}"))?;
    if metadata.len() > MAX_RESULT_BYTES {
        return Err("Job event history exceeds the size limit".to_string());
    }
    let file =
        fs::File::open(&path).map_err(|error| format!("Could not open job events: {error}"))?;
    let mut events = Vec::new();
    for line in BufReader::new(file).lines().take(MAX_EVENTS) {
        let line = line.map_err(|error| format!("Could not read job events: {error}"))?;
        let wrapper: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Stored job event is malformed: {error}"))?;
        if let Some(event) = wrapper.get("event") {
            events.push(event.clone());
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        std::env::temp_dir().join(format!("pimp-code-jobs-{}", Uuid::new_v4()))
    }

    fn provider() -> JobProviderSnapshot {
        JobProviderSnapshot {
            profile_id: Uuid::new_v4().to_string(),
            profile_revision: 2,
            profile_name: "Local fixture".to_string(),
            kind: JobProviderKind::Local,
            endpoint: Some("http://127.0.0.1:1234/v1".to_string()),
            model: "fixture-model".to_string(),
        }
    }

    fn create_request(project_id: String) -> CreateJobRequest {
        CreateJobRequest {
            project_id,
            project_name: "Fixture".to_string(),
            canonical_repository: r"C:\fixture".to_string(),
            skill_id: "migrate-to-vite".to_string(),
            skill_name: "migrate-to-vite".to_string(),
            skill_digest: "a".repeat(64),
            skill_root: r"C:\skills".to_string(),
            provider: Some(provider()),
            run_mode: JobRunMode::Plan,
            approval_mode: JobApprovalMode::Guided,
            max_turns: 10,
        }
    }

    #[test]
    fn durable_job_records_setup_preflight_events_and_result() {
        let root = fixture_root();
        let job = create_job(&root, create_request(Uuid::new_v4().to_string()))
            .expect("create durable job");
        assert_eq!(job.status, JobStatus::Draft);
        let preflight_id = Uuid::new_v4().to_string();
        let preflight = serde_json::json!({
            "id": preflight_id,
            "canonicalRepository": job.canonical_repository,
            "skill": {
                "id": job.skill_id,
                "name": job.skill_name,
                "digest": job.skill_digest,
            }
        });
        let ready = attach_preflight(&root, &job.id, &preflight).expect("attach preflight");
        assert_eq!(ready.status, JobStatus::Ready);
        let run_id = Uuid::new_v4().to_string();
        begin_attempt(
            &root,
            &job.id,
            &run_id,
            &preflight_id,
            JobProviderKind::Local,
            "fixture-model",
            10,
        )
        .expect("begin attempt");
        record_agent_event(
            &root,
            &job.id,
            &serde_json::json!({
                "type": "status",
                "runId": run_id,
                "phase": "planning",
                "message": "Planning",
            }),
        )
        .expect("record status");
        record_agent_event(
            &root,
            &job.id,
            &serde_json::json!({
                "type": "result",
                "runId": run_id,
                "success": true,
                "cancelled": false,
                "result": { "markdown": "# Plan" },
            }),
        )
        .expect("record result");
        let store = load_jobs(&root).expect("load jobs");
        assert_eq!(store.jobs[0].status, JobStatus::Completed);
        assert_eq!(read_job_events(&root, &job.id).expect("events").len(), 2);
        assert_eq!(
            read_job_result(&root, &job.id)
                .expect("result")
                .and_then(|value| value.get("result").cloned())
                .and_then(|value| value.get("markdown").cloned())
                .and_then(|value| value.as_str().map(str::to_string)),
            Some("# Plan".to_string())
        );
        fs::remove_dir_all(root).expect("remove job store");
    }

    #[test]
    fn identical_setup_autosave_preserves_a_ready_preflight() {
        let root = fixture_root();
        let job = create_job(&root, create_request(Uuid::new_v4().to_string()))
            .expect("create durable job");
        let preflight_id = Uuid::new_v4().to_string();
        let ready = attach_preflight(
            &root,
            &job.id,
            &serde_json::json!({
                "id": preflight_id,
                "canonicalRepository": job.canonical_repository,
                "skill": {
                    "id": job.skill_id,
                    "name": job.skill_name,
                    "digest": job.skill_digest,
                }
            }),
        )
        .expect("attach preflight");
        let after_autosave = update_job_setup(
            &root,
            UpdateJobSetupRequest {
                job_id: ready.id.clone(),
                provider: ready.provider.clone().expect("provider snapshot"),
                run_mode: ready.run_mode,
                approval_mode: ready.approval_mode,
                max_turns: ready.max_turns,
            },
        )
        .expect("idempotent setup autosave");

        assert_eq!(after_autosave.status, JobStatus::Ready);
        assert_eq!(
            after_autosave.preflight_id.as_deref(),
            Some(preflight_id.as_str())
        );
        fs::remove_dir_all(root).expect("remove job store");
    }

    #[test]
    fn apply_jobs_fail_closed_until_the_engine_is_certified() {
        let root = fixture_root();
        let mut request = create_request(Uuid::new_v4().to_string());
        request.run_mode = JobRunMode::Apply;
        assert_eq!(
            create_job(&root, request).expect_err("reject apply job"),
            "Apply jobs are not certified by the current engine"
        );
    }

    #[test]
    fn reconciliation_marks_an_orphaned_attempt_interrupted() {
        let root = fixture_root();
        let job = create_job(&root, create_request(Uuid::new_v4().to_string()))
            .expect("create durable job");
        let preflight_id = Uuid::new_v4().to_string();
        attach_preflight(
            &root,
            &job.id,
            &serde_json::json!({
                "id": preflight_id,
                "canonicalRepository": job.canonical_repository,
                "skill": {
                    "id": job.skill_id,
                    "name": job.skill_name,
                    "digest": job.skill_digest,
                }
            }),
        )
        .expect("attach preflight");
        let run_id = Uuid::new_v4().to_string();
        begin_attempt(
            &root,
            &job.id,
            &run_id,
            &preflight_id,
            JobProviderKind::Local,
            "fixture-model",
            10,
        )
        .expect("begin attempt");
        let store = reconcile_jobs(&root, None).expect("reconcile jobs");
        assert_eq!(store.jobs[0].status, JobStatus::Interrupted);
        assert_eq!(
            store.jobs[0].attempts[0].outcome,
            Some(JobStatus::Interrupted)
        );
        fs::remove_dir_all(root).expect("remove job store");
    }

    #[test]
    fn interrupted_job_resumes_from_setup_with_a_fresh_preflight() {
        let root = fixture_root();
        let job = create_job(&root, create_request(Uuid::new_v4().to_string()))
            .expect("create durable job");
        let preflight_id = Uuid::new_v4().to_string();
        attach_preflight(
            &root,
            &job.id,
            &serde_json::json!({
                "id": preflight_id,
                "canonicalRepository": job.canonical_repository,
                "skill": {
                    "id": job.skill_id,
                    "name": job.skill_name,
                    "digest": job.skill_digest,
                }
            }),
        )
        .expect("attach preflight");
        let run_id = Uuid::new_v4().to_string();
        begin_attempt(
            &root,
            &job.id,
            &run_id,
            &preflight_id,
            JobProviderKind::Local,
            "fixture-model",
            10,
        )
        .expect("begin attempt");
        reconcile_jobs(&root, None).expect("interrupt orphaned attempt");

        let resumed = resume_interrupted_job(&root, &job.id).expect("resume interrupted job");
        assert_eq!(resumed.status, JobStatus::Draft);
        assert_eq!(resumed.current_stage, "setup");
        assert_eq!(resumed.preflight_id, None);
        assert_eq!(resumed.active_run_id, None);
        assert_eq!(resumed.last_error, None);
        assert_eq!(resumed.attempts.len(), 1);
        assert_eq!(resumed.attempts[0].outcome, Some(JobStatus::Interrupted));

        fs::remove_dir_all(root).expect("remove resumable job store");
    }

    #[test]
    fn job_deletion_removes_history_storage_but_rejects_active_attempts() {
        let root = fixture_root();
        let removable = create_job(&root, create_request(Uuid::new_v4().to_string()))
            .expect("create removable job");
        let active = create_job(&root, create_request(Uuid::new_v4().to_string()))
            .expect("create active job");
        let preflight_id = Uuid::new_v4().to_string();
        attach_preflight(
            &root,
            &active.id,
            &serde_json::json!({
                "id": preflight_id,
                "canonicalRepository": active.canonical_repository,
                "skill": {
                    "id": active.skill_id,
                    "name": active.skill_name,
                    "digest": active.skill_digest,
                }
            }),
        )
        .expect("attach active preflight");
        begin_attempt(
            &root,
            &active.id,
            &Uuid::new_v4().to_string(),
            &preflight_id,
            JobProviderKind::Local,
            "fixture-model",
            10,
        )
        .expect("begin active attempt");

        assert_eq!(
            delete_job(&root, &active.id).expect_err("reject active deletion"),
            "An active job cannot be deleted"
        );
        let removable_directory = job_directory(&root, &removable.id).expect("job directory");
        assert!(removable_directory.is_dir());
        delete_job(&root, &removable.id).expect("delete inactive job");
        assert!(!removable_directory.exists());
        let store = load_jobs(&root).expect("load jobs after deletion");
        assert!(store.jobs.iter().all(|job| job.id != removable.id));
        assert!(store.jobs.iter().any(|job| job.id == active.id));

        fs::remove_dir_all(root).expect("remove deletion job store");
    }

    #[test]
    fn retention_prunes_old_terminal_history_and_preserves_resumable_jobs() {
        let root = fixture_root();
        let immutable_artifact = root.with_extension("immutable-plan.md");
        fs::write(&immutable_artifact, "# Immutable plan").expect("write immutable artifact");
        let project_id = Uuid::new_v4().to_string();
        let newest = create_job(&root, create_request(project_id.clone())).expect("newest job");
        let middle = create_job(&root, create_request(project_id.clone())).expect("middle job");
        let oldest = create_job(&root, create_request(project_id.clone())).expect("oldest job");
        let draft = create_job(&root, create_request(project_id.clone())).expect("draft job");
        let interrupted = create_job(&root, create_request(project_id)).expect("interrupted job");
        let mut store = load_jobs(&root).expect("load retention fixtures");
        for job in &mut store.jobs {
            if job.id == newest.id {
                job.status = JobStatus::Completed;
                job.updated_at = 300;
            } else if job.id == middle.id {
                job.status = JobStatus::Failed;
                job.updated_at = 200;
            } else if job.id == oldest.id {
                job.status = JobStatus::Cancelled;
                job.updated_at = 100;
                job.artifact_paths = vec![immutable_artifact.to_string_lossy().into_owned()];
            } else if job.id == interrupted.id {
                job.status = JobStatus::Interrupted;
                job.updated_at = 50;
            }
        }
        save_jobs(&root, &store).expect("save retention fixtures");

        assert!(
            apply_job_retention(&root, &JobRetentionSettings::default())
                .expect("disabled retention")
                .is_empty()
        );
        let deleted = apply_job_retention(
            &root,
            &JobRetentionSettings {
                enabled: true,
                max_terminal_jobs: 2,
                max_age_days: None,
            },
        )
        .expect("count retention");
        assert_eq!(deleted, vec![oldest.id.clone()]);
        assert!(immutable_artifact.is_file());
        let after_count = load_jobs(&root).expect("load count-retained jobs");
        assert!(after_count.jobs.iter().any(|job| job.id == newest.id));
        assert!(after_count.jobs.iter().any(|job| job.id == middle.id));
        assert!(after_count.jobs.iter().any(|job| job.id == draft.id));
        assert!(after_count.jobs.iter().any(|job| job.id == interrupted.id));

        let age_deleted = apply_job_retention(
            &root,
            &JobRetentionSettings {
                enabled: true,
                max_terminal_jobs: 10,
                max_age_days: Some(1),
            },
        )
        .expect("age retention");
        assert_eq!(age_deleted, vec![middle.id.clone(), newest.id.clone()]);
        let after_age = load_jobs(&root).expect("load age-retained jobs");
        assert_eq!(after_age.jobs.len(), 2);
        assert!(after_age.jobs.iter().any(|job| job.id == draft.id));
        assert!(after_age.jobs.iter().any(|job| job.id == interrupted.id));

        fs::remove_dir_all(root).expect("remove retention job store");
        fs::remove_file(immutable_artifact).expect("remove immutable artifact fixture");
    }
}
