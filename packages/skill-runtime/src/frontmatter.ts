import { isAbsolute, posix, win32 } from "node:path";
import { SKILL_NAME_PATTERN } from "./constants.js";
import type {
  SkillFrontmatter,
  SkillPresentation,
} from "./types.js";
import { parseSafeYaml } from "./yaml-policy.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ParsedSkillManifest {
  frontmatter: SkillFrontmatter | null;
  instructions: string | null;
  errors: string[];
  warnings: string[];
}

export interface ParsedOpenAiMetadata {
  rawMetadata: Record<string, unknown> | null;
  presentation: SkillPresentation | null;
  errors: string[];
}

function decodeUtf8(bytes: Uint8Array): { text: string | null; error: string | null } {
  try {
    const decoded = decoder.decode(bytes);
    return {
      text: decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded,
      error: null,
    };
  } catch {
    return { text: null, error: "File is not valid UTF-8" };
  }
}

function splitFrontmatter(text: string): {
  yaml: string | null;
  body: string | null;
  error: string | null;
} {
  const firstNewline = text.indexOf("\n");
  if (firstNewline < 0 || text.slice(0, firstNewline).replace(/\r$/u, "") !== "---") {
    return {
      yaml: null,
      body: null,
      error: "SKILL.md must begin with an exact --- frontmatter delimiter",
    };
  }

  let lineStart = firstNewline + 1;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/u, "");
    if (line === "---") {
      return {
        yaml: text.slice(firstNewline + 1, lineStart),
        body: newline < 0 ? "" : text.slice(newline + 1),
        error: null,
      };
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }

  return {
    yaml: null,
    body: null,
    error: "SKILL.md frontmatter has no closing --- delimiter",
  };
}

function hasForbiddenTextControls(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

export function parseSkillManifest(
  bytes: Uint8Array,
  options: {
    maxFrontmatterBytes: number;
    maxDescriptionLength: number;
    directoryName?: string;
  },
): ParsedSkillManifest {
  const decoded = decodeUtf8(bytes);
  if (decoded.text === null) {
    return {
      frontmatter: null,
      instructions: null,
      errors: [decoded.error ?? "Invalid UTF-8"],
      warnings: [],
    };
  }

  const split = splitFrontmatter(decoded.text);
  if (split.error || split.yaml === null || split.body === null) {
    return {
      frontmatter: null,
      instructions: null,
      errors: [split.error ?? "Invalid frontmatter"],
      warnings: [],
    };
  }
  if (Buffer.byteLength(split.yaml, "utf8") > options.maxFrontmatterBytes) {
    return {
      frontmatter: null,
      instructions: null,
      errors: [
        `Frontmatter exceeds ${options.maxFrontmatterBytes} bytes`,
      ],
      warnings: [],
    };
  }

  const parsed = parseSafeYaml(split.yaml);
  if (parsed.value === null) {
    return {
      frontmatter: null,
      instructions: split.body.trim() ? split.body : null,
      errors: parsed.errors,
      warnings: [],
    };
  }

  const name = parsed.value.name;
  const description = parsed.value.description;
  const errors: string[] = [];
  if (typeof name !== "string" || name.trim() !== name || !SKILL_NAME_PATTERN.test(name) || name.length > 64) {
    errors.push(
      "name must be a lowercase kebab-case string between 1 and 64 characters",
    );
  }
  if (
    typeof description !== "string" ||
    description.trim() !== description ||
    description.length === 0 ||
    description.length > options.maxDescriptionLength ||
    /\p{Cc}/u.test(description)
  ) {
    errors.push(
      `description must be a trimmed, single-line string between 1 and ${options.maxDescriptionLength} characters`,
    );
  }
  if (!split.body.trim()) errors.push("SKILL.md instruction body must not be empty");
  if (hasForbiddenTextControls(split.body)) {
    errors.push("SKILL.md instructions contain forbidden control characters");
  }

  const additional = Object.fromEntries(
    Object.entries(parsed.value).filter(
      ([key]) => key !== "name" && key !== "description",
    ),
  );
  const warnings: string[] = [];
  if (
    typeof name === "string" &&
    options.directoryName !== undefined &&
    name !== options.directoryName
  ) {
    warnings.push(
      `Skill name ${name} does not match package directory ${options.directoryName}`,
    );
  }

  return {
    frontmatter:
      errors.length === 0 && typeof name === "string" && typeof description === "string"
        ? { name, description, additional }
        : null,
    instructions: split.body.trim() ? split.body : null,
    errors,
    warnings,
  };
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
  errors: string[],
): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maxLength ||
    hasForbiddenTextControls(value)
  ) {
    errors.push(`${label} must be a non-empty string of at most ${maxLength} characters`);
    return null;
  }
  return value;
}

function optionalRelativeAsset(
  value: unknown,
  label: string,
  errors: string[],
): string | null {
  const asset = optionalString(value, label, 512, errors);
  if (asset === null) return null;
  const normalized = asset.replaceAll("\\", "/");
  if (
    isAbsolute(asset) ||
    win32.isAbsolute(asset) ||
    normalized.includes(":") ||
    posix.normalize(normalized).split("/").includes("..") ||
    normalized.startsWith("/")
  ) {
    errors.push(`${label} must be a non-escaping package-relative path`);
    return null;
  }
  return normalized;
}

export function parseOpenAiMetadata(
  bytes: Uint8Array,
): ParsedOpenAiMetadata {
  const decoded = decodeUtf8(bytes);
  if (decoded.text === null) {
    return {
      rawMetadata: null,
      presentation: null,
      errors: [decoded.error ?? "Invalid UTF-8"],
    };
  }
  const parsed = parseSafeYaml(decoded.text);
  if (parsed.value === null) {
    return {
      rawMetadata: null,
      presentation: null,
      errors: parsed.errors,
    };
  }

  const errors: string[] = [];
  const interfaceValue = parsed.value.interface;
  if (
    interfaceValue !== undefined &&
    (typeof interfaceValue !== "object" ||
      interfaceValue === null ||
      Array.isArray(interfaceValue))
  ) {
    errors.push("interface must be a mapping");
  }
  const fields =
    typeof interfaceValue === "object" &&
    interfaceValue !== null &&
    !Array.isArray(interfaceValue)
      ? (interfaceValue as Record<string, unknown>)
      : {};

  const displayName = optionalString(
    fields.display_name,
    "interface.display_name",
    200,
    errors,
  );
  const shortDescription = optionalString(
    fields.short_description,
    "interface.short_description",
    500,
    errors,
  );
  const brandColor = optionalString(
    fields.brand_color,
    "interface.brand_color",
    32,
    errors,
  );
  if (brandColor !== null && !/^#[0-9a-f]{6}$/iu.test(brandColor)) {
    errors.push("interface.brand_color must be a six-digit hexadecimal color");
  }
  const defaultPrompt = optionalString(
    fields.default_prompt,
    "interface.default_prompt",
    4_000,
    errors,
  );
  const iconSmall = optionalRelativeAsset(
    fields.icon_small,
    "interface.icon_small",
    errors,
  );
  const iconLarge = optionalRelativeAsset(
    fields.icon_large,
    "interface.icon_large",
    errors,
  );

  return {
    rawMetadata: parsed.value,
    presentation:
      errors.length === 0
        ? {
            displayName,
            shortDescription,
            brandColor,
            defaultPrompt,
            iconSmall,
            iconLarge,
          }
        : null,
    errors,
  };
}
