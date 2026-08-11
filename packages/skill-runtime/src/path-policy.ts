import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

const WINDOWS_RESERVED_COMPONENT =
  /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function stableId(domain: string, value: string): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function isWindowsDevicePath(value: string): boolean {
  if (process.platform !== "win32") return false;
  const normalized = value.replaceAll("/", "\\");
  return /^\\\\[.?]\\/u.test(normalized);
}

export function isPathWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith(`..${sep}`) &&
      childRelative !== ".." &&
      !isAbsolute(childRelative))
  );
}

export function resolveConfiguredPath(value: string): string {
  return resolve(value);
}

export interface RelativePathValidation {
  normalizedPath: string | null;
  collisionKey: string | null;
  error: string | null;
}

export function validatePackageRelativePath(
  rawRelativePath: string,
  maxLength: number,
): RelativePathValidation {
  if (
    rawRelativePath.length === 0 ||
    rawRelativePath.length > maxLength ||
    isAbsolute(rawRelativePath)
  ) {
    return {
      normalizedPath: null,
      collisionKey: null,
      error:
        rawRelativePath.length > maxLength
          ? `Relative path exceeds ${maxLength} characters`
          : "Path must be package-relative",
    };
  }

  const components = rawRelativePath.split(/[\\/]/u);
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    return {
      normalizedPath: null,
      collisionKey: null,
      error: "Path contains an empty, dot, or parent component",
    };
  }

  for (const component of components) {
    if (/\p{Cc}/u.test(component)) {
      return {
        normalizedPath: null,
        collisionKey: null,
        error: "Path contains control characters",
      };
    }
    if (component.includes(":")) {
      return {
        normalizedPath: null,
        collisionKey: null,
        error: "Path contains a colon or alternate-data-stream component",
      };
    }
    if (component.endsWith(".") || component.endsWith(" ")) {
      return {
        normalizedPath: null,
        collisionKey: null,
        error: "Path contains a trailing dot or space",
      };
    }
    if (WINDOWS_RESERVED_COMPONENT.test(component)) {
      return {
        normalizedPath: null,
        collisionKey: null,
        error: `Path contains reserved component ${component}`,
      };
    }
  }

  const normalizedPath = components.join("/");
  return {
    normalizedPath,
    collisionKey: normalizedPath.normalize("NFC").toLowerCase(),
    error: null,
  };
}
