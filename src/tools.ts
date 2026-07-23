import { Type, type Static } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { normalizeTarget } from "./paths";
import { resolve, type Resolution } from "./resolver";
import { renderExplain, renderResolvePreview, summarizeResolution } from "./render";
import { formatStatusLines, type ActiveState, type RepositoryState } from "./state";
import {
  runDelegation,
  type DelegationEntry,
  type DelegationInputs,
  type DelegationOutcome,
  type DelegationSession,
  type DelegationSessionConfig,
} from "./delegation";

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
  | { kind: "phase7_pending"; resolution: Resolution }
  | { kind: "delegation"; outcome: DelegationOutcome }
  | { kind: "delegation_failed"; failureKind: DelegationFailureKind; diagnostics: string[] };

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
  /** Record a completed delegation entry (Phase 8 renders/persists it). */
  onDelegation?: (entry: DelegationEntry) => void;
}

/** The Phase-7-pending explanation: single-owner-only executes this phase. */
function phase7PendingResult(resolution: Resolution): AgentToolResult<ResolveToolDetails> {
  const reasons: string[] = [];
  if (resolution.delegations.length !== 1) {
    reasons.push(
      `it resolves to ${resolution.delegations.length} owner(s), and Phase 6 executes only a single-owner ` +
        "delegation (multi-owner tasks split into sequential per-owner delegations in Phase 7)",
    );
  }
  if (resolution.unownedPaths.length > 0) {
    reasons.push(
      `it includes unowned target(s) (${resolution.unownedPaths.join(", ")}), whose enforce/advisory ` +
        "handling lands in Phase 7",
    );
  }
  const body = [
    "Orca delegate did not execute: " + reasons.join("; ") + ".",
    "The resolved routing is shown below for preview; no session was spawned and no file was changed.",
    "",
    renderResolvePreview(resolution),
  ].join("\n");
  return text(body, { kind: "phase7_pending", resolution });
}

function delegationResult(outcome: DelegationOutcome): AgentToolResult<ResolveToolDetails> {
  const cp = outcome.checkpoint;
  const lines = [
    `Orca delegation to '${outcome.owner}' ended: ${cp.status}` +
      (cp.synthesized ? " (synthesized — the session ended without calling orca_checkpoint)" : "") +
      ".",
    `Summary: ${cp.summary}`,
    cp.changedPaths.length > 0
      ? `Observed changed paths (${cp.changedPaths.length}): ${cp.changedPaths.join(", ")}`
      : "Observed changed paths: (none).",
  ];
  if (cp.scopeRequest && cp.scopeRequest.length > 0) {
    lines.push(`Scope requested: ${cp.scopeRequest.join(", ")}`);
  }
  if (outcome.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of outcome.warnings) lines.push(`  - ${warning.path}: ${warning.reason}`);
  }
  return text(lines.join("\n"), { kind: "delegation", outcome });
}

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

/**
 * `orca_delegate` — Phase 6: run one single-owner delegation end-to-end. It
 * resolves the target paths, and when they route to exactly one owner with no
 * unowned paths it assembles a grant-compiled in-process session (parent model +
 * thinking level, injected instructions/context, operator handoff) and runs it
 * to a terminal checkpoint, returning the status, summary, and observed changed
 * paths. Multi-owner splits and unowned-path handling are Phase 7, so those
 * cases return a Phase-7-pending explanation rather than half-executing. Only the
 * steward has this tool; delegated sessions never do (they get orca_checkpoint).
 */
export function createDelegateTool(
  deps: DelegateDeps,
): ToolDefinition<typeof delegateParamsSchema, ResolveToolDetails> {
  return defineTool({
    name: "orca_delegate",
    label: "Orca delegate",
    description:
      "Delegate writable work to the structurally determined owner of the given target paths. Pass " +
      "the task plus concrete repository-relative paths (never an agent id); Orca resolves the owner " +
      "and runs the work as a scoped in-process session whose read/write/edit tools enforce that " +
      "agent's grant, ending in a structured checkpoint with an observed changed-path manifest. " +
      "This phase executes single-owner delegations; multi-owner and unowned-path handling is Phase 7.",
    promptSnippet:
      "orca_delegate — route writable work to its owner by target paths and run it under that grant.",
    parameters: delegateParamsSchema,
    async execute(
      _toolCallId: string,
      params: DelegateToolInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
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

          // Phase 6 executes the single-owner happy path only (ADR 0081; multi-owner
          // split + unowned handling are Phase 7).
          if (resolution.delegations.length !== 1 || resolution.unownedPaths.length > 0) {
            return phase7PendingResult(resolution);
          }

          const active = state as ActiveState;
          const delegation = resolution.delegations[0];
          const inputs: DelegationInputs = {
            document: active.document,
            owner: delegation.owner,
            targets: delegation.targets,
            grant: delegation.grant,
            task: params.task,
            effectiveMode: active.effectiveMode,
            cwd: ctx.cwd,
            parent: { model: ctx.model, thinkingLevel: deps.getThinkingLevel() },
          };

          const result = await runDelegation(inputs, { createSession: deps.createSession, signal });
          if (!result.ok) {
            return delegationFailedResult(result.kind, result.diagnostics, result.warnings);
          }
          deps.onDelegation?.(result.outcome.appendEntry);
          return delegationResult(result.outcome);
        }
      }
    },
  });
}

export { summarizeResolution };
