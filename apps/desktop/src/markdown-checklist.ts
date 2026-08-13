export interface MarkdownChecklistItem {
  checked: boolean;
  label: string;
  line: number;
}

const TASK_LINE = /^\s*[-+*]\s+\[([ xX])\]\s+(.+?)\s*$/u;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/u;

function displayLabel(value: string): string {
  return value
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/\\([\\`*_{}[\]()#+.!|\-])/gu, "$1");
}

export function parseMarkdownChecklist(markdown: string): MarkdownChecklistItem[] {
  const items: MarkdownChecklistItem[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const [index, line] of markdown.split(/\r?\n/u).entries()) {
    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0];
      if (marker === "`" || marker === "~") {
        const length = fenceMatch[1]?.length ?? 0;
        if (!fence) fence = { marker, length };
        else if (fence.marker === marker && length >= fence.length) fence = undefined;
      }
      continue;
    }
    if (fence) continue;

    const match = TASK_LINE.exec(line);
    if (!match?.[2]) continue;
    items.push({
      checked: match[1]?.toLowerCase() === "x",
      label: displayLabel(match[2]),
      line: index + 1,
    });
  }

  return items;
}
