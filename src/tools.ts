import { Type, type Static } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { normalizeTarget } from "./paths";
import { resolve, type Resolution } from "./resolver";
import { renderDelegatePlan, renderExplain, renderResolvePreview, summarizeResolution } from "./render";
import { formatStatusLines, type RepositoryState } from "./state";

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

/** Structured details attached to a tool result for logs / UI. */
export type ResolveToolDetails =
  | { kind: "resolution"; resolution: Resolution }
  | { kind: "inactive"; state: RepositoryState["kind"] }
  | { kind: "invalid"; rejections: { input: string; reason: string }[] }
  | { kind: "empty" };

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

/**
 * `orca_delegate` — Phase 5 STUB. It resolves the target paths to their owners
 * and returns the delegation plan it *would* execute, clearly labeled as a
 * preview. It spawns no session and changes no file; delegation execution lands
 * in Phase 6. Only the steward has this tool, and the parent session never gets
 * `orca_checkpoint` (that terminates a delegated session).
 */
export function createDelegateTool(
  deps: ToolDeps,
): ToolDefinition<typeof delegateParamsSchema, ResolveToolDetails> {
  return defineTool({
    name: "orca_delegate",
    label: "Orca delegate",
    description:
      "Delegate writable work to the structurally determined owner(s) of the given target paths. " +
      "Pass the task plus concrete repository-relative paths (never an agent id); Orca resolves the " +
      "owner and runs the write under that agent's grant. PHASE 5 STUB: returns the delegation plan " +
      "without spawning a session or changing files (execution lands in Phase 6).",
    promptSnippet:
      "orca_delegate — route writable work to its owner by target paths (Phase 5: previews the plan).",
    parameters: delegateParamsSchema,
    async execute(
      _toolCallId: string,
      params: DelegateToolInput,
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
          return text(renderDelegatePlan(params.task, outcome.resolution), {
            kind: "resolution",
            resolution: outcome.resolution,
          });
      }
    },
  });
}

export { summarizeResolution };
