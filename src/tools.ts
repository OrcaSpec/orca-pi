import { Type, type Static } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { normalizeTarget } from "./paths";
import { resolve, type Resolution } from "./resolver";
import { renderExplain, renderResolvePreview, summarizeResolution } from "./render";
import { formatStatusLines, type ActiveState, type RepositoryState } from "./state";
import type { OperatingMode } from "./mode";
import type { CheckpointStatus } from "./checkpoint";
import {
  runDelegationSequence,
  stepCompleted,
  type DelegationEntry,
  type DelegationInputs,
  type DelegationOutcome,
  type DelegationProgress,
  type DelegationSession,
  type DelegationSessionConfig,
  type SequenceOutcome,
} from "./delegation";
import {
  buildDelegationRecord,
  digestGrants,
  renderRecordLines,
  type PersistedDelegationRecord,
} from "./delegation-entry";
import { progressLine } from "./surface";
import { linesComponent } from "./tui";

/**
 * The two routing-preview tools, `orca_resolve` (model facing) and
 * `orca_explain` (human facing). Both are registered globally by the extension;
 * both check the current repository state at call time and, when governance is
 * not active, explain that state rather than throwing (works in advisory and
 * enforce alike). Neither has any side effect on the working tree and neither
 * delegates — delegation arrives in Phase 6.
 *
 * The two tools share {@link computeOutcome}, so a given target set produces one
 * {@link Resolution} regardless of which tool is called; they differ only in how
 * they render it (via `render.ts`, whose grant formatter both reuse). That is
 * what keeps the human explanation provably consistent with the machine preview.
 */

const paramsSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1, description: "A repository-relative target path." }), {
      minItems: 1,
      description:
        "Concrete repository-relative target paths to preview routing for. Not agent ids.",
    }),
  },
  { description: "Target paths to resolve to their structural owners." },
);

type ToolParams = Static<typeof paramsSchema>;

/** Pre-spawn delegation failure kinds surfaced to the steward. */
export type DelegationFailureKind = "unknown_owner" | "required_missing" | "oversized";

/** Structured details attached to a tool result for logs / UI. */
export type ResolveToolDetails =
  | { kind: "resolution"; resolution: Resolution }
  | { kind: "inactive"; state: RepositoryState["kind"] }
  | { kind: "invalid"; rejections: { input: string; reason: string }[] }
  | { kind: "empty" }
  | { kind: "delegation"; outcome: DelegationOutcome; record: PersistedDelegationRecord }
  | { kind: "delegation_failed"; failureKind: DelegationFailureKind; diagnostics: string[] }
  | {
      kind: "delegation_sequence";
      sequence: SequenceOutcome;
      unmanaged: string[];
      mode: OperatingMode;
      record: PersistedDelegationRecord;
    }
  | { kind: "unowned_blocked"; unownedPaths: string[]; resolution: Resolution }
  | { kind: "all_unmanaged"; unownedPaths: string[] }
  | { kind: "progress"; progress: DelegationProgress };

type ToolOutcome =
  | { kind: "resolution"; resolution: Resolution }
  | { kind: "inactive"; state: RepositoryState }
  | { kind: "invalid"; rejections: { input: string; reason: string }[] }
  | { kind: "empty" };

/** Dependencies the extension injects when constructing the tools. */
export interface ToolDeps {
  /** Detect the current repository state for a working directory. */
  getState: (cwd: string) => RepositoryState;
  /** Record a successful route decision (only wired for `orca_resolve`). */
  onRoute?: (resolution: Resolution) => void;
}

/**
 * Run the shared pipeline: require an active spec, normalize every target path
 * (rejecting the whole call if any escapes the repository), then resolve. This
 * is the single decision point both tools funnel through.
 */
function computeOutcome(state: RepositoryState, rawPaths: string[], repoRoot: string): ToolOutcome {
  if (rawPaths.length === 0) return { kind: "empty" };
  if (state.kind !== "active") return { kind: "inactive", state };

  const normalized: string[] = [];
  const rejections: { input: string; reason: string }[] = [];
  for (const raw of rawPaths) {
    const result = normalizeTarget(raw, repoRoot);
    if (result.ok) normalized.push(result.path);
    else rejections.push({ input: result.input, reason: result.reason });
  }
  if (rejections.length > 0) return { kind: "invalid", rejections };

  return { kind: "resolution", resolution: resolve(state.document, normalized) };
}

function text(body: string, details: ResolveToolDetails): AgentToolResult<ResolveToolDetails> {
  return { content: [{ type: "text", text: body }], details };
}

function inactiveResult(state: RepositoryState): AgentToolResult<ResolveToolDetails> {
  const body = [
    "Orca routing is unavailable: the repository is not under active governance.",
    "",
    ...formatStatusLines(state),
  ].join("\n");
  return text(body, { kind: "inactive", state: state.kind });
}

function invalidResult(
  rejections: { input: string; reason: string }[],
): AgentToolResult<ResolveToolDetails> {
  const body = [
    "Orca could not resolve these targets — fix the paths and retry with concrete repository-relative paths:",
    ...rejections.map((rejection) => `  - ${rejection.input}: ${rejection.reason}`),
  ].join("\n");
  return text(body, { kind: "invalid", rejections });
}

const emptyResult = (): AgentToolResult<ResolveToolDetails> =>
  text("Provide at least one concrete target path to preview routing.", { kind: "empty" });

/** `orca_resolve`: model-facing routing preview; records the decision. */
export function createResolveTool(deps: ToolDeps): ToolDefinition<typeof paramsSchema, ResolveToolDetails> {
  return defineTool({
    name: "orca_resolve",
    label: "Orca resolve",
    description:
      "Preview how Orca routes concrete target paths to their structural owners: per-path owner " +
      "and writability, and the compiled read/write grant per owner. No delegation, no writes. " +
      "Pass repository-relative target paths, never an agent id.",
    promptSnippet: "orca_resolve — preview routing (owners + grants) for target paths, no side effects.",
    parameters: paramsSchema,
    async execute(
      _toolCallId: string,
      params: ToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<ResolveToolDetails>> {
      const outcome = computeOutcome(deps.getState(ctx.cwd), params.paths, ctx.cwd);
      switch (outcome.kind) {
        case "empty":
          return emptyResult();
        case "inactive":
          return inactiveResult(outcome.state);
        case "invalid":
          return invalidResult(outcome.rejections);
        case "resolution":
          deps.onRoute?.(outcome.resolution);
          return text(renderResolvePreview(outcome.resolution), {
            kind: "resolution",
            resolution: outcome.resolution,
          });
      }
    },
  });
}

/** `orca_explain`: human-facing rendering of the same decision `orca_resolve` makes. */
export function createExplainTool(deps: ToolDeps): ToolDefinition<typeof paramsSchema, ResolveToolDetails> {
  return defineTool({
    name: "orca_explain",
    label: "Orca explain",
    description:
      "Explain, for a human, how Orca routes concrete target paths: which ownership scope matched " +
      "each target and why it is the most specific, what deny (if any) removed write access, and " +
      "the compiled grant per owner. Same decision as orca_resolve, rendered readably. No writes.",
    promptSnippet: "orca_explain — render a human-readable routing explanation for target paths.",
    parameters: paramsSchema,
    async execute(
      _toolCallId: string,
      params: ToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<ResolveToolDetails>> {
      const outcome = computeOutcome(deps.getState(ctx.cwd), params.paths, ctx.cwd);
      switch (outcome.kind) {
        case "empty":
          return emptyResult();
        case "inactive":
          return inactiveResult(outcome.state);
        case "invalid":
          return invalidResult(outcome.rejections);
        case "resolution":
          return text(renderExplain(outcome.resolution), {
            kind: "resolution",
            resolution: outcome.resolution,
          });
      }
    },
  });
}

const delegateParamsSchema = Type.Object(
  {
    task: Type.String({
      minLength: 1,
      description: "What the owning agent should do, in plain language.",
    }),
    paths: Type.Array(
      Type.String({ minLength: 1, description: "A repository-relative target path." }),
      {
        minItems: 1,
        description:
          "Concrete repository-relative target paths the task will change. Not agent ids.",
      },
    ),
  },
  { description: "Delegate a task to the resolver-assigned owner(s) of the given target paths." },
);

/** Exported so `tool_call` handlers and tests can type the delegate input. */
export type DelegateToolInput = Static<typeof delegateParamsSchema>;

/** Dependencies the delegate tool needs beyond routing: model, session factory, sink. */
export interface DelegateDeps extends ToolDeps {
  /** The parent session's current thinking level (ADR 0076); model comes from ctx. */
  getThinkingLevel: () => ThinkingLevel;
  /** Spawn a delegated session from an assembled config (the run-loop seam). */
  createSession: (config: DelegationSessionConfig) => Promise<DelegationSession>;
  /** Record a per-owner delegation entry as it terminates (route-log breadcrumb). */
  onDelegation?: (entry: DelegationEntry) => void;
  /**
   * Record an unowned-target delegation event (ADR 0012): `blocked` when enforce
   * mode fails the delegation pre-spawn, `flagged` when advisory mode proceeds
   * with the owned subset and leaves the unowned paths as unmanaged work.
   */
  onUnowned?: (paths: string[], mode: OperatingMode, verdict: "blocked" | "flagged") => void;
  /**
   * Persist a completed delegation SEQUENCE as a session entry and add it to the
   * durable history (PRD "User Surface"). Called once per sequence, after it ends.
   */
  onDelegationRecord?: (record: PersistedDelegationRecord) => void;
  /**
   * Live progress sink, invoked with the tool's own ctx so the extension can
   * update the status widget and notify the human as a delegation runs. Progress
   * is ALSO streamed into the tool's `onUpdate` for the TUI regardless of this.
   */
  onProgress?: (progress: DelegationProgress, ctx: ExtensionContext) => void;
}

/** The observed-manifest line shared by every checkpoint rendering. */
function manifestLine(paths: string[]): string {
  return paths.length > 0
    ? `Observed changed paths (${paths.length}): ${paths.join(", ")}`
    : "Observed changed paths: (none).";
}

/**
 * Render how the steward re-delegates after a `needs_scope` outcome (ADR 0008).
 * The point of the loop is a FRESH delegation with a re-resolved, separately
 * compiled grant — never widening the paused one — so the guidance names the
 * requested paths and the concrete combined path set to pass back to
 * orca_delegate, which re-runs resolution.
 */
function scopeExpansionGuidance(outcome: DelegationOutcome): string[] {
  const requested = outcome.checkpoint.scopeRequest ?? [];
  if (requested.length === 0) {
    return [
      "The agent reported needs_scope without concrete paths. Get the specific paths it needs, then " +
        "call orca_delegate again; Orca re-resolves ownership and issues a fresh, separately-scoped " +
        "delegation. The paused grant is never widened (ADR 0008).",
    ];
  }
  const combined = [...new Set([...outcome.targets, ...requested])].sort();
  return [
    `Scope requested (outside the '${outcome.owner}' grant): ${requested.join(", ")}`,
    "To continue, call orca_delegate again with the combined target paths so Orca RE-RESOLVES ownership " +
      "and compiles a FRESH grant for a fresh session; the original grant is never broadened (ADR 0008).",
    `Suggested combined paths: ${combined.join(", ")}`,
  ];
}

/**
 * The status-specific body for one delegated outcome, shared by the single-owner
 * result and each per-owner block of a sequence. Each of the four terminal
 * statuses reads distinctly and actionably: `needs_scope` shows the scope request
 * and the re-delegation recipe; `blocked`/`failed` lead with the summary and any
 * remaining risks alongside the manifest of whatever was already changed.
 */
function checkpointBody(outcome: DelegationOutcome): string[] {
  const cp = outcome.checkpoint;
  const synth = cp.synthesized
    ? " (synthesized — the session ended without calling orca_checkpoint)"
    : "";
  const headline: Record<CheckpointStatus, string> = {
    completed: `Status: completed${synth} — the assignment finished within the grant.`,
    needs_scope: `Status: needs_scope${synth} — the agent needs paths outside its grant to finish.`,
    blocked: `Status: blocked${synth} — the agent could not proceed.`,
    failed: `Status: failed${synth}.`,
  };
  const lines = [headline[cp.status], `Summary: ${cp.summary}`, manifestLine(cp.changedPaths)];
  if (cp.status === "needs_scope") lines.push(...scopeExpansionGuidance(outcome));
  if (cp.remainingRisks && cp.remainingRisks.length > 0) {
    lines.push("Remaining risks:");
    for (const risk of cp.remainingRisks) lines.push(`  - ${risk}`);
  }
  if (outcome.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of outcome.warnings) lines.push(`  - ${warning.path}: ${warning.reason}`);
  }
  return lines;
}

/** Single-owner (no unowned paths) result — the simplest, most common case. */
function delegationResult(
  outcome: DelegationOutcome,
  record: PersistedDelegationRecord,
): AgentToolResult<ResolveToolDetails> {
  const body = [`Orca delegation to '${outcome.owner}' ended.`, ...checkpointBody(outcome)].join("\n");
  return text(body, { kind: "delegation", outcome, record });
}

/** Single-owner pre-spawn build failure (required source missing / oversized). */
function delegationFailedResult(
  failureKind: DelegationFailureKind,
  diagnostics: string[],
  warnings: { path: string; reason: string }[],
): AgentToolResult<ResolveToolDetails> {
  const lines = [
    `Orca delegation was blocked before spawning a session (${failureKind}):`,
    ...diagnostics.map((diagnostic) => `  - ${diagnostic}`),
  ];
  if (warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of warnings) lines.push(`  - ${warning.path}: ${warning.reason}`);
  }
  return text(lines.join("\n"), { kind: "delegation_failed", failureKind, diagnostics });
}

/** Enforce-mode unowned targets: fail the whole delegation pre-spawn (ADR 0012). */
function unownedBlockedResult(resolution: Resolution): AgentToolResult<ResolveToolDetails> {
  const owned = resolution.delegations.map((delegation) => delegation.owner);
  const lines = [
    "Orca delegation was blocked before spawning any session (enforce mode): the target set includes " +
      `path(s) that no domain agent owns: ${resolution.unownedPaths.join(", ")}.`,
    "Unowned writes fail closed in enforce mode (ADR 0012). Add an ownership scope to .orca/orca.yaml " +
      "for these paths, or drop them from the delegation, then retry.",
  ];
  if (owned.length > 0) {
    lines.push(
      `The owned portion (${owned.join(", ")}) was NOT delegated either — the whole call is rejected so ` +
        "no partial plan runs behind an unresolved ownership gap.",
    );
  }
  return text(lines.join("\n"), {
    kind: "unowned_blocked",
    unownedPaths: resolution.unownedPaths,
    resolution,
  });
}

/** Advisory-mode call whose targets are all unowned: nothing to delegate (ADR 0012). */
function allUnmanagedResult(resolution: Resolution): AgentToolResult<ResolveToolDetails> {
  const body = [
    "Orca did not delegate: no target routes to a domain agent, so there is no owned work to run.",
    `Unmanaged targets (advisory): ${resolution.unownedPaths.join(", ")}.`,
    "In advisory mode these are your responsibility under existing authority; they were recorded as an " +
      "advisory policy violation and NOT delegated (ADR 0012). Add ownership scopes to route them.",
  ].join("\n");
  return text(body, { kind: "all_unmanaged", unownedPaths: resolution.unownedPaths });
}

/**
 * The aggregate result for a multi-owner sequence (and any owned+unowned advisory
 * mix). Reports the per-owner status, the completed/not-run split, the early-stop
 * reason, and — when a step needs scope — the re-delegation recipe. Unowned paths
 * are called out as unmanaged advisory work at the end.
 */
function delegationSequenceResult(
  sequence: SequenceOutcome,
  unmanaged: string[],
  mode: OperatingMode,
  record: PersistedDelegationRecord,
): AgentToolResult<ResolveToolDetails> {
  const total = sequence.steps.length;
  const completed = sequence.steps.filter(stepCompleted).length;
  const notRun = sequence.steps.filter((step) => step.kind === "not_run").length;

  const lines: string[] = [
    `Orca delegation sequence: ${total} owner(s) resolved, executed sequentially in owner-id order.`,
  ];
  if (sequence.allCompleted) {
    lines.push(`Outcome: all ${total} owner(s) completed.`);
  } else if (sequence.cancelled) {
    lines.push(
      `Outcome: cancelled — ${completed} completed, ${notRun} not run` +
        (sequence.stoppedAt ? ` (stopped at '${sequence.stoppedAt}').` : "."),
    );
  } else {
    lines.push(
      `Outcome: stopped at '${sequence.stoppedAt}' — ${completed} completed, ${notRun} not run. ` +
        "Later owners were not started: the plan stops on the first non-completed status because " +
        "in-place editing has no transactional rollback (ADR 0009/0077).",
    );
  }

  let index = 0;
  for (const step of sequence.steps) {
    index += 1;
    if (step.kind === "delegated") {
      lines.push("", `${index}. ${step.outcome.owner}:`);
      for (const line of checkpointBody(step.outcome)) lines.push(`   ${line}`);
    } else if (step.kind === "build_failed") {
      lines.push("", `${index}. ${step.owner}: build failed (${step.failureKind}) — not spawned.`);
      for (const diagnostic of step.diagnostics) lines.push(`   - ${diagnostic}`);
    } else {
      const why =
        step.reason === "cancelled"
          ? "not run — parent cancellation"
          : "not run — the sequence stopped before this owner";
      lines.push("", `${index}. ${step.owner}: ${why} (re-delegate once the earlier outcome is resolved).`);
    }
  }

  if (unmanaged.length > 0) {
    lines.push(
      "",
      `Unmanaged targets (advisory): ${unmanaged.join(", ")}.`,
      "No agent owns these; Orca did not delegate them. In advisory mode they proceed only under your " +
        "existing authority and were recorded as an advisory policy violation (ADR 0012).",
    );
  }

  return text(lines.join("\n"), { kind: "delegation_sequence", sequence, unmanaged, mode, record });
}

/**
 * The human-facing TUI lines for a delegate result (`renderResult`). For a
 * completed sequence it renders the persisted record (owner statuses, observed
 * manifests, per-owner capability summary, bash-activity, and usage) so the human
 * sees the honesty surface the LLM-facing text omits; for every other result it
 * falls back to the tool's own text content. Pure — the TUI wrapping happens in
 * `tui.ts`.
 */
export function delegateResultLines(result: AgentToolResult<ResolveToolDetails>): string[] {
  const details = result.details;
  if (details && (details.kind === "delegation" || details.kind === "delegation_sequence")) {
    return renderRecordLines(details.record);
  }
  return result.content.flatMap((block) => (block.type === "text" ? block.text.split("\n") : []));
}

/**
 * `orca_delegate` — the full delegation lifecycle (Phase 7). It resolves the
 * target paths to their structural owners and:
 *
 * - splits a multi-owner task into one delegation per owner and runs them
 *   SEQUENTIALLY in the resolver's owner-id order, each under its own frozen
 *   grant, stopping the sequence on the first owner that does not `complete`
 *   (ADR 0006, 0009, 0077 — in-place editing has no rollback);
 * - handles unowned targets by mode (ADR 0012): enforce fails the whole
 *   delegation pre-spawn with the unowned paths named; advisory proceeds with the
 *   owned subset and marks the unowned paths as unmanaged advisory work;
 * - surfaces each of the four terminal checkpoint statuses distinctly, with the
 *   scope-expansion recipe for `needs_scope` (re-delegate with the combined paths
 *   so a FRESH grant is compiled; the paused grant is never widened, ADR 0008);
 * - propagates parent cancellation to the in-flight session and leaves queued
 *   owners unrun (ADR 0083).
 *
 * Assignment is always structural — the tool takes task + target paths, never an
 * agent id (ADR 0081). Only the steward has this tool; delegated sessions get
 * orca_checkpoint instead.
 */
export function createDelegateTool(
  deps: DelegateDeps,
): ToolDefinition<typeof delegateParamsSchema, ResolveToolDetails> {
  return defineTool({
    name: "orca_delegate",
    label: "Orca delegate",
    description:
      "Delegate writable work to the structurally determined owner(s) of the given target paths. Pass " +
      "the task plus concrete repository-relative paths (never an agent id); Orca resolves ownership " +
      "and runs the work as scoped in-process session(s) whose read/write/edit tools enforce each " +
      "agent's grant, ending in a structured checkpoint with an observed changed-path manifest. " +
      "Multi-owner tasks run as sequential per-owner delegations; unowned targets fail the delegation " +
      "in enforce mode and are reported as unmanaged work in advisory mode.",
    promptSnippet:
      "orca_delegate — route writable work to its owner(s) by target paths and run under each grant.",
    parameters: delegateParamsSchema,
    renderResult: (result) => linesComponent(delegateResultLines(result)),
    async execute(
      _toolCallId: string,
      params: DelegateToolInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ResolveToolDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<ResolveToolDetails>> {
      const state = deps.getState(ctx.cwd);
      const outcome = computeOutcome(state, params.paths, ctx.cwd);
      switch (outcome.kind) {
        case "empty":
          return emptyResult();
        case "inactive":
          return inactiveResult(outcome.state);
        case "invalid":
          return invalidResult(outcome.rejections);
        case "resolution": {
          const { resolution } = outcome;
          deps.onRoute?.(resolution);
          const active = state as ActiveState;
          const mode = active.effectiveMode;

          // Unowned targets (ADR 0012). Enforce fails the whole delegation before
          // spawning anything; advisory proceeds with the owned subset and marks
          // the rest unmanaged. Either way the event is recorded.
          if (resolution.unownedPaths.length > 0 && mode === "enforce") {
            deps.onUnowned?.(resolution.unownedPaths, mode, "blocked");
            return unownedBlockedResult(resolution);
          }
          const unmanaged = resolution.unownedPaths;
          if (unmanaged.length > 0) deps.onUnowned?.(unmanaged, mode, "flagged");

          if (resolution.delegations.length === 0) {
            // Advisory only (enforce already returned): nothing routes to an owner.
            return allUnmanagedResult(resolution);
          }

          // One delegation per owner in the resolver's owner-id order, each with
          // its own compiled (frozen) grant; run them sequentially (ADR 0006, 0077).
          const parent = { model: ctx.model, thinkingLevel: deps.getThinkingLevel() };
          const ordered: DelegationInputs[] = resolution.delegations.map((delegation) => ({
            document: active.document,
            owner: delegation.owner,
            targets: delegation.targets,
            grant: delegation.grant,
            grantId: digestGrants([delegation.grant]),
            task: params.task,
            effectiveMode: mode,
            cwd: ctx.cwd,
            parent,
          }));

          // Stream live progress into the tool's onUpdate (TUI) and hand each
          // event to the extension (widget + notify) with the tool's own ctx.
          const onProgress = (progress: DelegationProgress): void => {
            onUpdate?.({
              content: [{ type: "text", text: progressLine(progress) }],
              details: { kind: "progress", progress },
            });
            deps.onProgress?.(progress, ctx);
          };

          const startedAt = Date.now();
          const sequence = await runDelegationSequence(ordered, {
            createSession: deps.createSession,
            signal,
            onProgress,
          });
          const endedAt = Date.now();
          for (const step of sequence.steps) {
            if (step.kind === "delegated") deps.onDelegation?.(step.outcome.appendEntry);
          }

          // Persist the whole sequence as one durable session entry (PRD "User
          // Surface"): owners, task, targets, grant digest, per-step statuses,
          // observed manifests, usage, and timestamps.
          const record = buildDelegationRecord({
            task: params.task,
            targets: resolution.perTarget.map((target) => target.path),
            grantDigest: digestGrants(resolution.delegations.map((delegation) => delegation.grant)),
            sequence,
            startedAt,
            endedAt,
          });
          deps.onDelegationRecord?.(record);

          // A single owner with no unowned paths keeps the direct single-owner
          // result shape; everything else renders as an aggregate sequence.
          if (unmanaged.length === 0 && ordered.length === 1) {
            const step = sequence.steps[0];
            if (step.kind === "delegated") return delegationResult(step.outcome, record);
            if (step.kind === "build_failed") {
              return delegationFailedResult(step.failureKind, step.diagnostics, step.warnings);
            }
            // not_run (cancelled before start) falls through to the aggregate render.
          }
          return delegationSequenceResult(sequence, unmanaged, mode, record);
        }
      }
    },
  });
}

export { summarizeResolution };
