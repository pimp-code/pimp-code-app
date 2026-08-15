use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const SETTINGS_VERSION: u8 = 1;
const MAX_PROJECTS: usize = 100;
const MAX_PROVIDER_PROFILES: usize = 64;
const MAX_RETAINED_TERMINAL_JOBS: u16 = 10_000;
const MAX_RETENTION_DAYS: u16 = 3_650;
const MAX_NAME_LENGTH: usize = 120;
const MAX_PATH_LENGTH: usize = 2_000;
const MAX_VALUE_LENGTH: usize = 2_000;
const MAX_SETTINGS_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub configured_path: String,
    pub canonical_path: String,
    pub workspace_path: Option<String>,
    pub default_provider_profile_id: Option<String>,
    pub default_model: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_opened_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub version: u8,
    pub active_project_id: Option<String>,
    pub projects: Vec<ProjectRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateInput {
    pub id: String,
    pub name: String,
    pub configured_path: Option<String>,
    pub default_provider_profile_id: Option<String>,
    pub default_model: Option<String>,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            active_project_id: None,
            projects: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderProfileKind {
    Claude,
    Codex,
    Local,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileRecord {
    pub id: String,
    pub name: String,
    pub kind: ProviderProfileKind,
    pub endpoint: Option<String>,
    pub default_model: String,
    pub credential_ref: Option<String>,
    pub revision: u32,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: ProviderProfileKind,
    pub endpoint: Option<String>,
    pub default_model: String,
    pub credential_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileSettings {
    pub version: u8,
    pub profiles: Vec<ProviderProfileRecord>,
}

impl Default for ProviderProfileSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            profiles: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRetentionSettings {
    pub enabled: bool,
    pub max_terminal_jobs: u16,
    pub max_age_days: Option<u16>,
}

impl Default for JobRetentionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            max_terminal_jobs: 500,
            max_age_days: Some(365),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSettings {
    pub version: u8,
    pub job_retention: JobRetentionSettings,
}

impl Default for ApplicationSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            job_retention: JobRetentionSettings::default(),
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn validate_text(value: &str, label: &str, max_length: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_length || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid or too long"));
    }
    Ok(value.to_string())
}

fn validate_optional_text(
    value: Option<String>,
    label: &str,
    max_length: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| validate_text(&value, label, max_length))
        .transpose()
}

fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(value).map_err(|_| format!("{label} is invalid"))?;
    if parsed.to_string() != value.to_ascii_lowercase() {
        return Err(format!("{label} must use canonical UUID form"));
    }
    Ok(())
}

fn normalize_path_for_node(path: &Path) -> String {
    let value = path.to_string_lossy();
    value
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or_else(|| value.into_owned())
}

pub(crate) fn read_versioned<T>(path: &Path, label: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if metadata.len() > MAX_SETTINGS_BYTES {
        return Err(format!("{label} settings exceed the size limit"));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("{label} settings are malformed: {error}"))
}

pub(crate) fn write_versioned<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Settings path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not encode settings: {error}"))?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, payload)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    let backup = path.with_extension(format!("{}.bak", Uuid::new_v4()));
    let had_existing = path.exists();
    if had_existing {
        fs::rename(path, &backup).map_err(|error| {
            format!(
                "Could not stage {} for replacement: {error}",
                path.display()
            )
        })?;
    }
    match fs::rename(&temporary, path) {
        Ok(()) => {
            if had_existing {
                let _ = fs::remove_file(backup);
            }
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            if had_existing {
                let _ = fs::rename(&backup, path);
            }
            Err(format!("Could not publish {}: {error}", path.display()))
        }
    }
}

fn validate_project_settings(settings: ProjectSettings) -> Result<ProjectSettings, String> {
    if settings.version != SETTINGS_VERSION {
        return Err(format!(
            "Unsupported project settings version {}",
            settings.version
        ));
    }
    if settings.projects.len() > MAX_PROJECTS {
        return Err(format!("At most {MAX_PROJECTS} projects are allowed"));
    }
    let mut ids = HashSet::new();
    let mut canonical_paths = HashSet::new();
    for project in &settings.projects {
        validate_uuid(&project.id, "Project ID")?;
        validate_text(&project.name, "Project name", MAX_NAME_LENGTH)?;
        validate_text(
            &project.configured_path,
            "Configured project path",
            MAX_PATH_LENGTH,
        )?;
        validate_text(
            &project.canonical_path,
            "Canonical project path",
            MAX_PATH_LENGTH,
        )?;
        validate_optional_text(
            project.workspace_path.clone(),
            "Workspace path",
            MAX_PATH_LENGTH,
        )?;
        if let Some(profile_id) = &project.default_provider_profile_id {
            validate_uuid(profile_id, "Default provider-profile ID")?;
        }
        validate_optional_text(
            project.default_model.clone(),
            "Default model",
            MAX_NAME_LENGTH,
        )?;
        if !ids.insert(project.id.clone()) {
            return Err("Project settings contain a duplicate ID".to_string());
        }
        if !canonical_paths.insert(project.canonical_path.to_lowercase()) {
            return Err("Project settings contain a duplicate canonical path".to_string());
        }
    }
    if let Some(active_id) = &settings.active_project_id
        && !settings
            .projects
            .iter()
            .any(|project| &project.id == active_id)
    {
        return Err("The active project ID does not exist".to_string());
    }
    Ok(settings)
}

pub fn load_projects(path: &Path) -> Result<ProjectSettings, String> {
    validate_project_settings(read_versioned(path, "Project")?)
}

pub fn save_projects(path: &Path, settings: &ProjectSettings) -> Result<(), String> {
    validate_project_settings(settings.clone())?;
    write_versioned(path, settings)
}

pub fn add_project(
    settings: &mut ProjectSettings,
    configured_path: String,
    name: Option<String>,
) -> Result<(), String> {
    if settings.projects.len() >= MAX_PROJECTS {
        return Err(format!("At most {MAX_PROJECTS} projects are allowed"));
    }
    let configured_path = validate_text(&configured_path, "Project path", MAX_PATH_LENGTH)?;
    let path = PathBuf::from(&configured_path);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve project path: {error}"))?;
    if !canonical.is_dir() {
        return Err("The selected project path is not a directory".to_string());
    }
    let canonical_path = normalize_path_for_node(&canonical);
    if settings
        .projects
        .iter()
        .any(|project| project.canonical_path.eq_ignore_ascii_case(&canonical_path))
    {
        return Err("This project is already saved".to_string());
    }
    let inferred_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Project");
    let name = validate_text(
        name.as_deref().unwrap_or(inferred_name),
        "Project name",
        MAX_NAME_LENGTH,
    )?;
    let timestamp = now_millis();
    let id = Uuid::new_v4().to_string();
    settings.projects.push(ProjectRecord {
        id: id.clone(),
        name,
        configured_path,
        canonical_path,
        workspace_path: None,
        default_provider_profile_id: None,
        default_model: None,
        created_at: timestamp,
        updated_at: timestamp,
        last_opened_at: Some(timestamp),
    });
    settings.active_project_id = Some(id);
    Ok(())
}

pub fn select_project(settings: &mut ProjectSettings, project_id: &str) -> Result<(), String> {
    let project_id = validate_text(project_id, "Project ID", 100)?;
    let project = settings
        .projects
        .iter_mut()
        .find(|project| project.id == project_id)
        .ok_or_else(|| "Project was not found".to_string())?;
    let timestamp = now_millis();
    project.last_opened_at = Some(timestamp);
    project.updated_at = timestamp;
    settings.active_project_id = Some(project_id);
    Ok(())
}

pub fn remove_project(settings: &mut ProjectSettings, project_id: &str) -> Result<(), String> {
    let original_len = settings.projects.len();
    settings.projects.retain(|project| project.id != project_id);
    if settings.projects.len() == original_len {
        return Err("Project was not found".to_string());
    }
    if settings.active_project_id.as_deref() == Some(project_id) {
        settings.active_project_id = settings.projects.first().map(|project| project.id.clone());
    }
    Ok(())
}

pub fn update_project(
    settings: &mut ProjectSettings,
    input: ProjectUpdateInput,
) -> Result<(), String> {
    let project_id = validate_text(&input.id, "Project ID", 100)?;
    validate_uuid(&project_id, "Project ID")?;
    let name = validate_text(&input.name, "Project name", MAX_NAME_LENGTH)?;
    let default_provider_profile_id = if let Some(profile_id) = input.default_provider_profile_id {
        let profile_id = validate_text(&profile_id, "Default provider-profile ID", 100)?;
        validate_uuid(&profile_id, "Default provider-profile ID")?;
        Some(profile_id)
    } else {
        None
    };
    let default_model =
        validate_optional_text(input.default_model, "Default model", MAX_NAME_LENGTH)?;
    if default_provider_profile_id.is_none() && default_model.is_some() {
        return Err("A default model requires a default provider profile".to_string());
    }

    let relinked_path = input
        .configured_path
        .map(|configured_path| {
            let configured_path = validate_text(&configured_path, "Project path", MAX_PATH_LENGTH)?;
            let canonical = PathBuf::from(&configured_path)
                .canonicalize()
                .map_err(|error| format!("Could not resolve project path: {error}"))?;
            if !canonical.is_dir() {
                return Err("The selected project path is not a directory".to_string());
            }
            Ok((configured_path, normalize_path_for_node(&canonical)))
        })
        .transpose()?;

    if let Some((_, canonical_path)) = &relinked_path
        && settings.projects.iter().any(|project| {
            project.id != project_id && project.canonical_path.eq_ignore_ascii_case(canonical_path)
        })
    {
        return Err("This project path is already saved".to_string());
    }

    let project = settings
        .projects
        .iter_mut()
        .find(|project| project.id == project_id)
        .ok_or_else(|| "Project was not found".to_string())?;
    project.name = name;
    if let Some((configured_path, canonical_path)) = relinked_path {
        project.configured_path = configured_path;
        project.canonical_path = canonical_path;
        project.workspace_path = None;
    }
    project.default_provider_profile_id = default_provider_profile_id;
    project.default_model = default_model;
    project.updated_at = now_millis();
    Ok(())
}

fn validate_provider_settings(
    settings: ProviderProfileSettings,
) -> Result<ProviderProfileSettings, String> {
    if settings.version != SETTINGS_VERSION {
        return Err(format!(
            "Unsupported provider-profile settings version {}",
            settings.version
        ));
    }
    if settings.profiles.len() > MAX_PROVIDER_PROFILES {
        return Err(format!(
            "At most {MAX_PROVIDER_PROFILES} provider profiles are allowed"
        ));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for profile in &settings.profiles {
        validate_uuid(&profile.id, "Provider-profile ID")?;
        validate_text(&profile.name, "Profile name", MAX_NAME_LENGTH)?;
        validate_text(&profile.default_model, "Default model", MAX_NAME_LENGTH)?;
        validate_optional_text(
            profile.credential_ref.clone(),
            "Credential reference",
            MAX_VALUE_LENGTH,
        )?;
        match profile.kind {
            ProviderProfileKind::Local => {
                validate_text(
                    profile.endpoint.as_deref().unwrap_or_default(),
                    "Local endpoint",
                    MAX_VALUE_LENGTH,
                )?;
            }
            ProviderProfileKind::Claude | ProviderProfileKind::Codex
                if profile.endpoint.is_some() =>
            {
                return Err("Remote provider profiles cannot store a custom endpoint".to_string());
            }
            ProviderProfileKind::Claude | ProviderProfileKind::Codex => {}
        }
        if profile.revision == 0 {
            return Err("Provider-profile revision must be positive".to_string());
        }
        if !ids.insert(profile.id.clone()) {
            return Err("Provider-profile settings contain a duplicate ID".to_string());
        }
        if !names.insert(profile.name.to_lowercase()) {
            return Err("Provider-profile settings contain a duplicate name".to_string());
        }
    }
    Ok(settings)
}

pub fn load_provider_profiles(path: &Path) -> Result<ProviderProfileSettings, String> {
    validate_provider_settings(read_versioned(path, "Provider-profile")?)
}

pub fn save_provider_profiles(
    path: &Path,
    settings: &ProviderProfileSettings,
) -> Result<(), String> {
    validate_provider_settings(settings.clone())?;
    write_versioned(path, settings)
}

fn validate_application_settings(
    settings: ApplicationSettings,
) -> Result<ApplicationSettings, String> {
    if settings.version != SETTINGS_VERSION {
        return Err(format!(
            "Unsupported application settings version {}",
            settings.version
        ));
    }
    if !(1..=MAX_RETAINED_TERMINAL_JOBS).contains(&settings.job_retention.max_terminal_jobs) {
        return Err(format!(
            "Terminal job retention must be between 1 and {MAX_RETAINED_TERMINAL_JOBS}"
        ));
    }
    if let Some(days) = settings.job_retention.max_age_days
        && !(1..=MAX_RETENTION_DAYS).contains(&days)
    {
        return Err(format!(
            "Job retention age must be between 1 and {MAX_RETENTION_DAYS} days"
        ));
    }
    Ok(settings)
}

pub fn load_application_settings(path: &Path) -> Result<ApplicationSettings, String> {
    validate_application_settings(read_versioned(path, "Application")?)
}

pub fn save_application_settings(
    path: &Path,
    settings: &ApplicationSettings,
) -> Result<(), String> {
    validate_application_settings(settings.clone())?;
    write_versioned(path, settings)
}

pub fn upsert_provider_profile(
    settings: &mut ProviderProfileSettings,
    input: ProviderProfileInput,
) -> Result<String, String> {
    let name = validate_text(&input.name, "Profile name", MAX_NAME_LENGTH)?;
    let default_model = validate_text(&input.default_model, "Default model", MAX_NAME_LENGTH)?;
    let endpoint = match input.kind {
        ProviderProfileKind::Local => Some(validate_text(
            input.endpoint.as_deref().unwrap_or_default(),
            "Local endpoint",
            MAX_VALUE_LENGTH,
        )?),
        ProviderProfileKind::Claude | ProviderProfileKind::Codex => None,
    };
    let credential_ref = validate_optional_text(
        input.credential_ref,
        "Credential reference",
        MAX_VALUE_LENGTH,
    )?;
    if settings.profiles.iter().any(|profile| {
        profile.name.eq_ignore_ascii_case(&name) && input.id.as_deref() != Some(profile.id.as_str())
    }) {
        return Err("A provider profile with this name already exists".to_string());
    }
    let timestamp = now_millis();
    if let Some(id) = input.id {
        let id = validate_text(&id, "Profile ID", 100)?;
        let profile = settings
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| "Provider profile was not found".to_string())?;
        profile.name = name;
        profile.kind = input.kind;
        profile.endpoint = endpoint;
        profile.default_model = default_model;
        profile.credential_ref = credential_ref;
        profile.revision = profile.revision.saturating_add(1);
        profile.updated_at = timestamp;
        return Ok(id);
    }
    if settings.profiles.len() >= MAX_PROVIDER_PROFILES {
        return Err(format!(
            "At most {MAX_PROVIDER_PROFILES} provider profiles are allowed"
        ));
    }
    let id = Uuid::new_v4().to_string();
    settings.profiles.push(ProviderProfileRecord {
        id: id.clone(),
        name,
        kind: input.kind,
        endpoint,
        default_model,
        credential_ref,
        revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
    });
    Ok(id)
}

pub fn delete_provider_profile(
    settings: &mut ProviderProfileSettings,
    profile_id: &str,
) -> Result<(), String> {
    let original_len = settings.profiles.len();
    settings.profiles.retain(|profile| profile.id != profile_id);
    if settings.profiles.len() == original_len {
        return Err("Provider profile was not found".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pimp-code-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn project_settings_round_trip_and_reject_duplicate_paths() {
        let directory = temporary_directory("projects");
        fs::create_dir_all(&directory).expect("temporary project directory");
        let settings_path = directory.join("projects.json");
        let mut settings = ProjectSettings::default();
        add_project(
            &mut settings,
            directory.to_string_lossy().into_owned(),
            Some("Fixture".to_string()),
        )
        .expect("add project");
        let duplicate = add_project(
            &mut settings,
            directory.to_string_lossy().into_owned(),
            None,
        );
        assert_eq!(duplicate.unwrap_err(), "This project is already saved");
        save_projects(&settings_path, &settings).expect("save project settings");
        assert_eq!(
            load_projects(&settings_path).expect("load project settings"),
            settings
        );
        fs::remove_dir_all(directory).expect("remove temporary project directory");
    }

    #[test]
    fn project_update_renames_relinks_and_sets_provider_defaults() {
        let directory = temporary_directory("project-update");
        let original = directory.join("original");
        let replacement = directory.join("replacement");
        fs::create_dir_all(&original).expect("original project directory");
        fs::create_dir_all(&replacement).expect("replacement project directory");
        let mut settings = ProjectSettings::default();
        add_project(
            &mut settings,
            original.to_string_lossy().into_owned(),
            Some("Original".to_string()),
        )
        .expect("add project");
        let project_id = settings.projects[0].id.clone();
        let profile_id = Uuid::new_v4().to_string();

        update_project(
            &mut settings,
            ProjectUpdateInput {
                id: project_id,
                name: "Renamed project".to_string(),
                configured_path: Some(replacement.to_string_lossy().into_owned()),
                default_provider_profile_id: Some(profile_id.clone()),
                default_model: Some("project-model".to_string()),
            },
        )
        .expect("update project");

        let project = &settings.projects[0];
        assert_eq!(project.name, "Renamed project");
        assert_eq!(
            project.canonical_path,
            normalize_path_for_node(&replacement.canonicalize().expect("canonical replacement"))
        );
        assert_eq!(
            project.default_provider_profile_id.as_deref(),
            Some(profile_id.as_str())
        );
        assert_eq!(project.default_model.as_deref(), Some("project-model"));
        assert_eq!(project.workspace_path, None);

        fs::remove_dir_all(directory).expect("remove project update directory");
    }

    #[test]
    fn project_update_rejects_model_without_provider_and_duplicate_relink() {
        let directory = temporary_directory("project-update-invalid");
        let first = directory.join("first");
        let second = directory.join("second");
        fs::create_dir_all(&first).expect("first project directory");
        fs::create_dir_all(&second).expect("second project directory");
        let mut settings = ProjectSettings::default();
        add_project(
            &mut settings,
            first.to_string_lossy().into_owned(),
            Some("First".to_string()),
        )
        .expect("add first project");
        let first_id = settings.projects[0].id.clone();
        add_project(
            &mut settings,
            second.to_string_lossy().into_owned(),
            Some("Second".to_string()),
        )
        .expect("add second project");
        let second_id = settings.projects[1].id.clone();

        let missing_profile = update_project(
            &mut settings,
            ProjectUpdateInput {
                id: first_id,
                name: "First".to_string(),
                configured_path: None,
                default_provider_profile_id: None,
                default_model: Some("orphan-model".to_string()),
            },
        );
        assert_eq!(
            missing_profile.expect_err("reject orphan model"),
            "A default model requires a default provider profile"
        );

        let duplicate = update_project(
            &mut settings,
            ProjectUpdateInput {
                id: second_id,
                name: "Second".to_string(),
                configured_path: Some(first.to_string_lossy().into_owned()),
                default_provider_profile_id: None,
                default_model: None,
            },
        );
        assert_eq!(
            duplicate.expect_err("reject duplicate relink"),
            "This project path is already saved"
        );

        fs::remove_dir_all(directory).expect("remove invalid project update directory");
    }

    #[test]
    fn provider_profile_update_increments_revision_without_storing_secrets() {
        let directory = temporary_directory("profiles");
        let settings_path = directory.join("provider-profiles.json");
        let mut settings = ProviderProfileSettings::default();
        let id = upsert_provider_profile(
            &mut settings,
            ProviderProfileInput {
                id: None,
                name: "Local workstation".to_string(),
                kind: ProviderProfileKind::Local,
                endpoint: Some("http://127.0.0.1:1234/v1".to_string()),
                default_model: "local-model".to_string(),
                credential_ref: Some("vault:profile/local-workstation".to_string()),
            },
        )
        .expect("create provider profile");
        upsert_provider_profile(
            &mut settings,
            ProviderProfileInput {
                id: Some(id),
                name: "Local workstation".to_string(),
                kind: ProviderProfileKind::Local,
                endpoint: Some("http://127.0.0.1:1234/v1".to_string()),
                default_model: "updated-model".to_string(),
                credential_ref: Some("vault:profile/local-workstation".to_string()),
            },
        )
        .expect("update provider profile");
        assert_eq!(settings.profiles[0].revision, 2);
        save_provider_profiles(&settings_path, &settings).expect("save provider settings");
        let raw = fs::read_to_string(&settings_path).expect("read provider settings");
        assert!(!raw.contains("apiKey"));
        assert_eq!(
            load_provider_profiles(&settings_path).expect("load provider settings"),
            settings
        );
        fs::remove_dir_all(directory).expect("remove temporary provider directory");
    }

    #[test]
    fn application_retention_settings_round_trip_and_fail_closed() {
        let directory = temporary_directory("application-settings");
        let settings_path = directory.join("application-settings.json");
        let settings = ApplicationSettings {
            version: SETTINGS_VERSION,
            job_retention: JobRetentionSettings {
                enabled: true,
                max_terminal_jobs: 250,
                max_age_days: Some(180),
            },
        };
        save_application_settings(&settings_path, &settings).expect("save application settings");
        assert_eq!(
            load_application_settings(&settings_path).expect("load application settings"),
            settings
        );

        let mut invalid = settings.clone();
        invalid.job_retention.max_terminal_jobs = 0;
        assert_eq!(
            save_application_settings(&settings_path, &invalid)
                .expect_err("reject zero retained jobs"),
            "Terminal job retention must be between 1 and 10000"
        );
        invalid.job_retention.max_terminal_jobs = 100;
        invalid.job_retention.max_age_days = Some(0);
        assert_eq!(
            save_application_settings(&settings_path, &invalid)
                .expect_err("reject zero retention days"),
            "Job retention age must be between 1 and 3650 days"
        );

        fs::remove_dir_all(directory).expect("remove application settings directory");
    }

    #[test]
    fn persisted_settings_fail_closed_on_invalid_identifiers() {
        let directory = temporary_directory("invalid-settings");
        let project_path = directory.join("project");
        fs::create_dir_all(&project_path).expect("temporary project directory");
        let mut projects = ProjectSettings::default();
        add_project(
            &mut projects,
            project_path.to_string_lossy().into_owned(),
            None,
        )
        .expect("add project");
        projects.projects[0].id = "not-a-uuid".to_string();
        assert!(
            save_projects(&directory.join("projects.json"), &projects)
                .expect_err("invalid project settings")
                .contains("Project ID")
        );

        let mut profiles = ProviderProfileSettings::default();
        profiles.profiles.push(ProviderProfileRecord {
            id: Uuid::new_v4().to_string(),
            name: "Invalid revision".to_string(),
            kind: ProviderProfileKind::Claude,
            endpoint: None,
            default_model: "sonnet".to_string(),
            credential_ref: None,
            revision: 0,
            created_at: 0,
            updated_at: 0,
        });
        assert_eq!(
            save_provider_profiles(&directory.join("profiles.json"), &profiles)
                .expect_err("invalid provider settings"),
            "Provider-profile revision must be positive"
        );
        fs::remove_dir_all(directory).expect("remove temporary settings directory");
    }
}
