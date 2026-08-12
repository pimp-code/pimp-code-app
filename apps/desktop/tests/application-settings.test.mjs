import assert from "node:assert/strict";
import test from "node:test";

import { normalizeApplicationSettings } from "../src/contracts.ts";

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
