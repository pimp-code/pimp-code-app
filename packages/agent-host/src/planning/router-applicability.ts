import type { RepositoryContextBundle } from "./repository-context.js";

export type ReactRouterApplicabilityStatus =
  | "applicable"
  | "already-v8"
  | "not-applicable"
  | "uncertain";

export type ReactRouterEvidenceKind =
  | "dependency"
  | "legacy-api"
  | "lockfile"
  | "manifest-error";

export interface ReactRouterEvidence {
  relativePath: string;
  kind: ReactRouterEvidenceKind;
  fact: string;
}

export interface ReactRouterVersionEvidence {
  packageName: "react-router" | "react-router-dom";
  version: string;
  major: number;
  source: string;
  kind: "declared" | "resolved";
}

export interface ReactRouterApplicability {
  status: ReactRouterApplicabilityStatus;
  rationale: string;
  versions: ReactRouterVersionEvidence[];
  legacyApis: string[];
  evidence: ReactRouterEvidence[];
}

const ROUTER_PACKAGES = ["react-router", "react-router-dom"] as const;
const LEGACY_API_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Prompt", /\bPrompt\b/u],
  ["Redirect", /\bRedirect\b/u],
  ["Route component prop", /<Route\b[^>]*\bcomponent\s*=/u],
  ["Route render prop", /<Route\b[^>]*\brender\s*=/u],
  ["Switch", /\bSwitch\b/u],
  ["useHistory", /\buseHistory\b/u],
  ["withRouter", /\bwithRouter\b/u],
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordVersion(
  versions: ReactRouterVersionEvidence[],
  packageName: (typeof ROUTER_PACKAGES)[number],
  version: unknown,
  source: string,
  kind: ReactRouterVersionEvidence["kind"],
): void {
  if (typeof version !== "string") return;
  const match = /^[\s~^<>=v]*(\d+)(?:\.|\b)/u.exec(version);
  if (!match?.[1]) return;
  const major = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(major)) return;
  versions.push({ packageName, version, major, source, kind });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function directDeclarations(manifest: Record<string, unknown>): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const sectionName of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const section = objectRecord(manifest[sectionName]);
    if (!section) continue;
    for (const packageName of ROUTER_PACKAGES) {
      if (packageName in section && !result.has(packageName)) {
        result.set(packageName, section[packageName]);
      }
    }
  }
  return result;
}

function addEvidence(
  evidence: ReactRouterEvidence[],
  relativePath: string,
  kind: ReactRouterEvidenceKind,
  fact: string,
): void {
  evidence.push({ relativePath, kind, fact });
}

export function detectReactRouterV8Applicability(
  context: RepositoryContextBundle,
): ReactRouterApplicability {
  const versions: ReactRouterVersionEvidence[] = [];
  const evidence: ReactRouterEvidence[] = [];
  const legacyApis = new Set<string>();
  const directlyDeclared = new Set<string>();
  let malformedManifest = false;

  for (const document of context.documents) {
    if (document.reason === "package-manifest") {
      let value: unknown;
      try {
        value = JSON.parse(document.content) as unknown;
      } catch {
        malformedManifest = true;
        addEvidence(evidence, document.relativePath, "manifest-error", "package.json is not valid JSON");
        continue;
      }
      const manifest = objectRecord(value);
      if (!manifest) continue;
      for (const [packageName, declared] of directDeclarations(manifest)) {
        directlyDeclared.add(packageName);
        const before = versions.length;
        recordVersion(
          versions,
          packageName as (typeof ROUTER_PACKAGES)[number],
          declared,
          document.relativePath,
          "declared",
        );
        const version = versions.at(-1);
        addEvidence(
          evidence,
          document.relativePath,
          "dependency",
          versions.length > before && version
            ? `${packageName} directly declares ${version.version}`
            : `${packageName} is directly declared with an unresolved version specifier`,
        );
      }
      continue;
    }

    if (document.reason === "package-manager-lockfile") {
      if (
        document.contentKind === "lockfile-summary" ||
        document.relativePath.toLowerCase().endsWith("package-lock.json")
      ) {
        try {
          const lock = objectRecord(JSON.parse(document.content) as unknown);
          const summaryEntries = Array.isArray(lock?.routerPackages)
            ? lock.routerPackages
            : undefined;
          if (summaryEntries) {
            for (const [index, item] of summaryEntries.entries()) {
              const entry = objectRecord(item);
              if (!entry) continue;
              const packageName = entry.packageName;
              if (packageName !== "react-router" && packageName !== "react-router-dom") continue;
              const directSpecifier = entry.directSpecifier;
              if (typeof directSpecifier !== "string") continue;
              directlyDeclared.add(packageName);
              const resolvedVersion = entry.resolvedVersion;
              const before = versions.length;
              recordVersion(
                versions,
                packageName,
                resolvedVersion,
                document.relativePath,
                "resolved",
              );
              const version = versions.at(-1);
              if (versions.length > before && version) {
                addEvidence(
                  evidence,
                  document.relativePath,
                  "lockfile",
                  `${packageName} resolves directly to ${version.version}`,
                );
              } else {
                addEvidence(
                  evidence,
                  document.relativePath,
                  "lockfile",
                  `${packageName} is direct in lock summary entry ${index} without a resolved version`,
                );
              }
            }
            continue;
          }
          const packages = objectRecord(lock?.packages);
          const root = objectRecord(packages?.[""]);
          const rootDirect = root ? directDeclarations(root) : new Map<string, unknown>();
          for (const packageName of ROUTER_PACKAGES) {
            if (rootDirect.has(packageName)) directlyDeclared.add(packageName);
            if (!directlyDeclared.has(packageName)) continue;
            const packageRecord = objectRecord(packages?.[`node_modules/${packageName}`]);
            const v1Record = objectRecord(objectRecord(lock?.dependencies)?.[packageName]);
            const resolved = packageRecord?.version ?? v1Record?.version;
            const before = versions.length;
            recordVersion(versions, packageName, resolved, document.relativePath, "resolved");
            const version = versions.at(-1);
            if (versions.length > before && version) {
              addEvidence(
                evidence,
                document.relativePath,
                "lockfile",
                `${packageName} resolves directly to ${version.version}`,
              );
            }
          }
        } catch {
          addEvidence(evidence, document.relativePath, "manifest-error", "package-lock.json is not valid JSON");
        }
      }
      continue;
    }

    if (!["router-source", "source-entry", "test-source"].includes(document.reason)) {
      continue;
    }
    const importsRouter = /\b(?:from\s+|require\s*\(\s*)["']react-router(?:-dom)?["']/u.test(
      document.content,
    );
    if (!importsRouter && document.reason !== "router-source") continue;
    for (const [api, pattern] of LEGACY_API_PATTERNS) {
      if (!pattern.test(document.content)) continue;
      legacyApis.add(api);
      addEvidence(evidence, document.relativePath, "legacy-api", `${api} legacy API is used`);
    }
  }

  versions.sort((left, right) => {
    const sourceOrder = compareText(left.source, right.source);
    if (sourceOrder !== 0) return sourceOrder;
    const packageOrder = compareText(left.packageName, right.packageName);
    if (packageOrder !== 0) return packageOrder;
    const kindOrder = compareText(left.kind, right.kind);
    return kindOrder === 0 ? compareText(left.version, right.version) : kindOrder;
  });
  evidence.sort((left, right) => {
    const sourceOrder = compareText(left.relativePath, right.relativePath);
    if (sourceOrder !== 0) return sourceOrder;
    const kindOrder = compareText(left.kind, right.kind);
    return kindOrder === 0 ? compareText(left.fact, right.fact) : kindOrder;
  });
  const sortedLegacyApis = [...legacyApis].sort(compareText);
  const majors = new Set(versions.map((version) => version.major));
  const legacyMajor = [...majors].some((major) => major >= 4 && major <= 7);
  const v8OrNewer = [...majors].some((major) => major >= 8);

  let status: ReactRouterApplicabilityStatus;
  let rationale: string;
  if (legacyMajor) {
    status = "applicable";
    rationale = "A directly declared or resolved React Router major from 4 through 7 requires a v8 migration plan.";
  } else if (v8OrNewer && sortedLegacyApis.length > 0) {
    status = "applicable";
    rationale = "React Router v8 or newer is present, but v5-only APIs show an incomplete or broken migration.";
  } else if (v8OrNewer) {
    status = "already-v8";
    rationale = "React Router v8 or newer is present and no v5-only API evidence was detected.";
  } else if (sortedLegacyApis.length > 0 || directlyDeclared.size > 0 || malformedManifest) {
    status = "uncertain";
    rationale = sortedLegacyApis.length > 0
      ? "Legacy React Router APIs were detected without a trustworthy direct package major."
      : "React Router evidence exists, but a trustworthy direct package major could not be established.";
  } else {
    status = "not-applicable";
    rationale = "No direct React Router dependency or legacy React Router API evidence was detected.";
  }

  return { status, rationale, versions, legacyApis: sortedLegacyApis, evidence };
}
