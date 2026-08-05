import { spawnSync } from "node:child_process";
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
 * - `spawnSync` with an ARGV ARRAY and no shell. There is no code path here that
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
 * that is not installed, a declared `cwd` that does not exist — all of them refuse
 * the promotion. A declared check that did not run is not a check that passed, and
 * the alternative (promote anyway, mention it) is exactly the silent-degradation the
 * plan rules out.
 *
 * KNOWN COST of running synchronously (`spawnSync`, like `git.ts`): a validator holds
 * the event loop for as long as it runs, so a slow suite freezes the TUI at the end
 * of a delegation and cannot be cancelled mid-run. What it buys is that the gate and
 * the promotion it guards are one uninterleaved step — nothing else can touch the
 * checkout between the verdict and the patch. If responsiveness during long
 * validators matters more, the seam to change is {@link AcceptanceGate}: making it
 * async is mechanical, and the promotion path it runs on is already async above
 * `promoteStagedCommits`.
 */

/** How much of each captured stream is kept as evidence. */
export const MAX_OUTPUT_CHARS = 4000;

/** How much output a validator may produce before it is cut off entirely. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function truncate(value: Buffer | string | null): string {
  const text = value == null ? "" : value.toString();
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated at ${MAX_OUTPUT_CHARS} characters)`
    : text;
}

/** One validator, run to a verdict. Never throws: a failure to start IS a verdict. */
function runValidator(
  workspace: StagedWorkspace,
  agent: string,
  declaration: ValidatorDeclaration,
): ValidatorRun {
  const { program, args, cwd, timeoutSeconds } = declaration;
  const result = spawnSync(program, args, {
    cwd: cwd === "" ? workspace.dir : join(workspace.dir, cwd),
    timeout: Math.max(1, Math.round(timeoutSeconds * 1000)),
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });

  const base = {
    agent,
    program,
    args: [...args],
    cwd,
    timeoutSeconds,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    signal: result.signal ?? undefined,
  };

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ...base,
      status: code === "ETIMEDOUT" ? "timed_out" : "unavailable",
      stderr: base.stderr || result.error.message,
    };
  }
  if (result.status === null) {
    // Killed by a signal without an exit code: not a verdict the program gave.
    return { ...base, status: "unavailable" };
  }
  return {
    ...base,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
  };
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
 * preserved log carries that run's full output.
 */
export function createAcceptanceGate(
  overlay: RuntimeOverlay,
  owners: readonly string[],
): AcceptanceGate | undefined {
  const plan = planFor(overlay, owners);
  if (plan.length === 0) return undefined;

  return (workspace: StagedWorkspace): AcceptanceResult => {
    const runs: ValidatorRun[] = [];
    for (const { agent, declaration } of plan) {
      const run = runValidator(workspace, agent, declaration);
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
