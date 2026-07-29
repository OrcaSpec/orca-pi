import type { DelegationProgress } from "./delegation";
import type { CheckpointStatus } from "./checkpoint";
import { shortStatus, type RepositoryState } from "./state";

/**
 * The single UI seam for Orca (PRD "Commands and status"). Every notification,
 * footer status, and widget update goes through {@link Surface}, so there is ONE
 * place that (a) guards `ctx.hasUI` and (b) chooses a headless fallback. Routing
 * all surfaces through it is what lets the tests assert, with a fake capturing
 * ctx, that a headless (`hasUI: false`) run performs zero UI calls while the
 * governance logic is unchanged — and that activation, mode changes, violations,
 * and delegation progress each reach the surface exactly once.
 *
 * Headless behaviour matches the pre-Phase-8 handlers: plain text on stdout,
 * except in the structured protocol modes (`json`/`rpc`) where stdout carries the
 * protocol and must not be polluted.
 */

export type NotifyLevel = "info" | "warning" | "error";

/** The subset of `ctx.ui` the surface uses (kept narrow so a fake is trivial). */
export interface SurfaceUi {
  notify(message: string, type?: NotifyLevel): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined): void;
}

/** The subset of an extension context the surface needs. */
export interface SurfaceCtx {
  hasUI: boolean;
  mode?: string;
  ui: SurfaceUi;
}

/** The widget/status key Orca owns. */
const ORCA_KEY = "orca";

export class Surface {
  constructor(private readonly ctx: SurfaceCtx) {}

  /** In headless runs, only plain (`tui`/`print`) modes may log to stdout. */
  private get headlessLoggable(): boolean {
    return this.ctx.mode !== "json" && this.ctx.mode !== "rpc";
  }

  /** Notify the human; UI notification when present, else headless stdout. */
  notify(message: string, level: NotifyLevel = "info"): void {
    if (this.ctx.hasUI) {
      this.ctx.ui.notify(message, level);
      return;
    }
    if (this.headlessLoggable) console.log(message);
  }

  /** Set the compact footer status (no-op headless). */
  status(value: string): void {
    if (this.ctx.hasUI) this.ctx.ui.setStatus(ORCA_KEY, value);
  }

  /** Set the widget panel above the editor (no-op headless). */
  widget(lines: string[]): void {
    if (this.ctx.hasUI) this.ctx.ui.setWidget(ORCA_KEY, lines);
  }
}

/** A one-line human rendering of a delegation progress event (for onUpdate / notify). */
export function progressLine(progress: DelegationProgress): string {
  switch (progress.kind) {
    case "sequence_start":
      return `Orca: delegating to ${progress.total} owner(s) — ${progress.owners.join(", ")}.`;
    case "step_start":
      return `Orca: [${progress.index}/${progress.total}] ${progress.owner}${
        progress.assignmentId ? ` (${progress.assignmentId})` : ""
      } — running…`;
    case "step_activity":
      return `Orca: [${progress.index}/${progress.total}] ${progress.owner} — ${progress.note}`;
    case "step_end":
      return (
        `Orca: [${progress.index}/${progress.total}] ${progress.owner} — ${progress.status}` +
        (progress.changedPaths > 0 ? ` (${progress.changedPaths} changed)` : "")
      );
    case "sequence_end":
      return `Orca: delegation ${progress.allCompleted ? "complete" : "ended"} — ${progress.completed}/${progress.total} completed.`;
  }
}

/** The in-flight delegation state shown on the widget while a sequence runs. */
export interface InflightDelegation {
  owner: string;
  index: number;
  total: number;
  status: "running" | CheckpointStatus | "build_failed";
  assignmentId?: string;
}

/** Track the in-flight delegation as progress events arrive; undefined when idle. */
export function inflightFromProgress(
  current: InflightDelegation | undefined,
  progress: DelegationProgress,
): InflightDelegation | undefined {
  switch (progress.kind) {
    case "sequence_start":
      return undefined;
    case "step_start":
      return {
        owner: progress.owner,
        ...(progress.assignmentId ? { assignmentId: progress.assignmentId } : {}),
        index: progress.index,
        total: progress.total,
        status: "running",
      };
    case "step_activity":
      return current
        ? { ...current }
        : {
            owner: progress.owner,
            ...(progress.assignmentId ? { assignmentId: progress.assignmentId } : {}),
            index: progress.index,
            total: progress.total,
            status: "running",
          };
    case "step_end":
      return {
        owner: progress.owner,
        ...(progress.assignmentId ? { assignmentId: progress.assignmentId } : {}),
        index: progress.index,
        total: progress.total,
        status: progress.status,
      };
    case "sequence_end":
      return undefined;
  }
}

/** Inputs for the compact live status widget. */
export interface WidgetInput {
  state: RepositoryState;
  violationCount: number;
  historyCount: number;
  inflight?: InflightDelegation;
}

/**
 * The compact, always-visible status widget: governance state, effective mode,
 * violation count, delegation count, and the in-flight delegation (owner + step
 * k/N + status) when one is running. This is the live panel; the `/orca` command
 * renders the fuller status block.
 */
export function statusWidgetLines(input: WidgetInput): string[] {
  const lines = [shortStatus(input.state)];
  if (input.state.kind === "active") {
    lines.push(`Effective mode: ${input.state.effectiveMode}`);
  }
  lines.push(`Governance events: ${input.violationCount}`);
  lines.push(`Delegations recorded: ${input.historyCount}`);
  if (input.inflight) {
    lines.push(
      `In-flight: ${input.inflight.owner}${
        input.inflight.assignmentId ? ` [${input.inflight.assignmentId}]` : ""
      } (step ${input.inflight.index}/${input.inflight.total}) — ${input.inflight.status}`,
    );
  }
  return lines;
}
