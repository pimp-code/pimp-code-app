import assert from "node:assert/strict";
import test from "node:test";
import { HostCommandController } from "../src/command-controller.js";
import type { HostEvent, StartCommand } from "../src/protocol.js";

function startCommand(runId: string): StartCommand {
  return {
    type: "start",
    runId,
    cwd: process.cwd(),
    prompt: "Inspect the repository",
    maxTurns: 1,
    provider: { kind: "claude", model: "sonnet" },
  };
}

test("reserves a run and honours cancellation while validation is pending", async () => {
  const events: HostEvent[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let resolveValidation!: (command: StartCommand) => void;
  const validation = new Promise<StartCommand>((resolve) => {
    resolveValidation = resolve;
  });
  let starts = 0;
  const first = startCommand("first-run");
  const second = startCommand("second-run");
  const controller = new HostCommandController(
    (event) => events.push(event),
    finish,
    {
      validate: () => validation,
      start: () => {
        starts += 1;
        return { abort() {}, done: Promise.resolve() };
      },
    },
  );

  controller.handleLine(JSON.stringify(first));
  controller.handleLine(JSON.stringify(second));
  controller.handleLine(
    JSON.stringify({ type: "cancel", runId: first.runId }),
  );
  await finished;
  resolveValidation(first);

  assert.equal(starts, 0);
  assert.deepEqual(
    events.filter((event) => event.type === "result"),
    [
      {
        type: "result",
        runId: second.runId,
        success: false,
        cancelled: false,
        error: "An agent run is already active",
      },
      {
        type: "result",
        runId: first.runId,
        success: false,
        cancelled: true,
        error: "Run cancelled before validation completed",
      },
    ],
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "status" &&
        event.runId === first.runId &&
        event.phase === "cancelling",
    ),
  );
});
