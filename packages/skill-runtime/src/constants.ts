import type { SkillScanLimits } from "./types.js";

export const DEFAULT_SKILL_SCAN_LIMITS: Readonly<SkillScanLimits> =
  Object.freeze({
    maxRoots: 32,
    maxDiscoveryEntries: 100_000,
    maxDiscoveryDepth: 24,
    maxPackageDepth: 24,
    maxPackageEntries: 8_192,
    maxPackageFiles: 2_048,
    maxPackageBytes: 32 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxManifestBytes: 1024 * 1024,
    maxFrontmatterBytes: 64 * 1024,
    maxMetadataBytes: 256 * 1024,
    maxRelativePathLength: 512,
    maxDescriptionLength: 2_048,
  });

export const DISCOVERY_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "build",
  "dist",
  "node_modules",
  "target",
]);

export const PACKAGE_IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn"]);

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
