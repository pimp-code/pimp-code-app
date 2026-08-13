import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { App } from "../src/App";

export async function runAct(callback: () => void | Promise<void>): Promise<void> {
  await callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function mount(element: Element): Promise<Root> {
  const root = createRoot(element);
  root.render(createElement(App));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return root;
}

export async function unmount(root: Root): Promise<void> {
  root.unmount();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
