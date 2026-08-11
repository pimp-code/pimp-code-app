import { createHash } from "node:crypto";

function normalizeForJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (typeof value === "object") {
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) normalized[key] = normalizeForJson(item);
    }
    return normalized;
  }
  throw new Error(`Unsupported JSON value: ${typeof value}`);
}

export function stableJson(value: unknown, indentation?: number): string {
  return JSON.stringify(normalizeForJson(value), null, indentation);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashStableJson(value: unknown): string {
  return sha256(stableJson(value));
}
