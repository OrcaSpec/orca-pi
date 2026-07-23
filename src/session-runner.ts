import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { DelegationSession, DelegationSessionConfig } from "./delegation";

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

    return {
      prompt: (text: string) => session.prompt(text),
      abort: () => session.abort(),
    };
  };
}
