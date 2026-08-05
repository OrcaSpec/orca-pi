import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeOverlay, ValidatorDeclaration } from "./runtime-overlay";
import type {
  AcceptanceGate,
  AcceptanceResult,
  StagedWorkspace,
  ValidatorRun,
} from "./staging";

/**
 * The acceptance gate: the declared validators a delegation must pass before it is
 * promoted (staged-promotion plan, Phase 4; PRD item 4).
 *
 * This module is the only place in the extension that runs a program the
 * REPOSITORY chose, and it runs them under the same discipline `git.ts` imposes on
 * git:
 *
 * - `spawn` with an ARGV ARRAY and no shell. There is no code path here that
 *   builds a command string, which is what makes "arguments are never
 *   shell-interpolated" structural: `;`, `&&`, `$(...)`, a quote, or a newline in a
 *   declared argument is one literal argv element that the program receives as data.
 *   Nothing expands it because no shell ever sees it.
 * - Every run is bounded by its own declared timeout, and a run that exceeds it is
 *   killed and reported as `timed_out`.
 * - The working directory is inside the STAGED checkout, never the user's, so a
 *   validator that writes (a formatter, a build cache, a coverage report) can only
 *   dirty work that promotion structurally cannot carry — it applies the diff
 *   between commits, and the gate runs after the last commit.
 *
 * The gate is FAIL-CLOSED in every direction: a non-zero exit, a timeout, a program
 * that is not installed, a declared `cwd` that does not exist, output past the
 * capture cap, a cancelled delegation — all of them refuse the promotion. A declared
 * check that did not run is not a check that passed, and the alternative (promote
 * anyway, mention it) is exactly the silent-degradation the plan rules out.
 *
 * The gate is ASYNCHRONOUS (hardening plan, Phase 1). It began as `spawnSync`, like
 * `git.ts`, which cost the session its event loop for as long as a validator ran: a
 * slow suite froze the TUI at the end of a delegation and could not be cancelled
 * mid-run. Running the same programs through `spawn` and awaiting them changes
 * nothing about the verdicts — order, per-run timeouts, output capture and
 * classification are unchanged — and buys two things the synchronous version could
 * not have:
 *
 * - The session stays live while a validator runs.
 * - A CANCELLED delegation kills the running child ({@link ValidatorRun.status}
 *   `cancelled`), which refuses the promotion through the ordinary gate-refusal
 *   path with the killed run recorded as evidence.
 *
 * What the synchronous version bought — that the gate and the promotion it guards
 * are one uninterleaved step — was never actually a guarantee about the USER's
 * checkout, only about this process: the user edits their own files throughout, which
 * is why `staging.ts` re-verifies the base binding after the gate returns. That
 * re-check is what makes awaiting here safe, and it is unchanged.
 */

/** How much of each captured stream is kept as evidence. */
export const MAX_OUTPUT_CHARS = 4000;

/** How much output a validator may produce before it is cut off entirely. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * How long a killed validator is given to exit before it is killed unconditionally.
 *
 * A kill is `SIGTERM` first, so a program that installs a handler can flush its own
 * output — but a program that IGNORES `SIGTERM` must not be able to outlive its
 * budget, which under the synchronous gate is exactly what it did: `spawnSync` waited
 * for a child that never left. The escalation is what makes "every run is bounded"
 * true of a hostile or merely buggy program rather than only a cooperative one.
 */
const KILL_ESCALATION_MS = 1000;

function truncate(value: Buffer | string | null): string {
  const text = value == null ? "" : value.toString();
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated at ${MAX_OUTPUT_CHARS} characters)`
    : text;
}

/**
 * Why the runtime killed a validator, when it did. Each maps to exactly one
 * {@link ValidatorStatus}, and all three refuse the promotion — the distinction is
 * only what the steward is told stopped it.
 */
type KillReason = "timeout" | "cancelled" | "overflow";

/**
 * One validator, run to a verdict. Never rejects: a failure to start IS a verdict.
 *
 * `signal` is the delegation's cancellation (`RunDeps.signal`, threaded through
 * `promoteStagedCommits`). When it fires the child is killed and the run is recorded
 * `cancelled`; when it has ALREADY fired no process is spawned at all, and the run is
 * still recorded, so the evidence names the validator the cancellation cut short.
 */
function runValidator(
  workspace: StagedWorkspace,
  agent: string,
  declaration: ValidatorDeclaration,
  signal?: AbortSignal,
): Promise<ValidatorRun> {
  const { program, args, cwd, timeoutSeconds } = declaration;
  const identity = { agent, program, args: [...args], cwd, timeoutSeconds };

  if (signal?.aborted) {
    return Promise.resolve({
      ...identity,
      status: "cancelled",
      stdout: "",
      stderr: "The delegation was cancelled before this validator started.",
    });
  }

  return new Promise<ValidatorRun>((resolve) => {
    const child = spawn(program, args, {
      cwd: cwd === "" ? workspace.dir : join(workspace.dir, cwd),
      // stdin is CLOSED rather than piped, which is what `spawnSync` gave a validator
      // that read it: EOF. An open pipe nothing ever writes to would leave a program
      // waiting on stdin hanging until its declared timeout killed it.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
    let captured = 0;
    let killedBecause: KillReason | undefined;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;

    const kill = (reason: KillReason): void => {
      killedBecause ??= reason;
      child.kill();
      escalation ??= setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATION_MS);
    };

    const budget = setTimeout(
      () => kill("timeout"),
      Math.max(1, Math.round(timeoutSeconds * 1000)),
    );
    const onAbort = (): void => kill("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.on("data", (chunk: Buffer) => {
        // The cap bounds this process's memory, not the validator's output: what is
        // over the line is dropped and the run is stopped, exactly as `spawnSync`'s
        // `maxBuffer` did.
        if (captured >= MAX_OUTPUT_BYTES) return;
        captured += chunk.length;
        chunks[stream].push(chunk);
        if (captured >= MAX_OUTPUT_BYTES) kill("overflow");
      });
      // An unreadable pipe is not a verdict; the exit code (or the kill) is.
      child[stream]?.on("error", () => {});
    }

    /** Resolve exactly once, with every timer and listener released. */
    const settle = (run: ValidatorRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
      resolve(run);
    };

    const evidence = (terminatedBy?: NodeJS.Signals | null) => ({
      ...identity,
      stdout: truncate(Buffer.concat(chunks.stdout)),
      stderr: truncate(Buffer.concat(chunks.stderr)),
      signal: terminatedBy ?? undefined,
    });

    // A process that could not be started at all: no program, no executable bit, a
    // declared `cwd` that does not exist in the checkout.
    child.on("error", (error) => {
      const base = evidence();
      settle(
        killedBecause === "cancelled"
          ? { ...base, status: "cancelled" }
          : { ...base, status: "unavailable", stderr: base.stderr || error.message },
      );
    });

    // `close` rather than `exit`: it fires once the captured streams have ended too,
    // so a program's last line of output is in the evidence.
    child.on("close", (code, terminatedBy) => {
      const base = evidence(terminatedBy);
      switch (killedBecause) {
        case "timeout":
          return settle({ ...base, status: "timed_out" });
        case "cancelled":
          return settle({ ...base, status: "cancelled" });
        case "overflow":
          return settle({
            ...base,
            status: "unavailable",
            stderr:
              base.stderr ||
              `the validator produced more than ${MAX_OUTPUT_BYTES} bytes of output and was stopped`,
          });
        default:
          // Killed by a signal without an exit code — by something other than this
          // gate — is not a verdict the program gave.
          return settle(
            code === null
              ? { ...base, status: "unavailable" }
              : { ...base, status: code === 0 ? "passed" : "failed", exitCode: code },
          );
      }
    });
  });
}

/** How one run reads in a diagnostic line and in the preserved log. */
function describe(run: ValidatorRun): string {
  const where = run.cwd === "" ? "the checkout root" : run.cwd;
  const outcome =
    run.status === "passed"
      ? "passed"
      : run.status === "failed"
        ? `FAILED (exit ${run.exitCode})`
        : run.status === "timed_out"
          ? `TIMED OUT after ${run.timeoutSeconds}s`
          : run.status === "cancelled"
            ? "CANCELLED (the delegation was cancelled)"
            : `could not be run${run.signal ? ` (killed by ${run.signal})` : ""}`;
  return `[${run.agent}] ${run.program} ${JSON.stringify(run.args)} in ${where}: ${outcome}`;
}

/** The preserved evidence file: every run, in order, with its captured output. */
function renderOutput(runs: readonly ValidatorRun[]): string {
  const lines = [
    "Orca acceptance gate — validators declared in .orca/runtime.yaml",
    "",
  ];
  for (const run of runs) {
    lines.push(describe(run));
    lines.push(`  timeout: ${run.timeoutSeconds}s`);
    if (run.stdout) lines.push("  stdout:", ...indent(run.stdout));
    if (run.stderr) lines.push("  stderr:", ...indent(run.stderr));
    lines.push("");
  }
  return lines.join("\n");
}

function indent(text: string): string[] {
  return text.replace(/\n$/, "").split("\n").map((line) => `    ${line}`);
}

/** Write the run log beside the preserved patch; returns where it landed. */
function preserveOutput(workspace: StagedWorkspace, runs: readonly ValidatorRun[]): string {
  mkdirSync(dirname(workspace.validatorOutputPath), { recursive: true });
  writeFileSync(workspace.validatorOutputPath, renderOutput(runs), "utf8");
  return workspace.validatorOutputPath;
}

/**
 * The validators that apply to one delegation: every participating owner's
 * declarations, in execution order, then declaration order.
 *
 * Only the OWNERS THAT RAN contribute. An overlay may declare validators for every
 * agent in the repository, but a delegation is accountable for the work it did:
 * running a untouched agent's suite would make an unrelated pre-existing failure
 * refuse a promotion the delegation had no way to fix.
 */
function planFor(
  overlay: RuntimeOverlay,
  owners: readonly string[],
): Array<{ agent: string; declaration: ValidatorDeclaration }> {
  return owners.flatMap((agent) =>
    (overlay.validations[agent] ?? []).map((declaration) => ({ agent, declaration })),
  );
}

/**
 * Build the acceptance gate for a delegation, or `undefined` when the overlay
 * declares nothing for any participating owner.
 *
 * Returning `undefined` rather than an always-passing gate is deliberate: a
 * repository with no validators must take the Phase 3 promotion path exactly, with
 * no validator vocabulary in its outcome and no process spawned.
 *
 * The gate stops at the FIRST validator that does not pass. Once one has refused,
 * the promotion cannot happen, and continuing would spend the user's time running
 * suites whose verdict changes nothing — the refusal names what stopped it, and the
 * preserved log carries that run's full output. A cancellation is one more way not to
 * pass, so it stops the sequence of runs the same way and needs no path of its own.
 */
export function createAcceptanceGate(
  overlay: RuntimeOverlay,
  owners: readonly string[],
): AcceptanceGate | undefined {
  const plan = planFor(overlay, owners);
  if (plan.length === 0) return undefined;

  return async (workspace: StagedWorkspace, signal?: AbortSignal): Promise<AcceptanceResult> => {
    const runs: ValidatorRun[] = [];
    for (const { agent, declaration } of plan) {
      const run = await runValidator(workspace, agent, declaration, signal);
      runs.push(run);
      if (run.status !== "passed") {
        return {
          ok: false,
          validations: runs,
          validatorOutputPath: preserveOutput(workspace, runs),
          diagnostics: [
            describe(run),
            ...(plan.length > runs.length
              ? [
                  `${plan.length - runs.length} later validator(s) were not run: the promotion was ` +
                    "already refused.",
                ]
              : []),
            `The validator output is preserved at ${workspace.validatorOutputPath}.`,
          ],
        };
      }
    }
    return {
      ok: true,
      validations: runs,
      diagnostics: [`All ${runs.length} declared validator(s) passed: ${runs.map(describe).join("; ")}.`],
    };
  };
}
