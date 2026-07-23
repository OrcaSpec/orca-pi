import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  isToolCallEventType,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  detectRepositoryState,
  formatStatusLines,
  shortStatus,
  statusLevel,
  type RepositoryState,
} from "./src/state";
import { DEFAULT_MODE, isOperatingMode, type OperatingMode } from "./src/mode";
import { normalizeTarget } from "./src/paths";
import {
  createDelegateTool,
  createExplainTool,
  createResolveTool,
  summarizeResolution,
} from "./src/tools";
import { RouteLog } from "./src/routelog";
import { ViolationLog } from "./src/violations";
import {
  classifyDiscovery,
  classifyWrite,
  type DiscoveryTarget,
  type GovernanceDecision,
  type GovernedReadTool,
  type GovernedTool,
  type GovernedWriteTool,
} from "./src/governance";
import { composeStewardPrompt } from "./src/steward";
import type {
  DelegationProgress,
  DelegationSession,
  DelegationSessionConfig,
} from "./src/delegation";
import { createRealSessionFactory } from "./src/session-runner";
import { formatEnforcementSummary } from "./src/enforcement";
import {
  DELEGATION_ENTRY_TYPE,
  DelegationHistory,
  renderRecordLines,
  type PersistedDelegationRecord,
} from "./src/delegation-entry";
import {
  inflightFromProgress,
  progressLine,
  statusWidgetLines,
  Surface,
  type InflightDelegation,
} from "./src/surface";
import { linesComponent } from "./src/tui";

/**
 * Orca for pi — steward governance of the parent session (ADR 0080), plus the
 * full delegation lifecycle behind `orca_delegate` (Phases 6–7).
 *
 * Phases 2–4 established the four repository states and the pure resolver behind
 * `orca_resolve` / `orca_explain`. This module governs the parent session as the
 * repository steward while — and only while — the repository is `active`:
 *
 * - **Write governance** (`tool_call` on `write`/`edit`): the steward has no
 *   implicit write authority, so a write into an owned scope is blocked (enforce)
 *   or flagged (advisory) with an explanation naming the owner and directing
 *   `orca_delegate`; unowned writes fail closed in enforce and are advisory
 *   policy violations otherwise (ADR 0012); writes outside the repository cross
 *   the stewardship boundary (ADR 0015). See `governance.ts`.
 * - **Discovery governance** (`tool_call` on `read`/`grep`/`find`/`ls`): reads are
 *   scoped to `steward.discovery.read` minus protected denies; the real
 *   (symlink-resolved) target is scope-checked, and symlink traversal is
 *   rejected per ADR 0032.
 * - **Advisory flagging**: a flagged call proceeds; the explanation reaches the
 *   human via `notify` + a violation record, and the model via a `tool_result`
 *   note keyed by `toolCallId`.
 * - **Steward identity**: `before_agent_start` appends a root-first trusted
 *   system-prompt block (`steward.ts`) — role, mode, discovery scope, delegation
 *   directive, four-state context — appended to pi's own prompt, never replacing it.
 * - **Tool surface**: the steward gains `orca_delegate` (full lifecycle — statuses,
 *   scope expansion, multi-owner splits, unowned handling, cancellation). The
 *   parent session never receives `orca_checkpoint`.
 *
 * Governance activates ONLY in the `active` state; unmanaged and blocked
 * repositories see zero interception (every handler returns early), preserving
 * normal pi behavior. Handlers are registered once in the factory body, so the
 * `/reload` flow (which rebuilds a fresh extension instance) cannot accumulate
 * duplicate handlers or double-govern a call.
 */
/**
 * Test/embedding seam. Production wires the real in-process session factory
 * (which needs a live model); the offline suite injects a scripted
 * `createSession` so the full extension — governance, delegation, persistence,
 * and the live surfaces — can be exercised end-to-end without a model.
 */
export interface OrcaOverrides {
  createSession?: (config: DelegationSessionConfig) => Promise<DelegationSession>;
}

export default function orcaPi(pi: ExtensionAPI): void {
  installOrca(pi);
}

export function installOrca(pi: ExtensionAPI, overrides: OrcaOverrides = {}): void {
  // In-memory, session-scoped requested operating mode (reset on /reload).
  //
  // Phase 8 decision — requested mode is NOT persisted as a session entry. The
  // durable floor on the effective mode is `repository.minimum_mode`, which lives
  // in the spec file and is re-read on every session_start, so a resumed/forked
  // session is never weaker than the repository demands. A voluntary elevation
  // above that floor is a per-session choice; persisting it would silently keep
  // `enforce` active in a new session the user did not ask to elevate. Keeping it
  // ephemeral is the smaller, safer default (only the spec-derived minimum, which
  // is already durable, survives). Delegation records DO persist (see below).
  let requestedMode: OperatingMode = DEFAULT_MODE;

  // Session-scoped memory surfaced under /orca; both reset on /reload.
  const routeLog = new RouteLog();
  const violations = new ViolationLog();

  // Durable delegation history (PRD "User Surface"): rebuilt on every
  // session_start from session entries ALONE, appended to live as delegations
  // complete. A resumed/forked session recovers its history from entries only.
  const history = new DelegationHistory();

  // The in-flight delegation for the live status widget; undefined when idle.
  let inflight: InflightDelegation | undefined;

  // Advisory flags awaiting their tool_result, keyed by toolCallId. A flagged
  // (not blocked) call proceeds; when its result arrives we append the
  // explanation so the model sees the same note the human was notified of.
  const pendingFlags = new Map<string, string>();

  // The parent session's thinking level, tracked so delegations run on the
  // parent model + thinking level (ADR 0076). The model itself is read from the
  // tool ctx at delegation time; there is no per-agent model configuration.
  let parentThinkingLevel: ThinkingLevel = "medium";

  // The delegated-session factory is built lazily on first delegation so a
  // pass-through (unmanaged) session never constructs a ModelRuntime. Cached for
  // the life of the extension instance (rebuilt fresh on /reload).
  let sessionFactory: ((config: DelegationSessionConfig) => Promise<DelegationSession>) | undefined;
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    if (overrides.createSession) return overrides.createSession(config);
    if (!sessionFactory) {
      sessionFactory = createRealSessionFactory(await ModelRuntime.create());
    }
    return sessionFactory(config);
  };

  const currentState = (ctx: ExtensionContext | ExtensionCommandContext): RepositoryState =>
    detectRepositoryState(ctx.cwd, requestedMode);

  const toolDeps = {
    getState: (cwd: string): RepositoryState => detectRepositoryState(cwd, requestedMode),
    onRoute: (resolution: Parameters<typeof summarizeResolution>[0]): void =>
      routeLog.record(summarizeResolution(resolution)),
  };

  /**
   * The full `/orca` status surface (PRD "Commands and status"): state,
   * effective mode + inputs, digest, agents, then — only under active governance
   * — the dimensioned enforcement summary with the bash disclosure. Last route
   * decisions, governance events, and the durable delegation history follow.
   * Blocked and unmanaged states show their diagnostics WITHOUT an enforcement
   * claim, since no constructive enforcement is active to describe.
   */
  const composeStatusLines = (state: RepositoryState): string[] => {
    const lines = [...formatStatusLines(state)];
    if (state.kind === "active") lines.push("", ...formatEnforcementSummary());
    const sections = [
      routeLog.statusLines(),
      violations.statusLines(),
      history.statusLines(),
      history.lastDetailLines(),
    ];
    for (const section of sections) if (section.length > 0) lines.push("", ...section);
    return lines;
  };

  /** Surface the full `/orca` status through the one UI seam (no-op headless UI). */
  const present = (state: RepositoryState, ctx: ExtensionContext): void => {
    const lines = composeStatusLines(state);
    const surface = new Surface(ctx);
    surface.status(shortStatus(state));
    surface.widget(lines);
    surface.notify(lines.join("\n"), statusLevel(state));
  };

  /** Notify the human of a governance event (warning severity) via the seam. */
  const notifyHuman = (ctx: ExtensionContext, message: string): void => {
    new Surface(ctx).notify(message, "warning");
  };

  /** A raw discovery/write target for display: the path, or `(cwd)` when absent. */
  const displayOf = (raw: string | undefined): string =>
    raw === undefined || raw.trim() === "" ? "(cwd)" : raw;

  /**
   * Reduce a raw discovery path to a scope-checkable {@link DiscoveryTarget}:
   * resolve the real (symlink-followed) target against the canonical repository
   * root and report whether a symlink was traversed. A missing path denotes the
   * repository root; a resolved target outside the root becomes `path: null`
   * (out of the read surface). The real path — not the logical one — is what the
   * scope check sees, so a symlink whose target escapes scope cannot slip through
   * (ADR 0032).
   */
  const resolveDiscoveryTarget = (raw: string | undefined, repoRoot: string): DiscoveryTarget => {
    if (raw === undefined || raw.trim() === "") return { path: "", symlink: false };

    let realRoot: string;
    try {
      realRoot = realpathSync(repoRoot);
    } catch {
      realRoot = repoRoot;
    }

    const logical = resolvePath(realRoot, raw);
    let real = logical;
    try {
      real = realpathSync(logical);
    } catch {
      // Missing leaf: no symlink resolution possible; scope-check the logical path.
    }
    const symlink = real !== logical;

    const rel = relative(realRoot, real);
    const escaped = rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
    return { path: escaped ? null : rel.split(sep).join("/"), symlink };
  };

  /**
   * Apply a governance decision: allow passes through; block returns the block
   * result to pi; flag records the violation, notifies the human, and queues the
   * model-visible note for `tool_result`. Every non-allow verdict is recorded.
   */
  const applyDecision = (
    ctx: ExtensionContext,
    toolCallId: string,
    tool: GovernedTool,
    displayPath: string,
    mode: OperatingMode,
    decision: GovernanceDecision,
  ): ToolCallEventResult | undefined => {
    if (decision.verdict === "allow") return undefined;

    violations.record({
      verdict: decision.verdict === "block" ? "blocked" : "flagged",
      tool,
      path: displayPath,
      owner: decision.owner,
      mode,
      reason: decision.reason,
      timestamp: Date.now(),
    });

    if (decision.verdict === "block") {
      notifyHuman(ctx, `Orca blocked ${tool} on ${displayPath}\n${decision.reason}`);
      return { block: true, reason: decision.reason };
    }

    notifyHuman(
      ctx,
      `Orca flagged ${tool} on ${displayPath} (advisory — proceeding)\n${decision.reason}`,
    );
    pendingFlags.set(toolCallId, decision.reason);
    return undefined;
  };

  // Track the parent session's thinking level so delegations inherit it (ADR 0076).
  pi.on("thinking_level_select", async (event) => {
    parentThinkingLevel = event.level;
  });

  pi.on("session_start", async (_event, ctx) => {
    // Rebuild the durable delegation history from session entries ALONE, for
    // EVERY start reason (startup / reload / new / resume / fork). A resumed or
    // forked session therefore recovers its prior delegation history with no
    // other store (PRD "User Surface"). The in-flight marker resets with the
    // fresh runtime.
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    history.rebuildFrom(branch);
    inflight = undefined;

    // Passive detection for every start reason; the governance handlers below
    // activate independently and only when active.
    const state = currentState(ctx);
    const surface = new Surface(ctx);
    surface.status(shortStatus(state));
    surface.widget(
      statusWidgetLines({
        state,
        violationCount: violations.recent().length,
        historyCount: history.count(),
        inflight,
      }),
    );
    // Announce activation / blocked state (not routine unmanaged startups) so a
    // mode or governance change on session_start & /reload is visible.
    if (state.kind !== "unmanaged") {
      const message =
        state.kind === "active"
          ? `Orca governance active — effective mode ${state.effectiveMode}.`
          : `Orca ${state.kind}: governance blocked; see /orca for diagnostics.`;
      surface.notify(message, statusLevel(state));
    }
  });

  // Steward governance. Runs on every parent tool call but returns immediately
  // unless the repository is under active governance — unmanaged and blocked
  // states get zero interception, preserving normal pi behavior.
  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    const state = detectRepositoryState(ctx.cwd, requestedMode);
    if (state.kind !== "active") return undefined;
    const { document, effectiveMode } = state;

    let write: { tool: GovernedWriteTool; raw: string } | undefined;
    if (isToolCallEventType("write", event)) write = { tool: "write", raw: event.input.path };
    else if (isToolCallEventType("edit", event)) write = { tool: "edit", raw: event.input.path };
    if (write) {
      const norm = normalizeTarget(write.raw, ctx.cwd);
      const decision = classifyWrite(document, effectiveMode, norm.ok ? norm.path : null);
      return applyDecision(
        ctx,
        event.toolCallId,
        write.tool,
        displayOf(write.raw),
        effectiveMode,
        decision,
      );
    }

    let read: { tool: GovernedReadTool; raw: string | undefined } | undefined;
    if (isToolCallEventType("read", event)) read = { tool: "read", raw: event.input.path };
    else if (isToolCallEventType("grep", event)) read = { tool: "grep", raw: event.input.path };
    else if (isToolCallEventType("find", event)) read = { tool: "find", raw: event.input.path };
    else if (isToolCallEventType("ls", event)) read = { tool: "ls", raw: event.input.path };
    if (read) {
      const target = resolveDiscoveryTarget(read.raw, ctx.cwd);
      const decision = classifyDiscovery(document, effectiveMode, target);
      return applyDecision(
        ctx,
        event.toolCallId,
        read.tool,
        displayOf(read.raw),
        effectiveMode,
        decision,
      );
    }

    return undefined;
  });

  // Advisory flagging, model side: append the queued explanation to the result
  // of a call we let proceed. Keyed by toolCallId, consumed once.
  pi.on("tool_result", async (event, _ctx) => {
    const note = pendingFlags.get(event.toolCallId);
    if (note === undefined) return undefined;
    pendingFlags.delete(event.toolCallId);
    return {
      content: [...event.content, { type: "text" as const, text: `\n[orca advisory] ${note}` }],
    };
  });

  // Steward identity: append the root-first trusted governance block to pi's
  // system prompt, only while active. Absent in unmanaged and blocked states.
  pi.on("before_agent_start", async (event, ctx) => {
    const state = detectRepositoryState(ctx.cwd, requestedMode);
    if (state.kind !== "active") return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${composeStewardPrompt(state)}` };
  });

  pi.registerCommand("orca", {
    description:
      "Show Orca governance status, or set the requested mode: /orca mode advisory|enforce",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "mode") {
        const requested = rest[0];
        if (!isOperatingMode(requested)) {
          const message =
            "Usage: /orca mode advisory|enforce — sets the requested operating mode for this session.";
          if (ctx.hasUI) ctx.ui.notify(message, "warning");
          else if (ctx.mode !== "json" && ctx.mode !== "rpc") {
            console.log(message);
          }
          return;
        }
        requestedMode = requested;
        // Recompute and present the state immediately so the effective mode
        // reflects the new request (bounded by the repository minimum).
        present(currentState(ctx), ctx);
        return;
      }

      present(currentState(ctx), ctx);
    },
  });

  // Steward tool surface: routing preview + explanation (Phase 4) plus the
  // Phase 5 orca_delegate stub. Registered unconditionally; each checks the
  // current state at call time. orca_checkpoint is NOT registered in the parent
  // session — it terminates a delegated session, not the steward (ADR 0083).
  // Render persisted delegation entries readably in the transcript. Entries are
  // TUI-only (they do NOT enter LLM context); on a resumed session these are the
  // sole record of prior delegations. The renderer is pure over `entry.data`.
  pi.registerEntryRenderer<PersistedDelegationRecord>(DELEGATION_ENTRY_TYPE, (entry) => {
    const record = entry.data;
    return record ? linesComponent(renderRecordLines(record)) : undefined;
  });

  pi.registerTool(createResolveTool(toolDeps));
  pi.registerTool(createExplainTool(toolDeps));
  pi.registerTool(
    createDelegateTool({
      ...toolDeps,
      getThinkingLevel: () => parentThinkingLevel,
      createSession,
      onDelegation: (entry) =>
        routeLog.record(
          `delegated ${entry.owner}: ${entry.status}, ${entry.changedPaths.length} changed path(s)`,
        ),
      // Persist each completed sequence as a session entry and add it to the
      // durable history (one entry per sequence). appendEntry does NOT enter LLM
      // context; the history rebuild on session_start reads exactly these back.
      onDelegationRecord: (record) => {
        pi.appendEntry(DELEGATION_ENTRY_TYPE, record);
        history.add(record);
      },
      // Live progress → status widget (owner + step k/N + status) and human
      // notifications on sequence start, per-owner checkpoint outcomes, and end.
      onProgress: (progress: DelegationProgress, progressCtx: ExtensionContext) => {
        inflight = inflightFromProgress(inflight, progress);
        const surface = new Surface(progressCtx);
        surface.widget(
          statusWidgetLines({
            state: currentState(progressCtx),
            violationCount: violations.recent().length,
            historyCount: history.count(),
            inflight,
          }),
        );
        if (
          progress.kind === "sequence_start" ||
          progress.kind === "step_end" ||
          progress.kind === "sequence_end"
        ) {
          surface.notify(progressLine(progress), "info");
        }
      },
      // Unowned-target delegation events (ADR 0012): blocked in enforce, flagged
      // in advisory. Recorded so /orca shows the lifecycle event (Phase 8 polishes UX).
      onUnowned: (paths, mode, verdict) => {
        const display = paths.join(", ");
        violations.record({
          verdict,
          tool: "orca_delegate",
          path: display,
          owner: null,
          mode,
          reason:
            verdict === "blocked"
              ? `Delegation blocked: no domain agent owns ${display}. Unowned writes fail closed in enforce mode (ADR 0012).`
              : `Delegation proceeded without ${display}: no domain agent owns these paths — advisory unmanaged work (ADR 0012).`,
          timestamp: Date.now(),
        });
        routeLog.record(`unowned ${verdict} (${mode}): ${display}`);
      },
    }),
  );
}
