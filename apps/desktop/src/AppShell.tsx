import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ApplicationSettings,
  JobRecord,
  ProjectRecord,
  ProjectSettings,
  ProjectUpdateInput,
  ProviderCredentialStatus,
  ProviderKind,
  ProviderProfileInput,
  ProviderProfileRecord,
  SkillCatalog,
  SkillCatalogEntry,
} from "./contracts";
import { formatBytes, shortDigest } from "./contracts";
import { MarkdownChecklist } from "./MarkdownChecklist";

export type AppView =
  | "overview"
  | "skills"
  | "plan"
  | "jobs"
  | "projects"
  | "providers"
  | "settings";

interface AppShellProps {
  view: AppView;
  projects: ProjectSettings;
  activeProject?: ProjectRecord;
  activeProfile?: ProviderProfileRecord;
  activeJob?: JobRecord;
  running: boolean;
  onNavigate: (view: AppView) => void;
  onSelectProject: (projectId: string) => void;
  children: ReactNode;
}

export function AppShell({
  view,
  projects,
  activeProject,
  activeProfile,
  activeJob,
  running,
  onNavigate,
  onSelectProject,
  children,
}: AppShellProps) {
  return (
    <div className="app-frame">
      <aside className="app-rail" aria-label="Application navigation">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">P</span>
          <div>
            <strong>Pimp Code</strong>
            <small>Skill workspace</small>
          </div>
        </div>

        <label className="rail-project" htmlFor="active-project">
          <span>Active project</span>
          <select
            id="active-project"
            value={activeProject?.id ?? ""}
            onChange={(event) => onSelectProject(event.target.value)}
            disabled={projects.projects.length === 0 || running}
          >
            {projects.projects.length === 0 ? (
              <option value="">No saved projects</option>
            ) : null}
            {projects.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          {activeProject ? (
            <code title={activeProject.canonicalPath}>
              {activeProject.canonicalPath}
            </code>
          ) : (
            <small>Add a project to begin.</small>
          )}
        </label>

        <nav className="rail-nav" aria-label="Primary">
          <button
            type="button"
            className={view === "overview" ? "selected" : ""}
            onClick={() => onNavigate("overview")}
            disabled={!activeProject}
          >
            <span aria-hidden="true">01</span>
            Overview
          </button>
          <button
            type="button"
            className={view === "skills" ? "selected" : ""}
            onClick={() => onNavigate("skills")}
            disabled={!activeProject}
          >
            <span aria-hidden="true">02</span>
            Skills
          </button>
          <button
            type="button"
            className={view === "plan" ? "selected" : ""}
            onClick={() => onNavigate("plan")}
            disabled={!activeJob}
          >
            <span aria-hidden="true">03</span>
            Current job
          </button>
          <button
            type="button"
            className={view === "jobs" ? "selected" : ""}
            onClick={() => onNavigate("jobs")}
            disabled={!activeProject}
          >
            <span aria-hidden="true">04</span>
            Job history
          </button>
          <button
            type="button"
            className={view === "projects" ? "selected" : ""}
            onClick={() => onNavigate("projects")}
          >
            <span aria-hidden="true">05</span>
            Projects
          </button>
          <button
            type="button"
            className={view === "providers" ? "selected" : ""}
            onClick={() => onNavigate("providers")}
          >
            <span aria-hidden="true">06</span>
            LLM profiles
          </button>
          <button
            type="button"
            className={view === "settings" ? "selected" : ""}
            onClick={() => onNavigate("settings")}
          >
            <span aria-hidden="true">07</span>
            Settings
          </button>
        </nav>

        <div className="rail-context">
          <span className={`rail-run-state ${running ? "active" : ""}`}>
            <i aria-hidden="true" />
            {running ? "Job running" : "No active job"}
          </span>
          {activeJob ? (
            <small className="rail-job-name">
              {activeJob.skillName} · {activeJob.status.replace("_", " ")}
            </small>
          ) : null}
          <small>
            {activeProfile
              ? `${activeProfile.name} · ${activeProfile.defaultModel}`
              : "No LLM profile selected"}
          </small>
        </div>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  );
}

interface ProjectsPageProps {
  settings: ProjectSettings;
  profiles: ProviderProfileRecord[];
  busy: boolean;
  onAdd: () => void;
  onSelect: (projectId: string) => void;
  onSave: (project: ProjectUpdateInput) => void;
  onRelink: (projectId: string) => void;
  onRemove: (projectId: string) => void;
  onOpenPlan: () => void;
}

interface OverviewPageProps {
  project: ProjectRecord;
  profile?: ProviderProfileRecord;
  catalog?: SkillCatalog;
  jobs: JobRecord[];
  activeJob?: JobRecord;
  onNavigate: (view: AppView) => void;
}

export function OverviewPage({
  project,
  profile,
  catalog,
  jobs,
  activeJob,
  onNavigate,
}: OverviewPageProps) {
  const projectJobs = jobs.filter((job) => job.projectId === project.id);
  const runnableSkills =
    catalog?.entries.filter(
      (skill) => skill.status === "valid" && skill.planningSupported,
    ).length ?? 0;
  const completedJobs = projectJobs.filter((job) => job.status === "completed").length;
  const recentJobs = projectJobs.slice(0, 3);

  return (
    <main className="management-page overview-page">
      <header className="management-header overview-header">
        <div>
          <p className="eyebrow">Project overview</p>
          <h1>{project.name}</h1>
          <p>Choose a certified workflow, resume saved setup, or review previous planning runs.</p>
        </div>
        <button type="button" className="primary" onClick={() => onNavigate("skills")}>
          Browse skills
        </button>
      </header>

      <section className="overview-stats" aria-label="Project summary">
        <article>
          <span>Certified skills</span>
          <strong>{runnableSkills}</strong>
          <small>{catalog ? `${catalog.entries.length} catalog packages` : "Catalog loading"}</small>
        </article>
        <article>
          <span>Saved jobs</span>
          <strong>{projectJobs.length}</strong>
          <small>{completedJobs} completed</small>
        </article>
        <article>
          <span>Default LLM</span>
          <strong>{profile?.name ?? "Per job"}</strong>
          <small>{project.defaultModel ?? profile?.defaultModel ?? "Not configured"}</small>
        </article>
      </section>

      <div className="overview-grid">
        <section className="overview-panel">
          <div className="overview-panel-heading">
            <div>
              <p className="eyebrow">Repository</p>
              <h2>Project context</h2>
            </div>
            <button type="button" className="text-button" onClick={() => onNavigate("projects")}>
              Project settings
            </button>
          </div>
          <dl className="overview-context">
            <div><dt>Canonical root</dt><dd><code>{project.canonicalPath}</code></dd></div>
            <div><dt>Workspace</dt><dd><code>{project.workspacePath ?? "Repository root"}</code></dd></div>
            <div><dt>LLM profile</dt><dd>{profile ? `${profile.name} · ${profile.defaultModel}` : "Choose per job"}</dd></div>
          </dl>
        </section>

        <section className="overview-panel">
          <div className="overview-panel-heading">
            <div>
              <p className="eyebrow">Recent activity</p>
              <h2>Jobs</h2>
            </div>
            <button type="button" className="text-button" onClick={() => onNavigate("jobs")}>
              View history
            </button>
          </div>
          {recentJobs.length > 0 ? (
            <div className="overview-job-list">
              {recentJobs.map((job) => (
                <button type="button" key={job.id} onClick={() => onNavigate("jobs")}>
                  <span><strong>{job.skillName}</strong><small>{job.provider?.model ?? "Provider pending"}</small></span>
                  <i className={`job-status ${job.status}`}>{job.status.replace("_", " ")}</i>
                </button>
              ))}
            </div>
          ) : (
            <div className="overview-empty">
              <p>No jobs yet. Starting a skill creates a durable draft.</p>
              <button type="button" className="secondary" onClick={() => onNavigate("skills")}>
                Start the first job
              </button>
            </div>
          )}
          {activeJob ? (
            <button type="button" className="overview-current-job" onClick={() => onNavigate("plan")}>
              Continue {activeJob.skillName}
              <span>{activeJob.status.replace("_", " ")}</span>
            </button>
          ) : null}
        </section>
      </div>
    </main>
  );
}

interface SettingsPageProps {
  skillRoots: string[];
  applicationSettings: ApplicationSettings;
  providerCount: number;
  projectCount: number;
  jobCount: number;
  loading: boolean;
  onBrowseRoot: () => void;
  onAddRoot: () => void;
  onUpdateRoot: (index: number, value: string) => void;
  onRemoveRoot: (index: number) => void;
  onSaveRoots: () => void;
  onSaveApplicationSettings: (settings: ApplicationSettings) => void;
  onNavigate: (view: AppView) => void;
}

export function SettingsPage({
  skillRoots,
  applicationSettings,
  providerCount,
  projectCount,
  jobCount,
  loading,
  onBrowseRoot,
  onAddRoot,
  onUpdateRoot,
  onRemoveRoot,
  onSaveRoots,
  onSaveApplicationSettings,
  onNavigate,
}: SettingsPageProps) {
  const [retention, setRetention] = useState(applicationSettings.jobRetention);

  useEffect(() => {
    setRetention(applicationSettings.jobRetention);
  }, [applicationSettings]);

  const retentionIsValid =
    Number.isInteger(retention.maxTerminalJobs) &&
    retention.maxTerminalJobs >= 1 &&
    retention.maxTerminalJobs <= 10_000 &&
    (retention.maxAgeDays === undefined ||
      (Number.isInteger(retention.maxAgeDays) &&
        retention.maxAgeDays >= 1 &&
        retention.maxAgeDays <= 3_650));

  return (
    <main className="management-page settings-page">
      <header className="management-header">
        <div>
          <p className="eyebrow">Application configuration</p>
          <h1>Settings</h1>
          <p>Manage global skill sources and review app-owned configuration and safety boundaries.</p>
        </div>
      </header>

      <div className="settings-grid">
        <section className="settings-panel settings-skill-sources">
          <div className="settings-panel-heading">
            <div>
              <p className="eyebrow">Discovery</p>
              <h2>Skill sources</h2>
            </div>
            <span>{skillRoots.length} configured</span>
          </div>
          <p>Every root is scanned recursively. Package scripts remain inert during discovery.</p>
          <div className="root-list">
            {skillRoots.length === 0 ? (
              <p className="empty-copy">No skill roots configured.</p>
            ) : (
              skillRoots.map((root, index) => (
                <div className="root-row" key={`${root}-${index}`}>
                  <label className="sr-only" htmlFor={`settings-skill-root-${index}`}>
                    Skill root {index + 1}
                  </label>
                  <input
                    id={`settings-skill-root-${index}`}
                    value={root}
                    onChange={(event) => onUpdateRoot(index, event.target.value)}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => onRemoveRoot(index)}
                    aria-label={`Remove skill root ${root || index + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="root-actions">
            <button type="button" className="secondary" onClick={onBrowseRoot}>Browse root</button>
            <button type="button" className="secondary" onClick={onAddRoot}>Enter path</button>
            <button type="button" className="primary" onClick={onSaveRoots} disabled={loading}>
              {loading ? "Scanning…" : "Save & scan"}
            </button>
          </div>
        </section>

        <section className="settings-panel retention-panel">
          <div className="settings-panel-heading">
            <div><p className="eyebrow">Storage policy</p><h2>Job-history retention</h2></div>
            <span>{retention.enabled ? "Enabled" : "Off"}</span>
          </div>
          <p>Cleanup applies only to completed, failed, cancelled, or blocked history. Drafts, ready jobs, interrupted jobs, active work, and separately stored immutable plan artifacts are preserved.</p>
          <label className="retention-toggle">
            <input
              type="checkbox"
              checked={retention.enabled}
              onChange={(event) =>
                setRetention((current) => ({ ...current, enabled: event.target.checked }))
              }
              disabled={loading}
            />
            <span>Automatically clean terminal job history when history is loaded</span>
          </label>
          <div className="retention-fields">
            <label className="field" htmlFor="retention-max-jobs">
              <span>Keep newest terminal jobs</span>
              <input
                id="retention-max-jobs"
                type="number"
                min={1}
                max={10_000}
                value={
                  Number.isFinite(retention.maxTerminalJobs)
                    ? retention.maxTerminalJobs
                    : ""
                }
                onChange={(event) =>
                  setRetention((current) => ({
                    ...current,
                    maxTerminalJobs: event.target.valueAsNumber,
                  }))
                }
                disabled={loading || !retention.enabled}
              />
            </label>
            <label className="field" htmlFor="retention-max-age">
              <span>Maximum age in days</span>
              <input
                id="retention-max-age"
                type="number"
                min={1}
                max={3_650}
                value={
                  retention.maxAgeDays !== undefined &&
                  Number.isFinite(retention.maxAgeDays)
                    ? retention.maxAgeDays
                    : ""
                }
                placeholder="Never expire by age"
                onChange={(event) =>
                  setRetention((current) => ({
                    ...current,
                    maxAgeDays: event.target.value
                      ? event.target.valueAsNumber
                      : undefined,
                  }))
                }
                disabled={loading || !retention.enabled}
              />
              <small>Leave empty to limit by count only.</small>
            </label>
          </div>
          <button
            type="button"
            className="primary settings-save"
            onClick={() =>
              onSaveApplicationSettings({
                version: applicationSettings.version,
                jobRetention: retention,
              })
            }
            disabled={loading || !retentionIsValid}
          >
            {loading ? "Saving…" : "Save retention policy"}
          </button>
        </section>

        <section className="settings-panel">
          <div className="settings-panel-heading">
            <div><p className="eyebrow">Reusable configuration</p><h2>LLM profiles</h2></div>
            <span>{providerCount}</span>
          </div>
          <p>Profiles store endpoints, model defaults, and credential references—not secret values.</p>
          <button type="button" className="secondary" onClick={() => onNavigate("providers")}>
            Manage LLM profiles
          </button>
        </section>

        <section className="settings-panel">
          <div className="settings-panel-heading">
            <div><p className="eyebrow">Workspace</p><h2>Projects and history</h2></div>
            <span>{projectCount} projects · {jobCount} jobs</span>
          </div>
          <p>Removing a project never deletes repository files. Deleting job history leaves separately stored immutable plan artifacts untouched.</p>
          <div className="settings-actions">
            <button type="button" className="secondary" onClick={() => onNavigate("projects")}>Manage projects</button>
            <button type="button" className="secondary" onClick={() => onNavigate("jobs")}>Review job history</button>
          </div>
        </section>

        <section className="settings-panel safety-panel">
          <div className="settings-panel-heading">
            <div><p className="eyebrow">Current safety boundary</p><h2>Plan-only engine</h2></div>
            <span>Apply disabled</span>
          </div>
          <p>Guided and Continuous Apply remain unavailable until isolated writes, structured commands, verification, and recovery are certified.</p>
        </section>
      </div>
    </main>
  );
}

interface ProjectEditorProps {
  project: ProjectRecord;
  profiles: ProviderProfileRecord[];
  busy: boolean;
  onSave: (project: ProjectUpdateInput) => void;
  onRelink: (projectId: string) => void;
  onCancel: () => void;
}

export function ProjectEditor({
  project,
  profiles,
  busy,
  onSave,
  onRelink,
  onCancel,
}: ProjectEditorProps) {
  const [name, setName] = useState(project.name);
  const [defaultProviderProfileId, setDefaultProviderProfileId] = useState(
    project.defaultProviderProfileId ?? "",
  );
  const [defaultModel, setDefaultModel] = useState(project.defaultModel ?? "");
  const selectedProfile = profiles.find(
    (profile) => profile.id === defaultProviderProfileId,
  );

  return (
    <div className="project-editor" aria-label={`Edit ${project.name}`}>
      <label className="field" htmlFor={`project-name-${project.id}`}>
        <span>Project name</span>
        <input
          id={`project-name-${project.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
      </label>
      <label className="field" htmlFor={`project-profile-${project.id}`}>
        <span>Default LLM profile</span>
        <select
          id={`project-profile-${project.id}`}
          value={defaultProviderProfileId}
          onChange={(event) => {
            setDefaultProviderProfileId(event.target.value);
            setDefaultModel("");
          }}
          disabled={busy}
        >
          <option value="">Choose per job</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.defaultModel}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor={`project-model-${project.id}`}>
        <span>Default model override</span>
        <input
          id={`project-model-${project.id}`}
          value={defaultModel}
          onChange={(event) => setDefaultModel(event.target.value)}
          placeholder={selectedProfile?.defaultModel ?? "Select a profile first"}
          disabled={busy || !selectedProfile}
          spellCheck={false}
        />
        <small>Leave empty to follow the profile default.</small>
      </label>
      <div className="project-editor-path">
        <span>Repository path</span>
        <code>{project.canonicalPath}</code>
        <button
          type="button"
          className="text-button"
          onClick={() => onRelink(project.id)}
          disabled={busy}
        >
          Relink folder
        </button>
      </div>
      <div className="project-editor-actions">
        <button
          type="button"
          className="primary"
          onClick={() =>
            onSave({
              id: project.id,
              name,
              defaultProviderProfileId: defaultProviderProfileId || undefined,
              defaultModel:
                defaultProviderProfileId && defaultModel.trim()
                  ? defaultModel
                  : undefined,
            })
          }
          disabled={busy || !name.trim()}
        >
          {busy ? "Saving…" : "Save project"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ProjectsPage({
  settings,
  profiles,
  busy,
  onAdd,
  onSelect,
  onSave,
  onRelink,
  onRemove,
  onOpenPlan,
}: ProjectsPageProps) {
  const [editingProjectId, setEditingProjectId] = useState("");

  useEffect(() => {
    if (
      editingProjectId &&
      !settings.projects.some((project) => project.id === editingProjectId)
    ) {
      setEditingProjectId("");
    }
  }, [editingProjectId, settings.projects]);

  return (
    <main className="management-page">
      <header className="management-header">
        <div>
          <p className="eyebrow">Project library</p>
          <h1>Your codebases</h1>
          <p>
            Add repository paths once, then switch projects without rebuilding job
            setup.
          </p>
        </div>
        <button type="button" className="primary" onClick={onAdd} disabled={busy}>
          {busy ? "Adding…" : "Add project"}
        </button>
      </header>

      {settings.projects.length === 0 ? (
        <section className="management-empty">
          <span aria-hidden="true">+</span>
          <h2>No saved projects yet</h2>
          <p>Select a repository folder. The desktop host will resolve and persist its canonical path.</p>
          <button type="button" className="primary" onClick={onAdd} disabled={busy}>
            Add your first project
          </button>
        </section>
      ) : (
        <section className="management-grid" aria-label="Saved projects">
          {settings.projects.map((project) => {
            const active = project.id === settings.activeProjectId;
            const defaultProfile = profiles.find(
              (profile) => profile.id === project.defaultProviderProfileId,
            );
            const editing = editingProjectId === project.id;
            return (
              <article className={`management-card ${active ? "active" : ""}`} key={project.id}>
                <div className="management-card-heading">
                  <div>
                    <span className="card-kicker">{active ? "Active project" : "Saved project"}</span>
                    <h2>{project.name}</h2>
                  </div>
                  <span className={`availability ${active ? "ready" : "saved"}`}>
                    {active ? "Selected" : "Saved"}
                  </span>
                </div>
                <code className="management-path">{project.canonicalPath}</code>
                <dl className="compact-meta">
                  <div>
                    <dt>Workspace</dt>
                    <dd>{project.workspacePath ?? "Repository root"}</dd>
                  </div>
                  <div>
                    <dt>Default LLM</dt>
                    <dd>
                      {defaultProfile
                        ? `${defaultProfile.name} · ${project.defaultModel ?? defaultProfile.defaultModel}`
                        : "Choose per job"}
                    </dd>
                  </div>
                </dl>
                {editing ? (
                  <ProjectEditor
                    project={project}
                    profiles={profiles}
                    busy={busy}
                    onSave={(input) => {
                      onSave(input);
                      setEditingProjectId("");
                    }}
                    onRelink={onRelink}
                    onCancel={() => setEditingProjectId("")}
                  />
                ) : null}
                <div className="management-actions">
                  {active ? (
                    <button type="button" className="primary" onClick={onOpenPlan}>
                      Open skills
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => onSelect(project.id)}
                      disabled={busy}
                    >
                      Switch to project
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setEditingProjectId(editing ? "" : project.id)}
                    disabled={busy}
                  >
                    {editing ? "Close settings" : "Project settings"}
                  </button>
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() => onRemove(project.id)}
                    disabled={busy}
                  >
                    Remove from app
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

interface ProviderProfilesPageProps {
  profiles: ProviderProfileRecord[];
  selectedProfileId: string;
  credentialStatus?: ProviderCredentialStatus;
  busy: boolean;
  onSelect: (profileId: string) => void;
  onSave: (input: ProviderProfileInput) => void;
  onDelete: (profileId: string) => void;
  onSaveCredential: (profileId: string, secret: string) => void;
  onDeleteCredential: (profileId: string) => void;
}

const EMPTY_PROFILE: ProviderProfileInput = {
  name: "",
  kind: "local",
  endpoint: "http://127.0.0.1:1234/v1",
  defaultModel: "",
  credentialRef: "environment:LOCAL_LLM_API_KEY",
};

export function ProviderProfilesPage({
  profiles,
  selectedProfileId,
  credentialStatus,
  busy,
  onSelect,
  onSave,
  onDelete,
  onSaveCredential,
  onDeleteCredential,
}: ProviderProfilesPageProps) {
  const [form, setForm] = useState<ProviderProfileInput>(EMPTY_PROFILE);
  const credentialInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (credentialInput.current) credentialInput.current.value = "";
    const selected = profiles.find((profile) => profile.id === selectedProfileId);
    if (!selected) {
      setForm((current) =>
        current.id && !profiles.some((profile) => profile.id === current.id)
          ? EMPTY_PROFILE
          : current,
      );
      return;
    }
    setForm({
      id: selected.id,
      name: selected.name,
      kind: selected.kind,
      endpoint: selected.endpoint,
      defaultModel: selected.defaultModel,
      credentialRef: selected.credentialRef,
    });
  }, [profiles, selectedProfileId]);

  const chooseKind = (kind: ProviderKind) => {
    setForm((current) => ({
      ...current,
      kind,
      endpoint:
        kind === "local"
          ? current.endpoint ?? "http://127.0.0.1:1234/v1"
          : undefined,
      credentialRef:
        kind === "claude"
          ? "environment:ANTHROPIC_API_KEY"
          : kind === "codex"
            ? "environment:OPENAI_API_KEY"
          : "environment:LOCAL_LLM_API_KEY",
      defaultModel:
        current.kind === kind
          ? current.defaultModel
          : kind === "claude"
            ? "sonnet"
            : kind === "codex"
              ? "gpt-5.6-terra"
            : "",
    }));
  };

  const startNew = () => {
    onSelect("");
    setForm(EMPTY_PROFILE);
  };

  const canSave =
    form.name.trim().length > 0 &&
    form.defaultModel.trim().length > 0 &&
    (form.kind !== "local" || Boolean(form.endpoint?.trim()));
  const currentCredentialStatus =
    credentialStatus?.profileId === form.id ? credentialStatus : undefined;
  const credentialLabel = !currentCredentialStatus
    ? "Checking status..."
    : currentCredentialStatus.source === "windowsVault"
      ? currentCredentialStatus.configured
        ? "Stored in Windows vault"
        : "Vault entry unavailable"
      : currentCredentialStatus.source === "environment"
        ? currentCredentialStatus.configured
          ? "Available from environment"
          : "Environment key missing"
        : "Not configured";

  const submitCredential = () => {
    const input = credentialInput.current;
    const submitted = input?.value ?? "";
    if (!form.id || !input || !submitted) return;
    input.value = "";
    onSaveCredential(form.id, submitted);
  };

  return (
    <main className="management-page provider-page">
      <header className="management-header">
        <div>
          <p className="eyebrow">Reusable configuration</p>
          <h1>LLM profiles</h1>
          <p>Create cloud and local runtime profiles once, then select one for each job.</p>
        </div>
        <button type="button" className="secondary" onClick={startNew}>
          New profile
        </button>
      </header>

      <div className="provider-management">
        <section className="profile-list" aria-label="Saved LLM profiles">
          {profiles.length === 0 ? (
            <div className="profile-list-empty">No profiles saved.</div>
          ) : (
            profiles.map((profile) => (
              <button
                type="button"
                key={profile.id}
                className={profile.id === selectedProfileId ? "selected" : ""}
                onClick={() => onSelect(profile.id)}
              >
                <span>
                  <strong>{profile.name}</strong>
                  <small>
                    {profile.kind === "claude"
                      ? "Claude"
                      : profile.kind === "codex"
                        ? "Codex SDK"
                        : "Local bridge"}
                  </small>
                </span>
                <code>{profile.defaultModel}</code>
              </button>
            ))
          )}
        </section>

        <section className="profile-editor" aria-labelledby="profile-editor-heading">
          <div className="profile-editor-heading">
            <div>
              <p className="eyebrow">{form.id ? `Revision ${profiles.find((profile) => profile.id === form.id)?.revision ?? 1}` : "New profile"}</p>
              <h2 id="profile-editor-heading">{form.id ? "Edit profile" : "Configure profile"}</h2>
            </div>
            {form.id ? (
              <button
                type="button"
                className="text-button danger-text"
                onClick={() => onDelete(form.id!)}
                disabled={busy}
              >
                Delete
              </button>
            ) : null}
          </div>

          <label className="field" htmlFor="profile-name">
            <span>Profile name</span>
            <input
              id="profile-name"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="My local workstation"
            />
          </label>

          <div className="segmented" role="group" aria-label="Profile provider">
            <button
              type="button"
              className={form.kind === "local" ? "selected" : ""}
              aria-pressed={form.kind === "local"}
              onClick={() => chooseKind("local")}
            >
              Local bridge
            </button>
            <button
              type="button"
              className={form.kind === "claude" ? "selected" : ""}
              aria-pressed={form.kind === "claude"}
              onClick={() => chooseKind("claude")}
            >
              Claude
            </button>
            <button
              type="button"
              className={form.kind === "codex" ? "selected" : ""}
              aria-pressed={form.kind === "codex"}
              onClick={() => chooseKind("codex")}
            >
              Codex SDK
            </button>
          </div>

          {form.kind === "local" ? (
            <label className="field" htmlFor="profile-endpoint">
              <span>OpenAI-compatible loopback endpoint</span>
              <input
                id="profile-endpoint"
                value={form.endpoint ?? ""}
                onChange={(event) => setForm((current) => ({ ...current, endpoint: event.target.value }))}
                spellCheck={false}
              />
            </label>
          ) : null}

          <label className="field" htmlFor="profile-model">
            <span>Default model ID</span>
            <input
              id="profile-model"
              value={form.defaultModel}
              onChange={(event) => setForm((current) => ({ ...current, defaultModel: event.target.value }))}
              placeholder={
                form.kind === "claude"
                  ? "sonnet"
                  : form.kind === "codex"
                    ? "gpt-5.6-terra"
                    : "Loaded model ID"
              }
              spellCheck={false}
            />
          </label>

          <div className="credential-note">
            <div className="credential-status-row">
              <strong>Profile credential</strong>
              <span
                className={currentCredentialStatus?.configured ? "configured" : ""}
              >
                {form.id ? credentialLabel : "Save the profile first"}
              </span>
            </div>
            <p>
              Secrets are stored under this profile in Windows Credential Manager. Only the
              selected provider receives its credential in the trusted child-process environment.
            </p>
            {form.id ? (
              <div className="credential-entry">
                <label className="field" htmlFor="profile-credential">
                  <span>Replace credential</span>
                  <input
                    id="profile-credential"
                    ref={credentialInput}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder="Paste API key"
                    disabled={busy}
                  />
                </label>
                <div className="credential-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={submitCredential}
                    disabled={busy}
                  >
                    Save to Windows vault
                  </button>
                  {currentCredentialStatus && currentCredentialStatus.source !== "none" ? (
                    <button
                      type="button"
                      className="text-button danger-text"
                      onClick={() => onDeleteCredential(form.id!)}
                      disabled={busy}
                    >
                      Remove credential
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="primary profile-save"
            onClick={() => onSave(form)}
            disabled={!canSave || busy}
          >
            {busy ? "Saving…" : form.id ? "Save new revision" : "Save profile"}
          </button>
        </section>
      </div>
    </main>
  );
}

interface SkillsPageProps {
  projectName: string;
  catalog?: SkillCatalog;
  skillRoots: string[];
  loading: boolean;
  starting: boolean;
  onRefresh: () => void;
  onStartJob: (skill: SkillCatalogEntry) => void;
  onBrowseRoot: () => void;
  onAddRoot: () => void;
  onUpdateRoot: (index: number, value: string) => void;
  onRemoveRoot: (index: number) => void;
  onSaveRoots: () => void;
}

function runnableSkill(skill: SkillCatalogEntry): boolean {
  return (
    skill.status === "valid" &&
    skill.planningSupported &&
    Boolean(skill.id && skill.name && skill.digest && skill.rootPath)
  );
}

function skillName(skill: SkillCatalogEntry): string {
  return (
    skill.presentation?.displayName ??
    skill.name ??
    skill.manifestPath ??
    "Unnamed skill"
  );
}

export function SkillsPage({
  projectName,
  catalog,
  skillRoots,
  loading,
  starting,
  onRefresh,
  onStartJob,
  onBrowseRoot,
  onAddRoot,
  onUpdateRoot,
  onRemoveRoot,
  onSaveRoots,
}: SkillsPageProps) {
  const [query, setQuery] = useState("");
  const [catalogScope, setCatalogScope] = useState<"runnable" | "all">("runnable");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const catalogEntries = catalog?.entries ?? [];
  const runnableCount = catalogEntries.filter(runnableSkill).length;
  const skills = catalogEntries
    .filter((skill) => catalogScope === "all" || runnableSkill(skill))
    .filter((skill) => {
      if (!normalizedQuery) return true;
      return [skillName(skill), skill.description, skill.id]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    });

  return (
    <main className="management-page skills-page">
      <header className="management-header">
        <div>
          <p className="eyebrow">{projectName}</p>
          <h1>Available skills</h1>
          <p>
            Browse every package for this project. Starting a skill creates a durable
            draft; repository applicability is confirmed during preflight.
          </p>
        </div>
        <button type="button" className="secondary" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh catalog"}
        </button>
      </header>

      <div className="catalog-toolbar">
        <div className="catalog-search">
          <label className="sr-only" htmlFor="skill-search">Search skills</label>
          <input
            id="skill-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by skill name or purpose"
          />
        </div>
        <div className="catalog-scope" role="group" aria-label="Skill catalog scope">
          <button
            type="button"
            className={catalogScope === "runnable" ? "selected" : ""}
            aria-pressed={catalogScope === "runnable"}
            onClick={() => setCatalogScope("runnable")}
          >
            Runnable <span>{runnableCount}</span>
          </button>
          <button
            type="button"
            className={catalogScope === "all" ? "selected" : ""}
            aria-pressed={catalogScope === "all"}
            onClick={() => setCatalogScope("all")}
          >
            All packages <span>{catalogEntries.length}</span>
          </button>
        </div>
      </div>

      <details className="root-manager page-root-manager">
        <summary>
          Skill sources <span>{skillRoots.length}</span>
        </summary>
        <div className="root-list">
          {skillRoots.length === 0 ? (
            <p className="empty-copy">No skill roots configured.</p>
          ) : (
            skillRoots.map((root, index) => (
              <div className="root-row" key={`${root}-${index}`}>
                <label className="sr-only" htmlFor={`page-skill-root-${index}`}>
                  Skill root {index + 1}
                </label>
                <input
                  id={`page-skill-root-${index}`}
                  value={root}
                  onChange={(event) => onUpdateRoot(index, event.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => onRemoveRoot(index)}
                  aria-label={`Remove skill root ${root || index + 1}`}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
        <div className="root-actions">
          <button type="button" className="secondary" onClick={onBrowseRoot}>Browse root</button>
          <button type="button" className="secondary" onClick={onAddRoot}>Enter path</button>
          <button type="button" className="secondary emphasize" onClick={onSaveRoots} disabled={loading}>
            Save &amp; scan
          </button>
        </div>
      </details>

      {loading && !catalog ? (
        <section className="management-empty compact-empty">
          <h2>Scanning skill sources</h2>
          <p>The validated project catalog will appear here.</p>
        </section>
      ) : skills.length === 0 ? (
        <section className="management-empty compact-empty">
          <h2>No matching skills</h2>
          <p>
            {catalogScope === "runnable"
              ? "No certified plan workflows match. View all packages to inspect unavailable skills."
              : "Refresh configured skill roots or change the search query."}
          </p>
        </section>
      ) : (
        <section className="skills-grid" aria-label="Project skill catalog">
          {skills.map((skill) => {
            const runnable = runnableSkill(skill);
            const summary =
              skill.presentation?.shortDescription ??
              skill.description ??
              skill.issues[0]?.message ??
              "No description supplied.";
            return (
              <article className={`project-skill-card ${runnable ? "ready" : "unavailable"}`} key={skill.id}>
                <div className="project-skill-heading">
                  <div>
                    <span className="card-kicker">
                      {runnable ? "Certified workflow" : "Catalog package"}
                    </span>
                    <h2>{skillName(skill)}</h2>
                  </div>
                  <span className={`skill-mode-badge ${runnable ? "ready" : "blocked"}`}>
                    {runnable ? "Plan supported" : skill.status}
                  </span>
                </div>
                <p title={summary}>{summary}</p>
                <div className="project-skill-meta">
                  <code title={skill.digest}>{shortDigest(skill.digest)}</code>
                  <span>{skill.fileCount} files · {formatBytes(skill.totalBytes)}</span>
                </div>
                <details className="skill-details">
                  <summary>Package details</summary>
                  <dl>
                    <div><dt>Package ID</dt><dd><code>{skill.id}</code></dd></div>
                    <div><dt>Source</dt><dd><code>{skill.rootPath}</code></dd></div>
                    <div><dt>Manifest</dt><dd><code>{skill.manifestPath}</code></dd></div>
                    <div><dt>Execution</dt><dd>{skill.planningSupported ? "Certified plan-only" : "Not certified"}</dd></div>
                  </dl>
                  {skill.description && skill.description !== summary ? (
                    <p className="skill-full-description">{skill.description}</p>
                  ) : null}
                  {skill.issues.length > 0 ? (
                    <ul>{skill.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>
                  ) : null}
                </details>
                <div className="project-skill-actions">
                  <span>
                    {runnable
                      ? "Creates a saved draft"
                      : skill.issues[0]?.message ?? "This package is not certified for planning."}
                  </span>
                  {runnable ? (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => onStartJob(skill)}
                      disabled={starting}
                    >
                      {starting ? "Creating…" : "Start job"}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

interface JobsPageProps {
  jobs: JobRecord[];
  activeProjectId: string;
  selectedJobId: string;
  resultText: string;
  loadingResult: boolean;
  onSelectJob: (jobId: string) => void;
  onOpenJob: (jobId: string) => void;
  onDeleteJob: (jobId: string) => void;
}

function jobTimestamp(value: number): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export function JobsPage({
  jobs,
  activeProjectId,
  selectedJobId,
  resultText,
  loadingResult,
  onSelectJob,
  onOpenJob,
  onDeleteJob,
}: JobsPageProps) {
  const [showAllProjects, setShowAllProjects] = useState(false);
  const visibleJobs = showAllProjects
    ? jobs
    : jobs.filter((job) => job.projectId === activeProjectId);
  const selected = jobs.find((job) => job.id === selectedJobId);

  return (
    <main className="management-page jobs-page">
      <header className="management-header jobs-header">
        <div>
          <p className="eyebrow">Durable workflow history</p>
          <h1>Jobs</h1>
          <p>Return to drafts, inspect completed plans, and review failed or cancelled attempts.</p>
        </div>
        <label className="history-scope">
          <input
            type="checkbox"
            checked={showAllProjects}
            onChange={(event) => setShowAllProjects(event.target.checked)}
          />
          <span>All projects</span>
        </label>
      </header>

      {visibleJobs.length === 0 ? (
        <section className="management-empty compact-empty">
          <h2>No jobs for this project</h2>
          <p>Start a skill to create the first durable draft.</p>
        </section>
      ) : (
        <div className="jobs-layout">
          <section className="job-list" aria-label="Job history">
            {visibleJobs.map((job) => (
              <button
                type="button"
                className={job.id === selectedJobId ? "selected" : ""}
                key={job.id}
                onClick={() => onSelectJob(job.id)}
              >
                <span className="job-list-heading">
                  <strong>{job.skillName}</strong>
                  <i className={`job-status ${job.status}`}>{job.status.replace("_", " ")}</i>
                </span>
                <small>{job.projectName} · {job.provider?.model ?? "Provider not selected"}</small>
                <time>{jobTimestamp(job.updatedAt)}</time>
              </button>
            ))}
          </section>

          <section className="job-history-detail">
            {selected ? (
              <>
                <div className="job-detail-heading">
                  <div>
                    <p className="eyebrow">{selected.id.slice(0, 12)}</p>
                    <h2>{selected.skillName}</h2>
                  </div>
                  <div className="job-detail-actions">
                    {selected.status === "draft" ||
                    selected.status === "ready" ||
                    selected.status === "interrupted" ? (
                      <button type="button" className="primary" onClick={() => onOpenJob(selected.id)}>
                        {selected.status === "interrupted"
                          ? "Restart from setup"
                          : "Resume setup"}
                      </button>
                    ) : null}
                    {selected.status !== "planning" ? (
                      <button
                        type="button"
                        className="text-button danger-text"
                        onClick={() => onDeleteJob(selected.id)}
                      >
                        Delete history
                      </button>
                    ) : null}
                  </div>
                </div>
                <dl className="job-detail-meta">
                  <div><dt>Status</dt><dd>{selected.status.replace("_", " ")}</dd></div>
                  <div><dt>Mode</dt><dd>{selected.runMode} · {selected.approvalMode}</dd></div>
                  <div><dt>Provider</dt><dd>{selected.provider ? `${selected.provider.profileName} / ${selected.provider.model}` : "Not selected"}</dd></div>
                  <div><dt>Updated</dt><dd>{jobTimestamp(selected.updatedAt)}</dd></div>
                </dl>
                {selected.lastError ? <div className="history-error">{selected.lastError}</div> : null}
                {!loadingResult && resultText ? (
                  <MarkdownChecklist markdown={resultText} />
                ) : null}
                <article className={`history-result ${resultText ? "has-result" : ""}`}>
                  {loadingResult
                    ? "Loading saved result…"
                    : resultText || "This job does not have a terminal result yet."}
                </article>
                {selected.artifactPaths.length > 0 ? (
                  <details className="history-artifacts">
                    <summary>Saved artifacts <span>{selected.artifactPaths.length}</span></summary>
                    {selected.artifactPaths.map((path) => <code key={path}>{path}</code>)}
                  </details>
                ) : null}
              </>
            ) : (
              <div className="job-detail-empty">Choose a job to inspect its saved state.</div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
