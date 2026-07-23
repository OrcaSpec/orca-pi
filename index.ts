import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  detectRepositoryState,
  formatStatusLines,
  shortStatus,
  statusLevel,
  type RepositoryState,
} from "./src/state";
import { DEFAULT_MODE, isOperatingMode, type OperatingMode } from "./src/mode";

/**
 * Orca for pi — Phase 3: spec loading, validation, and repository states.
 *
 * On session start (all reasons, including `/reload`) and on demand via `/orca`,
 * the extension inspects `ctx.cwd` and lands in exactly one repository state:
 * `unmanaged` (no `.orca/orca.yaml`; pi behaves as unmanaged pi, no tool
 * interception), `active` (valid spec; governance state computed with an
 * effective mode), or the blocked states `invalid_spec` /
 * `unsupported_spec_version` (present but unusable spec; actionable diagnostics,
 * identical in both modes — ADR 0028).
 *
 * User-requested mode surface: `/orca mode advisory|enforce` records a
 * requested operating mode that persists for the life of this extension
 * instance (in-memory session state). The effective mode is recomputed
 * immediately as the stricter of the repository minimum and the requested mode
 * (ADR 0063). This state is deliberately NOT persisted across `/reload`: a
 * reload constructs a fresh extension instance and the requested mode resets to
 * advisory. Session-entry persistence (appendEntry) is deferred to the delegation
 * work in later phases; the smallest reasonable Phase 3 surface is in-memory.
 *
 * No governance, routing, or tool interception is registered yet — those arrive
 * with the resolver (Phase 4) and steward governance (Phase 5).
 */
export default function orcaPi(pi: ExtensionAPI): void {
  // In-memory, session-scoped requested operating mode (see the note above).
  let requestedMode: OperatingMode = DEFAULT_MODE;

  const currentState = (ctx: ExtensionContext | ExtensionCommandContext): RepositoryState =>
    detectRepositoryState(ctx.cwd, requestedMode);

  /** Surface a state through the UI when present, else as headless plain text. */
  const present = (state: RepositoryState, ctx: ExtensionContext): void => {
    const lines = formatStatusLines(state);
    if (ctx.hasUI) {
      ctx.ui.setStatus("orca", shortStatus(state));
      ctx.ui.setWidget("orca", lines);
      ctx.ui.notify(lines.join("\n"), statusLevel(state));
      return;
    }
    // Headless: emit plain text on stdout, except in structured protocol modes
    // (json/rpc) where stdout carries the protocol and must not be polluted.
    if (ctx.mode !== "json" && ctx.mode !== "rpc") {
      console.log(lines.join("\n"));
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Passive detection for every start reason (startup, reload, new, resume,
    // fork). No tool_call handler is registered, so no interception can occur
    // regardless of the detected state. Publish only the compact status here.
    const state = currentState(ctx);
    if (ctx.hasUI) ctx.ui.setStatus("orca", shortStatus(state));
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
}
