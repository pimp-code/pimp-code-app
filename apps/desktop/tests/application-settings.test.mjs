import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeApplicationSettings,
  normalizeJobStore,
  normalizeProviderProfileSettings,
} from "../src/contracts.ts";

test("normalizes persisted job-retention settings", () => {
  assert.deepEqual(
    normalizeApplicationSettings({
      version: 1,
      jobRetention: {
        enabled: true,
        maxTerminalJobs: 250,
        maxAgeDays: 180,
      },
    }),
    {
      version: 1,
      jobRetention: {
        enabled: true,
        maxTerminalJobs: 250,
        maxAgeDays: 180,
      },
    },
  );
});

test("uses safe defaults for invalid retention limits", () => {
  assert.deepEqual(
    normalizeApplicationSettings({
      version: 1,
      job_retention: {
        enabled: true,
        max_terminal_jobs: 0,
        max_age_days: 50_000,
      },
    }).jobRetention,
    {
      enabled: true,
      maxTerminalJobs: 500,
      maxAgeDays: 365,
    },
  );
});

test("preserves a count-only policy when age is null", () => {
  assert.deepEqual(
    normalizeApplicationSettings({
      jobRetention: {
        enabled: true,
        maxTerminalJobs: 100,
        maxAgeDays: null,
      },
    }).jobRetention,
    {
      enabled: true,
      maxTerminalJobs: 100,
      maxAgeDays: undefined,
    },
  );
});

test("preserves Codex provider profiles and durable-job snapshots", () => {
  const profile = normalizeProviderProfileSettings({
    version: 1,
    profiles: [{
      id: "profile-id",
      name: "Codex API",
      kind: "codex",
      defaultModel: "gpt-5.6-terra",
      revision: 1,
    }],
  }).profiles[0];
  assert.equal(profile?.kind, "codex");

  const job = normalizeJobStore({
    version: 1,
    jobs: [{
      id: "job-id",
      projectId: "project-id",
      skillId: "skill-id",
      provider: {
        profileId: "profile-id",
        profileName: "Codex API",
        profileRevision: 1,
        kind: "codex",
        model: "gpt-5.6-terra",
      },
    }],
  }).jobs[0];
  assert.equal(job?.provider?.kind, "codex");
});
