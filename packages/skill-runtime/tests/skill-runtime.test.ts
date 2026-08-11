import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  parseSkillManifest,
  scanSkillCatalog,
  type SkillCatalogEntry,
} from "../src/index.js";

interface SkillFixtureOptions {
  name?: string;
  description?: string;
  body?: string;
  additionalFrontmatter?: string;
  manifestName?: string;
}

async function withTempDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pimp-skill-runtime-"));
  try {
    return await run(directory);
  } finally {
    const temporaryRoot = resolve(tmpdir());
    const resolvedDirectory = resolve(directory);
    const relativeTarget = relative(temporaryRoot, resolvedDirectory);
    assert.ok(
      relativeTarget &&
        relativeTarget !== ".." &&
        !relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
      `Refusing to clean unexpected test path ${resolvedDirectory}`,
    );
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
}

async function createSkill(
  root: string,
  relativeDirectory: string,
  options: SkillFixtureOptions = {},
): Promise<string> {
  const packageDirectory = join(root, relativeDirectory);
  await mkdir(packageDirectory, { recursive: true });
  const name = options.name ?? basename(relativeDirectory);
  const description = options.description ?? `Use ${name} for a focused test.`;
  const additional = options.additionalFrontmatter
    ? `${options.additionalFrontmatter.replace(/\n?$/u, "\n")}`
    : "";
  const manifest = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    additional.trimEnd(),
    "---",
    "",
    options.body ?? `# ${name}\n\nFollow the test workflow.`,
    "",
  ]
    .filter((line, index, values) => !(line === "" && index === 3 && values[4] === "---"))
    .join("\n");
  await writeFile(
    join(packageDirectory, options.manifestName ?? "SKILL.md"),
    manifest,
    "utf8",
  );
  return packageDirectory;
}

function onlyEntry(entries: readonly SkillCatalogEntry[]): SkillCatalogEntry {
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry);
  return entry;
}

test("discovers a recursive package, parses inert metadata, and classifies scripts", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    const packageDirectory = await createSkill(root, "group/demo-skill", {
      additionalFrontmatter: "license: MIT\nmetadata:\n  owner: test-team",
    });
    await mkdir(join(packageDirectory, "agents"), { recursive: true });
    await mkdir(join(packageDirectory, "scripts"), { recursive: true });
    await mkdir(join(packageDirectory, "references"), { recursive: true });
    await mkdir(join(packageDirectory, "assets"), { recursive: true });
    await writeFile(
      join(packageDirectory, "agents", "openai.yaml"),
      [
        "interface:",
        '  display_name: "Demo Skill"',
        '  short_description: "A safe catalog fixture"',
        '  brand_color: "#3B82F6"',
        '  default_prompt: "Use $demo-skill safely."',
        '  icon_small: "./assets/icon.svg"',
        "dependencies:",
        "  tools:",
        "    - type: mcp",
        "      value: never-connect",
      ].join("\n"),
      "utf8",
    );
    const marker = join(directory, "script-ran.txt");
    await writeFile(
      join(packageDirectory, "scripts", "danger.js"),
      `throw new Error(${JSON.stringify(marker)});`,
      "utf8",
    );
    await writeFile(
      join(packageDirectory, "references", "guide.md"),
      "Reference data",
      "utf8",
    );
    await writeFile(
      join(packageDirectory, "assets", "icon.svg"),
      "<svg/>",
      "utf8",
    );

    const catalog = await scanSkillCatalog([root]);
    const entry = onlyEntry(catalog.entries);
    assert.equal(catalog.roots[0]?.status, "ready");
    assert.equal(entry.status, "valid");
    assert.equal(entry.name, "demo-skill");
    assert.match(entry.instructions ?? "", /Follow the test workflow/);
    assert.equal(entry.digest?.length, 64);
    assert.equal(entry.metadataStatus, "valid");
    assert.equal(entry.presentation?.displayName, "Demo Skill");
    assert.equal(
      (entry.rawMetadata?.dependencies as { tools?: unknown[] } | undefined)
        ?.tools?.length,
      1,
    );
    assert.equal(entry.frontmatter?.additional.license, "MIT");
    const script = entry.files.find((file) => file.kind === "script");
    assert.ok(script);
    assert.equal(script.active, false);
    await assert.rejects(access(marker));
  });
});

test("package digest is location/order independent and covers inactive scripts", async () => {
  await withTempDirectory(async (directory) => {
    const firstRoot = join(directory, "first");
    const secondRoot = join(directory, "second");
    const first = await createSkill(firstRoot, "digest-skill");
    const second = await createSkill(secondRoot, "digest-skill");

    await mkdir(join(first, "scripts"), { recursive: true });
    await writeFile(join(first, "z.txt"), "z", "utf8");
    await writeFile(join(first, "a.txt"), "a", "utf8");
    await writeFile(join(first, "scripts", "check.py"), "pass\n", "utf8");

    await mkdir(join(second, "scripts"), { recursive: true });
    await writeFile(join(second, "scripts", "check.py"), "pass\n", "utf8");
    await writeFile(join(second, "a.txt"), "a", "utf8");
    await writeFile(join(second, "z.txt"), "z", "utf8");

    const firstDigest = onlyEntry((await scanSkillCatalog([firstRoot])).entries)
      .digest;
    const secondDigest = onlyEntry((await scanSkillCatalog([secondRoot])).entries)
      .digest;
    assert.equal(firstDigest, secondDigest);

    await writeFile(join(second, "scripts", "check.py"), "print('changed')\n", "utf8");
    const changedDigest = onlyEntry((await scanSkillCatalog([secondRoot])).entries)
      .digest;
    assert.notEqual(changedDigest, firstDigest);
  });
});

test("deduplicates overlapping roots but blocks duplicate skill names", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    const first = await createSkill(root, "first-package", {
      name: "shared-name",
    });
    await createSkill(root, "second-package", { name: "shared-name" });

    const duplicateCatalog = await scanSkillCatalog([root]);
    assert.equal(duplicateCatalog.entries.length, 2);
    assert.ok(
      duplicateCatalog.entries.every((entry) => entry.status === "duplicate"),
    );
    assert.equal(
      duplicateCatalog.issues.filter(
        (item) => item.code === "DUPLICATE_SKILL_NAME",
      ).length,
      2,
    );

    const overlapCatalog = await scanSkillCatalog([root, first]);
    const sharedEntries = overlapCatalog.entries.filter(
      (entry) => entry.name === "shared-name",
    );
    assert.equal(sharedEntries.length, 2);
    const firstEntry = sharedEntries.find(
      (entry) => resolve(entry.packageRoot) === resolve(first),
    );
    assert.equal(firstEntry?.rootIds.length, 2);
  });
});

test("reports orphaned agents/openai.yaml next to a nested package", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    const outer = join(root, "rescue-the-project");
    await createSkill(outer, "rescue-the-project");
    await mkdir(join(outer, "agents"), { recursive: true });
    await writeFile(
      join(outer, "agents", "openai.yaml"),
      'interface:\n  display_name: "Orphan"\n',
      "utf8",
    );

    const catalog = await scanSkillCatalog([root]);
    assert.equal(catalog.entries.length, 1);
    assert.equal(catalog.entries[0]?.status, "valid");
    assert.equal(catalog.entries[0]?.metadataStatus, "absent");
    assert.equal(catalog.orphanMetadata.length, 1);
    assert.match(
      catalog.orphanMetadata[0]?.path ?? "",
      /agents[\\/]openai\.yaml$/u,
    );
    assert.equal(
      catalog.orphanMetadata[0]?.issue.code,
      "ORPHAN_OPENAI_METADATA",
    );
  });
});

test("rejects unsafe and malformed YAML/frontmatter while continuing the catalog", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    await mkdir(root, { recursive: true });
    const fixtures: Array<[string, string | Buffer]> = [
      ["missing-delimiter", "name: missing-delimiter\ndescription: invalid\n"],
      [
        "duplicate-key",
        "---\nname: duplicate-key\nname: second\ndescription: Duplicate keys.\n---\nBody\n",
      ],
      [
        "alias-skill",
        "---\nname: alias-skill\ndescription: &desc Alias test.\ncopy: *desc\n---\nBody\n",
      ],
      [
        "tag-skill",
        "---\nname: tag-skill\ndescription: Tag test.\nvalue: !evil data\n---\nBody\n",
      ],
      [
        "deep-yaml",
        `---\nname: deep-yaml\ndescription: Deep YAML test.\nvalue: ${"[".repeat(40)}item${"]".repeat(40)}\n---\nBody\n`,
      ],
      [
        "complex-key",
        "---\nname: complex-key\ndescription: Complex key test.\n? [not, a, string]\n: value\n---\nBody\n",
      ],
      [
        "dangerous-key",
        "---\nname: dangerous-key\ndescription: Dangerous key test.\n__proto__:\n  polluted: true\n---\nBody\n",
      ],
      [
        "uppercase-name",
        "---\nname: Uppercase-Name\ndescription: Invalid name.\n---\nBody\n",
      ],
      [
        "empty-body",
        "---\nname: empty-body\ndescription: Empty body.\n---\n   \n",
      ],
      [
        "invalid-utf8",
        Buffer.from([0xff, 0xfe, 0xfd]),
      ],
    ];

    for (const [folder, contents] of fixtures) {
      const packageDirectory = join(root, folder);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(join(packageDirectory, "SKILL.md"), contents);
    }

    const catalog = await scanSkillCatalog([root]);
    assert.equal(catalog.entries.length, fixtures.length);
    assert.ok(catalog.entries.every((entry) => entry.status === "malformed"));
    const messages = catalog.entries.flatMap((entry) =>
      entry.issues.map((item) => item.message),
    );
    assert.ok(messages.some((message) => /aliases are not allowed/i.test(message)));
    assert.ok(messages.some((message) => /tags are not allowed/i.test(message)));
    assert.ok(messages.some((message) => /nesting exceeds/i.test(message)));
    assert.ok(messages.some((message) => /mapping keys must be strings/i.test(message)));
    assert.ok(messages.some((message) => /valid UTF-8/i.test(message)));
    assert.ok(messages.some((message) => /instruction body/i.test(message)));
  });
});

test("accepts a UTF-8 BOM, retains unknown metadata, and warns on folder mismatch", async () => {
  const source = Buffer.from(
    "\uFEFF---\nname: actual-name\ndescription: A valid description.\ncustom:\n  enabled: true\n---\nInstructions\n",
    "utf8",
  );
  const parsed = parseSkillManifest(source, {
    maxFrontmatterBytes: 64 * 1024,
    maxDescriptionLength: 2_048,
    directoryName: "different-folder",
  });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter?.name, "actual-name");
  assert.deepEqual(parsed.frontmatter?.additional.custom, { enabled: true });
  assert.equal(parsed.warnings.length, 1);
});

test("malformed optional metadata stays inert and does not invalidate a skill", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    const packageDirectory = await createSkill(root, "metadata-skill");
    await mkdir(join(packageDirectory, "agents"), { recursive: true });
    await writeFile(
      join(packageDirectory, "agents", "openai.yaml"),
      'interface:\n  display_name: "Metadata"\n  icon_small: "../../outside.svg"\n',
      "utf8",
    );

    const entry = onlyEntry((await scanSkillCatalog([root])).entries);
    assert.equal(entry.status, "valid");
    assert.equal(entry.metadataStatus, "malformed");
    assert.equal(entry.presentation, null);
    assert.ok(entry.issues.some((item) => item.code === "METADATA_MALFORMED"));
    assert.equal(entry.digest?.length, 64);
  });
});

test("enforces discovery, package file, byte, and frontmatter limits", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    const packageDirectory = await createSkill(root, "limited-skill", {
      additionalFrontmatter: `note: ${"x".repeat(128)}`,
    });
    await writeFile(join(packageDirectory, "extra.txt"), "1234567890", "utf8");

    const fileLimited = onlyEntry(
      (
        await scanSkillCatalog({
          roots: [root],
          limits: { maxPackageFiles: 1 },
        })
      ).entries,
    );
    assert.equal(fileLimited.status, "malformed");
    assert.ok(fileLimited.issues.some((item) => item.code === "PACKAGE_FILE_LIMIT"));

    const entryLimited = onlyEntry(
      (
        await scanSkillCatalog({
          roots: [root],
          limits: { maxPackageEntries: 1 },
        })
      ).entries,
    );
    assert.equal(entryLimited.status, "malformed");
    assert.ok(
      entryLimited.issues.some((item) => item.code === "PACKAGE_ENTRY_LIMIT"),
    );

    const byteLimited = onlyEntry(
      (
        await scanSkillCatalog({
          roots: [root],
          limits: { maxFileBytes: 4 },
        })
      ).entries,
    );
    assert.equal(byteLimited.status, "malformed");
    assert.ok(
      byteLimited.issues.some((item) => item.code === "PACKAGE_FILE_UNREADABLE"),
    );

    const frontmatterLimited = onlyEntry(
      (
        await scanSkillCatalog({
          roots: [root],
          limits: { maxFrontmatterBytes: 32 },
        })
      ).entries,
    );
    assert.equal(frontmatterLimited.status, "malformed");
    assert.ok(
      frontmatterLimited.issues.some(
        (item) => item.code === "MANIFEST_MALFORMED" && /Frontmatter exceeds/u.test(item.message),
      ),
    );

    const deepRoot = join(directory, "deep-skills");
    await createSkill(deepRoot, "one/two/deep-skill");
    const depthCatalog = await scanSkillCatalog({
      roots: [deepRoot],
      limits: { maxDiscoveryDepth: 1 },
    });
    assert.equal(depthCatalog.entries.length, 0);
    assert.equal(depthCatalog.roots[0]?.status, "limited");
    assert.ok(
      depthCatalog.roots[0]?.issues.some(
        (item) => item.code === "DISCOVERY_DEPTH_LIMIT",
      ),
    );
  });
});

test("rejects root and package links or junctions", async (context) => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    const packageDirectory = await createSkill(root, "linked-skill");
    const external = join(directory, "external");
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "outside.txt"), "outside", "utf8");

    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await symlink(external, join(packageDirectory, "references"), linkType);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Creating links is not permitted in this environment");
        return;
      }
      throw error;
    }

    const catalog = await scanSkillCatalog([root]);
    const entry = onlyEntry(catalog.entries);
    assert.equal(entry.status, "malformed");
    assert.equal(entry.digest, null);
    assert.ok(entry.issues.some((item) => item.code === "LINK_NOT_ALLOWED"));

    const linkedRoot = join(directory, "linked-root");
    await symlink(root, linkedRoot, linkType);
    const rootCatalog = await scanSkillCatalog([linkedRoot]);
    assert.equal(rootCatalog.entries.length, 0);
    assert.equal(rootCatalog.roots[0]?.status, "invalid");
    assert.ok(
      rootCatalog.roots[0]?.issues.some(
        (item) => item.code === "ROOT_LINK_NOT_ALLOWED",
      ),
    );
  });
});

test("rejects nested skill packages at the ancestor boundary", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    await createSkill(root, "parent-skill");
    await createSkill(root, "parent-skill/child-skill");

    const catalog = await scanSkillCatalog([root]);
    assert.equal(catalog.entries.length, 2);
    const parent = catalog.entries.find((entry) => entry.name === "parent-skill");
    const child = catalog.entries.find((entry) => entry.name === "child-skill");
    assert.equal(parent?.status, "malformed");
    assert.ok(
      parent?.issues.some((item) => item.code === "NESTED_SKILL_MANIFEST"),
    );
    assert.equal(child?.status, "valid");
  });
});

test("rejects case-equivalent manifest files where the filesystem permits them", async (context) => {
  if (process.platform === "win32") {
    context.skip("The default Windows filesystem does not allow this fixture");
    return;
  }
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    const packageDirectory = await createSkill(root, "collision-skill");
    await writeFile(
      join(packageDirectory, "skill.md"),
      await readFile(join(packageDirectory, "SKILL.md")),
    );
    const entry = onlyEntry((await scanSkillCatalog([root])).entries);
    assert.equal(entry.status, "malformed");
    assert.ok(
      entry.issues.some(
        (item) =>
          item.code === "PACKAGE_PATH_COLLISION" ||
          item.code === "MANIFEST_COUNT_INVALID",
      ),
    );
  });
});

test("rejects Unicode-normalization path collisions where the filesystem permits them", async (context) => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "skills");
    const packageDirectory = await createSkill(root, "unicode-collision");
    try {
      await writeFile(join(packageDirectory, "\u00e9.txt"), "composed", "utf8");
      await writeFile(join(packageDirectory, "e\u0301.txt"), "decomposed", "utf8");
    } catch (error) {
      context.skip(`Filesystem does not support the collision fixture: ${String(error)}`);
      return;
    }
    const entry = onlyEntry((await scanSkillCatalog([root])).entries);
    assert.equal(entry.status, "malformed");
    assert.ok(
      entry.issues.some((item) => item.code === "PACKAGE_PATH_COLLISION"),
    );
  });
});

test("surfaces unavailable roots without hiding valid roots", async () => {
  await withTempDirectory(async (directory) => {
    const validRoot = join(directory, "valid");
    await createSkill(validRoot, "valid-skill");
    const missingRoot = join(directory, "missing");
    const catalog = await scanSkillCatalog([missingRoot, validRoot]);
    assert.equal(catalog.roots.length, 2);
    assert.equal(catalog.roots[0]?.status, "unavailable");
    assert.equal(catalog.roots[1]?.status, "ready");
    assert.equal(catalog.entries.length, 1);
    assert.equal(catalog.entries[0]?.status, "valid");
  });
});

test("validates root count and limit overrides", async () => {
  await assert.rejects(
    scanSkillCatalog({ roots: ["one", "two"], limits: { maxRoots: 1 } }),
    /At most 1 skill roots/u,
  );
  await assert.rejects(
    scanSkillCatalog({ roots: [], limits: { maxPackageFiles: 0 } }),
    /positive safe integer/u,
  );
});
