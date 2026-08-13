import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdownChecklist } from "../src/markdown-checklist.ts";

test("extracts every Markdown task and normalizes display labels", () => {
  assert.deepEqual(
    parseMarkdownChecklist([
      "- [ ] `change:add-vite` - Add **Vite**",
      "  * [x] `verify:build` - Build client",
      "+ [X] escaped\\-label",
    ].join("\n")),
    [
      { checked: false, label: "change:add-vite - Add Vite", line: 1 },
      { checked: true, label: "verify:build - Build client", line: 2 },
      { checked: true, label: "escaped-label", line: 3 },
    ],
  );
});

test("ignores checkbox examples inside fenced code blocks", () => {
  const markdown = [
    "````markdown",
    "- [x] not a result",
    "```",
    "- [ ] still fenced",
    "````",
    "- [x] actual result",
    "~~~",
    "- [ ] another example",
    "~~~",
  ].join("\n");

  assert.deepEqual(parseMarkdownChecklist(markdown), [
    { checked: true, label: "actual result", line: 6 },
  ]);
});

test("does not treat inline or empty brackets as tasks", () => {
  assert.deepEqual(
    parseMarkdownChecklist("Paragraph [x] inline\n- [ ]\n- [no] invalid"),
    [],
  );
});
