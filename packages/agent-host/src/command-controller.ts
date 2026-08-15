import { startAgentRun } from "./agent-runner.js";
import { startPlanRun } from "./plan-runner.js";
import type { ActiveRun, HostEvent, RunCommand } from "./protocol.js";
import { parseHostCommand, validateRunCommand } from "./validation.js";

interface PendingRun {
  activeRun?: ActiveRun;
  cancel: () => void;
  cancelled: Promise<void>;
  cancellationRequested: boolean;
  runId: string;
}

interface CommandControllerDependencies {
  start?: (command: RunCommand, emit: (event: HostEvent) => void) => ActiveRun;
  validate?: (value: unknown) => Promise<RunCommand>;
}

type ValidationOutcome =
  | { type: "cancelled" }
  | { type: "failed"; error: unknown }
  | { type: "validated"; command: RunCommand };

function startRun(
  command: RunCommand,
  emit: (event: HostEvent) => void,
): ActiveRun {
  return command.type === "start_plan"
    ? startPlanRun(command, emit)
    : startAgentRun(command, emit);
}

export class HostCommandController {
  readonly #emit: (event: HostEvent) => void;
  readonly #onFinished: () => void;
  readonly #start: (command: RunCommand, emit: (event: HostEvent) => void) => ActiveRun;
  readonly #validate: (value: unknown) => Promise<RunCommand>;
  #pendingRun?: PendingRun;

  constructor(
    emit: (event: HostEvent) => void,
    onFinished: () => void,
    dependencies: CommandControllerDependencies = {},
  ) {
    this.#emit = emit;
    this.#onFinished = onFinished;
    this.#start = dependencies.start ?? startRun;
    this.#validate = dependencies.validate ?? validateRunCommand;
  }

  handleLine(line: string): void {
    if (!line.trim()) return;

    let command;
    try {
      command = parseHostCommand(line);
    } catch (error) {
      this.#emitFailure("unknown", error);
      return;
    }

    if (command.type === "cancel") {
      this.#cancel(command.runId, true);
      return;
    }

    if (this.#pendingRun) {
      this.#emitFailure(command.runId, new Error("An agent run is already active"));
      return;
    }

    let resolveCancellation!: () => void;
    const pendingRun: PendingRun = {
      cancel: () => resolveCancellation(),
      cancelled: new Promise<void>((resolve) => {
        resolveCancellation = resolve;
      }),
      cancellationRequested: false,
      runId: command.runId,
    };
    this.#pendingRun = pendingRun;
    void this.#run(command, pendingRun);
  }

  abortActive(): void {
    if (this.#pendingRun) this.#cancel(this.#pendingRun.runId, false);
  }

  #cancel(runId: string, emitStatus: boolean): void {
    const pendingRun = this.#pendingRun;
    if (!pendingRun || pendingRun.runId !== runId) return;

    if (!pendingRun.cancellationRequested) {
      pendingRun.cancellationRequested = true;
      pendingRun.cancel();
      if (emitStatus) {
        this.#emit({
          type: "status",
          runId,
          phase: "cancelling",
          message: "Cancellation requested",
        });
      }
    }
    pendingRun.activeRun?.abort();
  }

  async #run(command: RunCommand, pendingRun: PendingRun): Promise<void> {
    try {
      const validation = this.#validate(command).then<
        ValidationOutcome,
        ValidationOutcome
      >(
        (validated) => ({ type: "validated", command: validated }),
        (error: unknown) => ({ type: "failed", error }),
      );
      const cancellation = pendingRun.cancelled.then<ValidationOutcome>(() => ({
        type: "cancelled",
      }));
      const outcome = await Promise.race([validation, cancellation]);

      if (outcome.type === "cancelled") {
        this.#emit({
          type: "result",
          runId: command.runId,
          success: false,
          cancelled: true,
          error: "Run cancelled before validation completed",
        });
        return;
      }
      if (outcome.type === "failed") {
        this.#emitFailure(command.runId, outcome.error);
        return;
      }

      pendingRun.activeRun = this.#start(outcome.command, this.#emit);
      if (pendingRun.cancellationRequested) pendingRun.activeRun.abort();
      await pendingRun.activeRun.done;
    } catch (error) {
      this.#emitFailure(command.runId, error, pendingRun.cancellationRequested);
    } finally {
      if (this.#pendingRun === pendingRun) this.#pendingRun = undefined;
      this.#onFinished();
    }
  }

  #emitFailure(runId: string, error: unknown, cancelled = false): void {
    this.#emit({
      type: "result",
      runId,
      success: false,
      cancelled,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
