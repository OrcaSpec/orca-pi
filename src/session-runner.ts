import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type EventBus,
  type InlineExtension,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { emptyUsage, type DelegationSession, type DelegationSessionConfig, type DelegationUsage } from "./delegation";

const CHILD_OBSERVER_BRIDGE_REQUEST_CHANNEL =
  "orca-eval:child-observer-bridge-request:v1";

interface ChildObserverHandle {
  extension: InlineExtension;
  start(): void;
  setOutcome(evidence: {
    status: "completed" | "error" | "cancelled";
    checkpointStatus: string;
    changedPaths: string[];
    validationStatus: string;
    mutationViolations: unknown[];
  }): void;
  finish(): void;
}

export interface ChildObserverBridge {
  prepareDelegation(input: {
    grantId: string;
    targetPaths: string[];
    resolvedOwners: string[];
    sequenceId?: string;
    stepId?: string;
    delegationId?: string;
    childSessionId?: string;
  }): ChildObserverHandle;
}

export function requestChildObserverBridge(
  events: EventBus,
): ChildObserverBridge | undefined {
  const request: {
    schema_version: "1.0";
    kind: "child_observer_bridge_request";
    bridge?: ChildObserverBridge;
  } = {
    schema_version: "1.0",
    kind: "child_observer_bridge_request",
  };
  events.emit(CHILD_OBSERVER_BRIDGE_REQUEST_CHANNEL, request);
  return request.bridge;
}

export function prepareChildObserver(
  config: DelegationSessionConfig,
  bridge?: ChildObserverBridge,
): ChildObserverHandle | undefined {
  if (!bridge) return undefined;
  if (!config.grantId) {
    throw new Error("Observed delegated sessions require a stable grant ID");
  }
  return bridge.prepareDelegation({
    grantId: config.grantId,
    targetPaths: config.targets,
    resolvedOwners: [config.owner],
    ...(config.sequenceId ? { sequenceId: config.sequenceId } : {}),
    ...(config.stepId ? { stepId: config.stepId } : {}),
    ...(config.delegationId ? { delegationId: config.delegationId } : {}),
    ...(config.childSessionId ? { childSessionId: config.childSessionId } : {}),
  });
}

/**
 * Fold one pi-ai {@link Usage} block into a running delegation total. pi reports
 * usage per assistant message; summing the message-level blocks gives the whole
 * delegation's spend (ADR 0076 — the delegation runs on the parent model).
 */
function addUsage(total: DelegationUsage, usage: Usage): DelegationUsage {
  return {
    inputTokens: total.inputTokens + (usage.input ?? 0),
    outputTokens: total.outputTokens + (usage.output ?? 0),
    totalTokens: total.totalTokens + (usage.totalTokens ?? 0),
    costUsd: total.costUsd + (usage.cost?.total ?? 0),
    available: true,
  };
}

function throwLifecycleErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/**
 * The production `createSession` seam: build a real in-process pi session from a
 * {@link DelegationSessionConfig} (ADR 0078). Separated from `delegation.ts` so
 * the run loop stays testable with a scripted fake and never needs a live model.
 *
 * Two construction choices are load-bearing:
 *
 * - Normal extension discovery is disabled. When the evaluator-owned passive
 *   observer exposes its in-process bridge, that one hidden inline extension is
 *   retained; Orca itself and every unrelated extension remain excluded. This
 *   preserves grant-only child governance while producing correlated evidence.
 * - `noTools: "builtin"` disables pi's default read/bash/edit/write; the session's
 *   tools are exactly the grant-compiled `customTools` (grant-checked
 *   read/write/edit, unmodified bash, and orca_checkpoint). The system prompt and
 *   untrusted context come from the loader overrides; the session is in-memory so
 *   delegations never pollute the session store. `config.cwd` is the delegation's
 *   staging worktree, not the user's checkout (`staging.ts`), so edits land in
 *   staging and reach the user only through the promotion gate.
 *
 * This path requires a live model and is exercised by the flagged live-model
 * smoke test, not the offline conformance suite.
 */
export function createRealSessionFactory(
  modelRuntime: ModelRuntime,
  childObserverBridge?: ChildObserverBridge,
  dependencies: {
    createAgentSession?: typeof createAgentSession;
  } = {},
): (config: DelegationSessionConfig) => Promise<DelegationSession> {
  return async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    const childObserver = prepareChildObserver(config, childObserverBridge);
    const childObserverPath = childObserver
      ? typeof childObserver.extension === "function"
        ? "<inline:1>"
        : `<inline:${childObserver.extension.name}>`
      : undefined;
    const loader = new DefaultResourceLoader({
      cwd: config.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      extensionFactories: childObserver ? [childObserver.extension] : [],
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter(
          (extension) => extension.path === childObserverPath,
        ),
        errors: base.errors.filter(
          (error) => error.path === childObserverPath,
        ),
      }),
      systemPromptOverride: () => config.systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: config.contextFiles }),
    });
    await loader.reload();

    childObserver?.start();
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    try {
      ({ session } = await (
        dependencies.createAgentSession ?? createAgentSession
      )({
        cwd: config.cwd,
        model: config.model,
        thinkingLevel: config.thinkingLevel,
        modelRuntime,
        noTools: "builtin",
        customTools: config.tools,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(config.cwd),
      }));
    } catch (error) {
      const errors: unknown[] = [error];
      try {
        childObserver?.finish();
      } catch (finishError) {
        errors.push(finishError);
      }
      throwLifecycleErrors(
        errors,
        "Child session creation and observer finalization failed",
      );
      throw error;
    }

    // Accumulate usage from the session's own events and forward lightweight
    // activity notes for live TUI progress. pi surfaces usage on assistant
    // `message_end` events; report what is available and stay honest (a session
    // that emits none leaves usage `available: false`).
    let usageTotal = emptyUsage();
    const activityListeners: ((note: string) => void)[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end") {
        const usage = (event.message as { usage?: Usage }).usage;
        if (usage) usageTotal = addUsage(usageTotal, usage);
      } else if (event.type === "tool_execution_start") {
        for (const listener of activityListeners) listener(`running ${event.toolName}`);
      }
    });

    return {
      prompt: async (text: string) => {
        try {
          await session.prompt(text);
        } finally {
          unsubscribe();
        }
      },
      abort: () => session.abort(),
      onActivity: (listener) => {
        activityListeners.push(listener);
      },
      usage: () => usageTotal,
      finish: async (evidence) => {
        const errors: unknown[] = [];
        try {
          childObserver?.setOutcome(evidence);
        } catch (error) {
          errors.push(error);
        }
        try {
          await session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
        } catch (error) {
          errors.push(error);
        }
        try {
          session.dispose();
        } catch (error) {
          errors.push(error);
        }
        try {
          childObserver?.finish();
        } catch (error) {
          errors.push(error);
        }
        throwLifecycleErrors(errors, "Child session finalization failed");
      },
    };
  };
}
