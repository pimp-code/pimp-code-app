import { createInterface } from "node:readline";
import { HostCommandController } from "./command-controller.js";
import type { HostEvent } from "./protocol.js";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function emit(event: HostEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const controller = new HostCommandController(emit, () => input.close());

input.on("line", (line) => {
  controller.handleLine(line);
});

input.on("close", () => {
  controller.abortActive();
});

process.on("SIGINT", () => controller.abortActive());
process.on("SIGTERM", () => controller.abortActive());
