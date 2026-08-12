import { useMemo } from "react";
import { parseMarkdownChecklist } from "./markdown-checklist";

interface MarkdownChecklistProps {
  markdown: string;
}

export function MarkdownChecklist({ markdown }: MarkdownChecklistProps) {
  const items = useMemo(() => parseMarkdownChecklist(markdown), [markdown]);
  if (items.length === 0) return null;

  const completed = items.filter((item) => item.checked).length;
  const progress = Math.round((completed / items.length) * 100);

  return (
    <section className="markdown-checklist" aria-labelledby="markdown-checklist-heading">
      <div className="markdown-checklist-heading">
        <div>
          <p className="eyebrow">Live task state</p>
          <h3 id="markdown-checklist-heading">Work checklist</h3>
        </div>
        <strong>{completed} / {items.length} finished</strong>
      </div>
      <div
        className="markdown-checklist-progress"
        role="progressbar"
        aria-label="Checklist completion"
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={completed}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <ol aria-live="polite">
        {items.map((item) => (
          <li key={`${item.line}-${item.label}`} className={item.checked ? "finished" : "pending"}>
            <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} />
            <span>{item.label}</span>
            <small>{item.checked ? "Finished" : "To do"}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}
