import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { emptyUsage, type DelegationSession, type DelegationSessionConfig, type DelegationUsage } from "./delegation";

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

/**
 * The production `createSession` seam: build a real in-process pi session from a
 * {@link DelegationSessionConfig} (ADR 0078). Separated from `delegation.ts` so
 * the run loop stays testable with a scripted fake and never needs a live model.
 *
 * Two construction choices are load-bearing:
 *
 * - `extensionsOverride` returns an empty extension set. Without it,
 *   `DefaultResourceLoader` would rediscover the orca-pi extension itself and run
 *   it inside the child — re-registering `orca_delegate` and re-governing the
 *   session as a steward. A delegated session must carry ONLY its grant-compiled
 *   tools, so no extensions are loaded and no parent governance leaks in.
 * - `noTools: "builtin"` disables pi's default read/bash/edit/write; the session's
 *   tools are exactly the grant-compiled `customTools` (grant-checked
 *   read/write/edit, unmodified bash, and orca_checkpoint). The system prompt and
 *   untrusted context come from the loader overrides; the session is in-memory so
 *   delegations never pollute the session store, and edits land in the working
 *   tree in place (ADR 0077).
 *
 * This path requires a live model and is exercised by the flagged live-model
 * smoke test, not the offline conformance suite.
 */
export function createRealSessionFactory(
  modelRuntime: ModelRuntime,
): (config: DelegationSessionConfig) => Promise<DelegationSession> {
  return async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    const loader = new DefaultResourceLoader({
      cwd: config.cwd,
      agentDir: getAgentDir(),
      extensionsOverride: (base) => ({ ...base, extensions: [], errors: [] }),
      systemPromptOverride: () => config.systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: config.contextFiles }),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: config.cwd,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      modelRuntime,
      noTools: "builtin",
      customTools: config.tools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(config.cwd),
    });

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
    };
  };
}
