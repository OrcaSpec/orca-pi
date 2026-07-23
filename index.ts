import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  detectRepositoryState,
  formatStatusLines,
  shortStatus,
  type RepositoryState,
} from "./src/state";

/**
 * Orca for pi — Phase 2 scaffold.
 *
 * Registers the `/orca` status command and reflects repository state on session
 * start. In a repository with no `.orca/orca.yaml` the extension reports
 * `unmanaged` and activates NO governance and NO tool interception: pi behaves
 * exactly as unmanaged pi. Spec loading, validation, steward governance, and
 * the `orca_*` tools land in later phases (see src/state.ts).
 */
export default function orcaPi(pi: ExtensionAPI): void {
  const publishStatus = (state: RepositoryState, ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("orca", shortStatus(state));
  };

  pi.on("session_start", async (_event, ctx) => {
    // Passive detection only. No tool_call handler is registered in Phase 2,
    // so no tool interception can occur regardless of repository state.
    publishStatus(detectRepositoryState(ctx.cwd), ctx);
  });

  pi.registerCommand("orca", {
    description: "Show Orca governance status for the current repository",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const state = detectRepositoryState(ctx.cwd);
      const lines = formatStatusLines(state);
      if (ctx.hasUI) {
        ctx.ui.setStatus("orca", shortStatus(state));
        ctx.ui.setWidget("orca", lines);
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });
}
