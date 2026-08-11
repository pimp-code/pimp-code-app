export type SkillEntryStatus =
  | "valid"
  | "malformed"
  | "duplicate"
  | "unstable";

export type SkillRootStatus =
  | "ready"
  | "invalid"
  | "unavailable"
  | "limited";

export type SkillIssueSeverity = "warning" | "error";

export type SkillPackageFileKind =
  | "manifest"
  | "metadata"
  | "script"
  | "reference"
  | "asset"
  | "other";

export type SkillMetadataStatus = "absent" | "valid" | "malformed";

export interface SkillCatalogIssue {
  code: string;
  severity: SkillIssueSeverity;
  message: string;
  path: string | null;
  rootId: string | null;
  entryId: string | null;
}

export interface SkillScanLimits {
  maxRoots: number;
  maxDiscoveryEntries: number;
  maxDiscoveryDepth: number;
  maxPackageDepth: number;
  maxPackageEntries: number;
  maxPackageFiles: number;
  maxPackageBytes: number;
  maxFileBytes: number;
  maxManifestBytes: number;
  maxFrontmatterBytes: number;
  maxMetadataBytes: number;
  maxRelativePathLength: number;
  maxDescriptionLength: number;
}

export interface ScanSkillCatalogOptions {
  roots: readonly string[];
  limits?: Partial<SkillScanLimits>;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  additional: Record<string, unknown>;
}

export interface SkillPresentation {
  displayName: string | null;
  shortDescription: string | null;
  brandColor: string | null;
  defaultPrompt: string | null;
  iconSmall: string | null;
  iconLarge: string | null;
}

export interface SkillPackageFile {
  relativePath: string;
  canonicalPath: string;
  size: number;
  sha256: string;
  kind: SkillPackageFileKind;
  active: boolean;
}

export interface SkillCatalogEntry {
  id: string;
  rootId: string;
  rootIds: string[];
  packageRoot: string;
  manifestPath: string | null;
  metadataPath: string | null;
  status: SkillEntryStatus;
  name: string | null;
  description: string | null;
  instructions: string | null;
  frontmatter: SkillFrontmatter | null;
  digest: string | null;
  digestAlgorithm: "sha256";
  fileCount: number;
  totalBytes: number;
  files: SkillPackageFile[];
  metadataStatus: SkillMetadataStatus;
  presentation: SkillPresentation | null;
  rawMetadata: Record<string, unknown> | null;
  issues: SkillCatalogIssue[];
}

export interface SkillRootResult {
  id: string;
  configuredPath: string;
  resolvedPath: string;
  canonicalPath: string | null;
  status: SkillRootStatus;
  manifestCount: number;
  issues: SkillCatalogIssue[];
}

export interface OrphanSkillMetadata {
  rootId: string;
  path: string;
  reason: "no-owning-skill-package";
  issue: SkillCatalogIssue;
}

export interface SkillCatalog {
  scannedAt: string;
  roots: SkillRootResult[];
  entries: SkillCatalogEntry[];
  orphanMetadata: OrphanSkillMetadata[];
  issues: SkillCatalogIssue[];
}
