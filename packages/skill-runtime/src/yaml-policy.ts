import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
} from "yaml";

export interface SafeYamlResult {
  value: Record<string, unknown> | null;
  errors: string[];
}

function findForbiddenYamlFeatures(document: Document): string[] {
  const errors: string[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: document.contents, depth: 0 },
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.value === null || current.value === undefined) continue;
    if (current.depth > 32) {
      errors.push("YAML nesting exceeds 32 levels");
      continue;
    }

    const node = current.value;
    if (isAlias(node)) {
      errors.push("YAML aliases are not allowed");
      continue;
    }
    if (
      typeof node === "object" &&
      node !== null &&
      "anchor" in node &&
      typeof node.anchor === "string"
    ) {
      errors.push("YAML anchors are not allowed");
    }
    if (
      typeof node === "object" &&
      node !== null &&
      "tag" in node &&
      typeof node.tag === "string"
    ) {
      errors.push("Explicit YAML tags are not allowed");
    }

    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          errors.push("YAML mapping keys must be strings");
        } else if (pair.key.value === "<<") {
          errors.push("YAML merge keys are not allowed");
        }
        pending.push(
          { value: pair.key, depth: current.depth + 1 },
          { value: pair.value, depth: current.depth + 1 },
        );
      }
    } else if (isSeq(node)) {
      for (const item of node.items) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }

  return [...new Set(errors)];
}

function isPlainYamlValue(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.every((item) => isPlainYamlValue(item, seen));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, item]) =>
      !/\p{Cc}/u.test(key) &&
      key !== "__proto__" &&
      key !== "constructor" &&
      key !== "prototype" &&
      isPlainYamlValue(item, seen),
  );
}

export function parseSafeYaml(source: string): SafeYamlResult {
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });

  const errors = [
    ...document.errors.map((error) => error.message),
    ...findForbiddenYamlFeatures(document),
  ];
  if (errors.length > 0) return { value: null, errors };
  if (!isMap(document.contents)) {
    return { value: null, errors: ["YAML document must be a mapping"] };
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    return {
      value: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  if (!isPlainYamlValue(value) || Array.isArray(value) || value === null) {
    return {
      value: null,
      errors: ["YAML contains a non-plain or cyclic value"],
    };
  }

  return { value: value as Record<string, unknown>, errors: [] };
}
