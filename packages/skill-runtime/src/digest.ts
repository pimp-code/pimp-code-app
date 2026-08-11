import { createHash } from "node:crypto";

export interface DigestFile {
  relativePath: string;
  bytes: Uint8Array;
}

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeSkillPackageDigest(files: readonly DigestFile[]): string {
  const hash = createHash("sha256");
  hash.update("pimp-skill-package-v1\0", "utf8");

  const sorted = [...files].sort((left, right) =>
    Buffer.from(left.relativePath, "utf8").compare(
      Buffer.from(right.relativePath, "utf8"),
    ),
  );

  for (const file of sorted) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    const contentBytes = Buffer.from(file.bytes);
    hash.update(lengthPrefix(pathBytes.byteLength));
    hash.update(pathBytes);
    hash.update(lengthPrefix(contentBytes.byteLength));
    hash.update(contentBytes);
  }

  return hash.digest("hex");
}
