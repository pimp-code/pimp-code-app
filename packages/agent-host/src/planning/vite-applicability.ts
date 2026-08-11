import type { RepositoryContextBundle } from "./repository-context.js";

export type ViteApplicabilityStatus =
  | "applicable"
  | "already-vite"
  | "not-applicable"
  | "uncertain";

export type ApplicabilityEvidenceKind =
  | "config-file"
  | "dependency"
  | "manifest-error"
  | "script"
  | "source-signal";

export interface ApplicabilityEvidence {
  relativePath: string;
  kind: ApplicabilityEvidenceKind;
  fact: string;
}

export interface ViteApplicability {
  status: ViteApplicabilityStatus;
  rationale: string;
  vitePresent: boolean;
  legacyToolchains: string[];
  frameworks: string[];
  evidence: ApplicabilityEvidence[];
}

const LEGACY_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@craco/craco": "Create React App / CRACO",
  "@parcel/core": "Parcel",
  "@vue/cli-service": "Vue CLI",
  "customize-cra": "Create React App overrides",
  grunt: "Grunt",
  gulp: "Gulp",
  parcel: "Parcel",
  "react-app-rewired": "Create React App overrides",
  "react-scripts": "Create React App",
  rollup: "Rollup",
  snowpack: "Snowpack",
  webpack: "Webpack",
  "webpack-cli": "Webpack",
  "webpack-dev-server": "Webpack",
};

const FRAMEWORK_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@angular/core": "Angular",
  "@preact/preset-vite": "Preact",
  "@sveltejs/kit": "SvelteKit",
  "@vitejs/plugin-react": "React",
  "@vitejs/plugin-vue": "Vue",
  astro: "Astro",
  expo: "Expo",
  next: "Next.js",
  nuxt: "Nuxt",
  preact: "Preact",
  react: "React",
  "react-native": "React Native",
  "solid-js": "Solid",
  svelte: "Svelte",
  vue: "Vue",
};

const FRAMEWORK_OWNED_PIPELINES = new Set([
  "Angular",
  "Astro",
  "Expo",
  "Next.js",
  "Nuxt",
  "React Native",
  "SvelteKit",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addEvidence(
  evidence: ApplicabilityEvidence[],
  relativePath: string,
  kind: ApplicabilityEvidenceKind,
  fact: string,
): void {
  evidence.push({ relativePath, kind, fact });
}

function packageSections(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const manifest = value as Record<string, unknown>;
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
    .filter(
      (section): section is Record<string, unknown> =>
        typeof section === "object" && section !== null && !Array.isArray(section),
    );
}

function scriptTools(command: string): string[] {
  const normalized = command.toLowerCase();
  const tools = new Set<string>();
  if (/(?:^|[\s;&|])vite(?:[\s;&|]|$)/u.test(normalized)) tools.add("Vite");
  if (/(?:^|[\s;&|])react-scripts(?:[\s;&|]|$)/u.test(normalized)) {
    tools.add("Create React App");
  }
  if (/(?:^|[\s;&|])webpack(?:[\s;&|]|$)/u.test(normalized)) tools.add("Webpack");
  if (/(?:^|[\s;&|])parcel(?:[\s;&|]|$)/u.test(normalized)) tools.add("Parcel");
  if (/(?:^|[\s;&|])rollup(?:[\s;&|]|$)/u.test(normalized)) tools.add("Rollup");
  if (/(?:^|[\s;&|])snowpack(?:[\s;&|]|$)/u.test(normalized)) tools.add("Snowpack");
  if (/(?:^|[\s;&|])vue-cli-service(?:[\s;&|]|$)/u.test(normalized)) {
    tools.add("Vue CLI");
  }
  if (/(?:^|[\s;&|])grunt(?:[\s;&|]|$)/u.test(normalized)) tools.add("Grunt");
  if (/(?:^|[\s;&|])gulp(?:[\s;&|]|$)/u.test(normalized)) tools.add("Gulp");
  return [...tools].sort(compareText);
}

function legacyConfigTool(lowerPath: string): string {
  if (lowerPath.includes("webpack")) return "Webpack";
  if (lowerPath.includes("parcel")) return "Parcel";
  if (lowerPath.includes("rollup")) return "Rollup";
  if (lowerPath.includes("snowpack")) return "Snowpack";
  if (lowerPath.includes("vue.config")) return "Vue CLI";
  if (lowerPath.includes("grunt")) return "Grunt";
  if (lowerPath.includes("gulp")) return "Gulp";
  if (lowerPath.includes("craco") || lowerPath.includes("config-overrides")) {
    return "Create React App overrides";
  }
  return "Legacy custom build pipeline";
}

export function detectViteApplicability(
  context: RepositoryContextBundle,
): ViteApplicability {
  const evidence: ApplicabilityEvidence[] = [];
  const legacyToolchains = new Set<string>();
  const frameworks = new Set<string>();
  let vitePresent = false;
  let frontendEntryPresent = false;
  let malformedManifestPresent = false;

  for (const document of context.documents) {
    const lowerPath = document.relativePath.toLowerCase();
    if (document.reason === "vite-config") {
      vitePresent = true;
      addEvidence(evidence, document.relativePath, "config-file", "Vite configuration exists");
    }
    if (document.reason === "legacy-build-config") {
      const tool = legacyConfigTool(lowerPath);
      legacyToolchains.add(tool);
      addEvidence(evidence, document.relativePath, "config-file", `${tool} configuration exists`);
    }
    if (document.reason === "html-entry") {
      frontendEntryPresent = true;
      addEvidence(evidence, document.relativePath, "source-signal", "HTML client entry exists");
    }
    if (document.reason === "source-entry") {
      frontendEntryPresent = true;
      addEvidence(evidence, document.relativePath, "source-signal", "Client source entry exists");
      if (/\bfrom\s+["']react["']|\brequire\(["']react["']\)/u.test(document.content)) {
        frameworks.add("React");
        addEvidence(evidence, document.relativePath, "source-signal", "React source entry import");
      }
      if (/\bcreateApp\s*\(/u.test(document.content)) {
        frameworks.add("Vue");
        addEvidence(evidence, document.relativePath, "source-signal", "Vue-style createApp entry");
      }
    }
    if (document.reason !== "package-manifest") continue;

    let manifest: unknown;
    try {
      manifest = JSON.parse(document.content) as unknown;
    } catch {
      malformedManifestPresent = true;
      addEvidence(
        evidence,
        document.relativePath,
        "manifest-error",
        "package.json is not valid JSON",
      );
      continue;
    }
    const sections = packageSections(manifest);
    for (const [dependency, toolchain] of Object.entries(LEGACY_DEPENDENCIES)) {
      if (sections.some((section) => dependency in section)) {
        legacyToolchains.add(toolchain);
        addEvidence(
          evidence,
          document.relativePath,
          "dependency",
          `${dependency} declares ${toolchain}`,
        );
      }
    }
    if (sections.some((section) => "vite" in section)) {
      vitePresent = true;
      addEvidence(evidence, document.relativePath, "dependency", "vite dependency is declared");
    }
    for (const [dependency, framework] of Object.entries(FRAMEWORK_DEPENDENCIES)) {
      if (sections.some((section) => dependency in section)) {
        frameworks.add(framework);
        addEvidence(
          evidence,
          document.relativePath,
          "dependency",
          `${dependency} identifies ${framework}`,
        );
      }
    }

    if (typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)) {
      const scripts = (manifest as Record<string, unknown>).scripts;
      if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
        for (const [name, command] of Object.entries(scripts).sort(([left], [right]) =>
          compareText(left, right),
        )) {
          if (typeof command !== "string") continue;
          for (const tool of scriptTools(command)) {
            if (tool === "Vite") vitePresent = true;
            else legacyToolchains.add(tool);
            addEvidence(
              evidence,
              document.relativePath,
              "script",
              `script ${name} invokes ${tool}`,
            );
          }
        }
      }
    }
  }

  const sortedLegacyToolchains = [...legacyToolchains].sort(compareText);
  const sortedFrameworks = [...frameworks].sort(compareText);
  evidence.sort((left, right) => {
    const pathOrder = compareText(left.relativePath, right.relativePath);
    if (pathOrder !== 0) return pathOrder;
    const kindOrder = compareText(left.kind, right.kind);
    return kindOrder === 0 ? compareText(left.fact, right.fact) : kindOrder;
  });

  let status: ViteApplicabilityStatus;
  let rationale: string;
  if (malformedManifestPresent) {
    status = "uncertain";
    rationale =
      "A selected package manifest is malformed, so the current frontend build pipeline cannot be classified safely.";
  } else if (sortedLegacyToolchains.length > 0) {
    status = "applicable";
    rationale = vitePresent
      ? "Legacy build evidence remains alongside Vite; a parity and cleanup plan is applicable."
      : "A legacy frontend build pipeline was detected without an established Vite replacement."
  } else if (vitePresent) {
    status = "already-vite";
    rationale = "Vite is already configured and no legacy build pipeline was detected."
  } else if (sortedFrameworks.some((framework) => FRAMEWORK_OWNED_PIPELINES.has(framework))) {
    status = "not-applicable";
    rationale =
      "Only a framework-owned build pipeline was detected; replacing it with standalone Vite is not justified by current evidence."
  } else if (sortedFrameworks.length > 0 || frontendEntryPresent) {
    status = "uncertain";
    rationale =
      "Frontend framework evidence exists, but the current build pipeline is not proven by the approved context."
  } else {
    status = "not-applicable";
    rationale = "No frontend framework or legacy client build pipeline was detected."
  }

  return {
    status,
    rationale,
    vitePresent,
    legacyToolchains: sortedLegacyToolchains,
    frameworks: sortedFrameworks,
    evidence,
  };
}
