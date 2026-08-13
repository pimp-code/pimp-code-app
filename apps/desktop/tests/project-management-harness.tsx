import { renderToStaticMarkup } from "react-dom/server";

import {
  JobsPage,
  OverviewPage,
  ProjectEditor,
  ProjectsPage,
  SettingsPage,
} from "../src/AppShell";
import type { JobRecord, ProjectRecord, ProviderProfileRecord } from "../src/contracts";

const project: ProjectRecord = {
  id: "5d6260e5-cadc-46e8-a661-38612af1bd09",
  name: "Fixture",
  configuredPath: "C:\\fixture",
  canonicalPath: "C:\\fixture",
  defaultProviderProfileId: "9ac14f43-e848-41b8-a0c1-036a47322d0c",
  createdAt: 1,
  updatedAt: 2,
};

const profile: ProviderProfileRecord = {
  id: "9ac14f43-e848-41b8-a0c1-036a47322d0c",
  name: "Local workstation",
  kind: "local",
  endpoint: "http://127.0.0.1:1234/v1",
  defaultModel: "fixture-model",
  revision: 1,
  createdAt: 1,
  updatedAt: 2,
};

const noop = () => undefined;

export function renderProjectLibrary(): string {
  return renderToStaticMarkup(
    <ProjectsPage
      settings={{
        version: 1,
        activeProjectId: project.id,
        projects: [project],
      }}
      profiles={[profile]}
      busy={false}
      onAdd={noop}
      onSelect={noop}
      onSave={noop}
      onRelink={noop}
      onRemove={noop}
      onOpenPlan={noop}
    />,
  );
}

export function renderProjectEditor(): string {
  return renderToStaticMarkup(
    <ProjectEditor
      project={project}
      profiles={[profile]}
      busy={false}
      onSave={noop}
      onRelink={noop}
      onCancel={noop}
    />,
  );
}

export function renderInterruptedJob(): string {
  const job: JobRecord = {
    id: "8e29df03-20e2-43a4-9108-382f7ccdbf14",
    projectId: project.id,
    projectName: project.name,
    canonicalRepository: project.canonicalPath,
    skillId: "migrate-to-vite",
    skillName: "Migrate to Vite",
    skillDigest: "a".repeat(64),
    skillRoot: "C:\\skills",
    runMode: "plan",
    approvalMode: "guided",
    maxTurns: 10,
    status: "interrupted",
    currentStage: "interrupted",
    attempts: [],
    artifactPaths: [],
    lastError: "The host restarted.",
    createdAt: 1,
    updatedAt: 2,
  };
  return renderToStaticMarkup(
    <JobsPage
      jobs={[job]}
      activeProjectId={project.id}
      selectedJobId={job.id}
      resultText=""
      loadingResult={false}
      onSelectJob={noop}
      onOpenJob={noop}
      onDeleteJob={noop}
    />,
  );
}

export function renderProjectOverview(): string {
  return renderToStaticMarkup(
    <OverviewPage
      project={project}
      profile={profile}
      jobs={[]}
      onNavigate={noop}
    />,
  );
}

export function renderSettingsPage(): string {
  return renderToStaticMarkup(
    <SettingsPage
      skillRoots={["C:\\skills"]}
      applicationSettings={{
        version: 1,
        jobRetention: {
          enabled: true,
          maxTerminalJobs: 250,
          maxAgeDays: 180,
        },
      }}
      providerCount={1}
      projectCount={2}
      jobCount={3}
      loading={false}
      onBrowseRoot={noop}
      onAddRoot={noop}
      onUpdateRoot={noop}
      onRemoveRoot={noop}
      onSaveRoots={noop}
      onSaveApplicationSettings={noop}
      onNavigate={noop}
    />,
  );
}
