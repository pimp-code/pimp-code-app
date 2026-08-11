import { useEffect, useState, type ReactNode } from "react";
import type {
  JobRecord,
  ProjectRecord,
  ProjectSettings,
  ProviderKind,
  ProviderProfileInput,
  ProviderProfileRecord,
  SkillCatalog,
  SkillCatalogEntry,
} from "./contracts";
import { formatBytes, shortDigest } from "./contracts";

export type AppView = "skills" | "plan" | "jobs" | "projects" | "providers";

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
            className={view === "skills" ? "selected" : ""}
            onClick={() => onNavigate("skills")}
            disabled={!activeProject}
          >
            <span aria-hidden="true">01</span>
            Skills
          </button>
          <button
            type="button"
            className={view === "plan" ? "selected" : ""}
            onClick={() => onNavigate("plan")}
            disabled={!activeJob}
          >
            <span aria-hidden="true">02</span>
            Current job
          </button>
          <button
            type="button"
            className={view === "jobs" ? "selected" : ""}
            onClick={() => onNavigate("jobs")}
            disabled={!activeProject}
          >
            <span aria-hidden="true">03</span>
            Job history
          </button>
          <button
            type="button"
            className={view === "projects" ? "selected" : ""}
            onClick={() => onNavigate("projects")}
          >
            <span aria-hidden="true">04</span>
            Projects
          </button>
          <button
            type="button"
            className={view === "providers" ? "selected" : ""}
            onClick={() => onNavigate("providers")}
          >
            <span aria-hidden="true">05</span>
            LLM profiles
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
  busy: boolean;
  onAdd: () => void;
  onSelect: (projectId: string) => void;
  onRemove: (projectId: string) => void;
  onOpenPlan: () => void;
}

export function ProjectsPage({
  settings,
  busy,
  onAdd,
  onSelect,
  onRemove,
  onOpenPlan,
}: ProjectsPageProps) {
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
                    <dd>{project.defaultModel ?? "Choose per job"}</dd>
                  </div>
                </dl>
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
  busy: boolean;
  onSelect: (profileId: string) => void;
  onSave: (input: ProviderProfileInput) => void;
  onDelete: (profileId: string) => void;
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
  busy,
  onSelect,
  onSave,
  onDelete,
}: ProviderProfilesPageProps) {
  const [form, setForm] = useState<ProviderProfileInput>(EMPTY_PROFILE);

  useEffect(() => {
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
          : "environment:LOCAL_LLM_API_KEY",
      defaultModel:
        current.kind === kind
          ? current.defaultModel
          : kind === "claude"
            ? "sonnet"
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
    (form.kind === "claude" || Boolean(form.endpoint?.trim()));

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
                  <small>{profile.kind === "claude" ? "Claude" : "Local bridge"}</small>
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
              placeholder={form.kind === "claude" ? "sonnet" : "Loaded model ID"}
              spellCheck={false}
            />
          </label>

          <div className="credential-note">
            <strong>Credentials are not stored here</strong>
            <p>
              This profile stores only a credential reference. The current runtime resolves
              <code>{form.credentialRef}</code> from the trusted host environment; OS-vault secret entry is a separate implementation step.
            </p>
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
                  {selected.status === "draft" || selected.status === "ready" ? (
                    <button type="button" className="primary" onClick={() => onOpenJob(selected.id)}>
                      Resume setup
                    </button>
                  ) : null}
                </div>
                <dl className="job-detail-meta">
                  <div><dt>Status</dt><dd>{selected.status.replace("_", " ")}</dd></div>
                  <div><dt>Mode</dt><dd>{selected.runMode} · {selected.approvalMode}</dd></div>
                  <div><dt>Provider</dt><dd>{selected.provider ? `${selected.provider.profileName} / ${selected.provider.model}` : "Not selected"}</dd></div>
                  <div><dt>Updated</dt><dd>{jobTimestamp(selected.updatedAt)}</dd></div>
                </dl>
                {selected.lastError ? <div className="history-error">{selected.lastError}</div> : null}
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
