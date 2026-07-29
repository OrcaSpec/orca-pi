import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import orcaPi, { installOrca } from "../index";
import { DELEGATION_ENTRY_TYPE } from "../src/delegation-entry";
import type { DelegationSession, DelegationSessionConfig } from "../src/delegation";

// A minimal ExtensionAPI double that captures registrations. The extension's
// pi-framework imports are type-only, so index.ts pulls in no pi runtime here.
interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
}

interface Registered {
  events: Map<string, (event: unknown, ctx: unknown) => unknown>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
  tools: Map<string, RegisteredTool>;
  entryRenderers: Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>;
  appended: { customType: string; data: unknown }[];
}

function makeApi(): { pi: unknown; registered: Registered } {
  const registered: Registered = {
    events: new Map(),
    commands: new Map(),
    tools: new Map(),
    entryRenderers: new Map(),
    appended: [],
  };
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      registered.events.set(event, handler);
    },
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered.commands.set(name, options);
    },
    registerTool(tool: RegisteredTool) {
      registered.tools.set(tool.name, tool);
    },
    registerEntryRenderer(customType: string, renderer: (entry: unknown, options: unknown, theme: unknown) => unknown) {
      registered.entryRenderers.set(customType, renderer);
    },
    appendEntry(customType: string, data?: unknown) {
      registered.appended.push({ customType, data });
    },
  };
  return { pi, registered };
}

/** A branch-carrying session manager double for session_start rebuild tests. */
function makeCtx(cwd: string, hasUI: boolean, branch: unknown[] = []) {
  return {
    cwd,
    hasUI,
    mode: "tui",
    model: { id: "fake", provider: "fake" },
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
}

/** A scripted, owner-aware createSession that completes with a recorded change. */
const OWNED: Record<string, string> = {
  billing: "services/billing/x.rb",
  web: "apps/web/app.tsx",
  "design-system": "apps/web/components/button.tsx",
  infra: "infra/main.tf",
};
function scriptedCreateSession() {
  return async (config: DelegationSessionConfig): Promise<DelegationSession> => ({
    prompt: async () => {
      config.record.bashActivity.push({ command: `build ${config.owner}`, cwd: config.cwd });
      config.record.changedPaths.add(OWNED[config.owner]);
      const checkpoint = config.tools.find((t) => t.name === "orca_checkpoint")!;
      await checkpoint.execute(
        "t",
        { status: "completed", summary: `${config.owner} done` } as never,
        undefined,
        undefined,
        { cwd: config.cwd } as never,
      );
    },
    abort: () => {},
    usage: () => ({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001, available: true }),
  });
}

describe("orca-pi extension entry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-ext-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers the /orca command and a session_start handler", () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    expect(registered.commands.has("orca")).toBe(true);
    expect(registered.events.has("session_start")).toBe(true);
  });

  it("registers the orca_resolve and orca_explain tools", () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    expect(registered.tools.has("orca_resolve")).toBe(true);
    expect(registered.tools.has("orca_explain")).toBe(true);
  });

  it("/orca appends the last route decisions after a resolve call", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner");

    await registered.tools.get("orca_resolve")!.execute(
      "call-1",
      { paths: ["apps/web/app.tsx"] },
      undefined,
      undefined,
      { cwd: dir },
    );

    const ctx = makeCtx(dir, true);
    await registered.commands.get("orca")!.handler("", ctx);
    const widgetLines = ctx.ui.setWidget.mock.calls[0]?.[1] as string[];
    expect(widgetLines.join("\n")).toContain("Last route decisions");
    expect(widgetLines.join("\n")).toContain("apps/web/app.tsx");
  });

  it("/orca reports unmanaged and notifies in an unmanaged repo with UI", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    const ctx = makeCtx(dir, true);
    await registered.commands.get("orca")!.handler("", ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("orca", "orca: unmanaged");
    const notified = ctx.ui.notify.mock.calls[0]?.[0] as string;
    expect(notified).toContain("unmanaged");
  });

  it("/orca activates no UI side effects when there is no UI (headless)", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    const ctx = makeCtx(dir, false);
    await registered.commands.get("orca")!.handler("", ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  function writeSpec(fixture: string): void {
    mkdirSync(join(dir, ".orca"), { recursive: true });
    writeFileSync(join(dir, ".orca", "orca.yaml"), orcaspec.loadFixtureSource(fixture));
  }

  it("/orca mode enforce elevates the effective mode and persists for the session", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("single-agent"); // advisory minimum
    const command = registered.commands.get("orca")!;

    const before = makeCtx(dir, true);
    await command.handler("", before);
    expect(before.ui.setStatus).toHaveBeenCalledWith("orca", "orca: advisory");

    const setting = makeCtx(dir, true);
    await command.handler("mode enforce", setting);
    expect(setting.ui.setStatus).toHaveBeenCalledWith("orca", "orca: enforce");
    expect((setting.ui.notify.mock.calls[0]?.[0] as string)).toContain("Effective mode: enforce");

    // The requested mode persists on the same extension instance.
    const after = makeCtx(dir, true);
    await command.handler("", after);
    expect(after.ui.setStatus).toHaveBeenCalledWith("orca", "orca: enforce");
  });

  it("/orca mode with a bad argument warns and does not change mode", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("single-agent");
    const command = registered.commands.get("orca")!;

    const ctx = makeCtx(dir, true);
    await command.handler("mode strict", ctx);
    expect((ctx.ui.notify.mock.calls[0]?.[0] as string)).toContain("advisory|enforce");

    const after = makeCtx(dir, true);
    await command.handler("", after);
    expect(after.ui.setStatus).toHaveBeenCalledWith("orca", "orca: advisory");
  });

  it("/orca surfaces blocked diagnostics with UI", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("duplicate-agent-id");
    const ctx = makeCtx(dir, true);
    await registered.commands.get("orca")!.handler("", ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("orca", "orca: invalid_spec");
    const notified = ctx.ui.notify.mock.calls[0]?.[0] as string;
    expect(notified).toContain("semantic.duplicate_agent_id");
    expect(ctx.ui.notify.mock.calls[0]?.[1]).toBe("error");
  });

  // --- Phase 8: enforcement summary in /orca across all four states --------

  const orcaText = (ctx: ReturnType<typeof makeCtx>): string =>
    (ctx.ui.notify.mock.calls[0]?.[0] as string) ?? "";

  it("/orca shows the enforcement summary + bash disclosure ONLY under active governance", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("single-agent");
    const ctx = makeCtx(dir, true);
    await registered.commands.get("orca")!.handler("", ctx);
    const text = orcaText(ctx);
    expect(text).toContain("Enforcement profile (dimensioned");
    expect(text).toContain("Subprocess filesystem effects (bash): Advisory, disclosed");
    expect(text).toContain("partially_enforced");
  });

  it("/orca in unmanaged, invalid_spec, and unsupported_spec_version shows diagnostics, NOT an enforcement claim", async () => {
    const command = () => {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      return registered.commands.get("orca")!;
    };

    // unmanaged (no spec)
    const unmanagedCtx = makeCtx(dir, true);
    await command().handler("", unmanagedCtx);
    expect(orcaText(unmanagedCtx)).toContain("unmanaged");
    expect(orcaText(unmanagedCtx)).not.toContain("Enforcement profile");

    // invalid_spec
    writeSpec("duplicate-agent-id");
    const invalidCtx = makeCtx(dir, true);
    await command().handler("", invalidCtx);
    expect(orcaText(invalidCtx)).toContain("invalid_spec");
    expect(orcaText(invalidCtx)).toContain("Diagnostics");
    expect(orcaText(invalidCtx)).not.toContain("Enforcement profile");

    // unsupported_spec_version
    writeSpec("unsupported-spec-version");
    const unsupportedCtx = makeCtx(dir, true);
    await command().handler("", unsupportedCtx);
    expect(orcaText(unsupportedCtx)).toContain("unsupported_spec_version");
    expect(orcaText(unsupportedCtx)).not.toContain("Enforcement profile");
  });

  // --- Phase 8: delegation persistence, entry renderer, live surfaces ------

  it("registers a renderer for orca-delegation entries", () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    expect(registered.entryRenderers.has(DELEGATION_ENTRY_TYPE)).toBe(true);
  });

  it("persists a completed delegation as a session entry and shows it under /orca", async () => {
    const { pi, registered } = makeApi();
    installOrca(pi as never, { createSession: scriptedCreateSession() });
    writeSpec("multi-owner");

    const runCtx = makeCtx(dir, true);
    await registered.tools.get("orca_delegate")!.execute(
      "d1",
      { task: "restyle the button", paths: ["apps/web/app.tsx"] },
      undefined,
      undefined,
      runCtx,
    );

    // One orca-delegation entry was appended (no separate audit store).
    const appended = registered.appended.filter((e) => e.customType === DELEGATION_ENTRY_TYPE);
    expect(appended).toHaveLength(1);
    expect((appended[0].data as { owners: string[] }).owners).toEqual(["web"]);

    // Live surfaces fired during the delegation: widget updated + progress notified.
    expect(runCtx.ui.setWidget).toHaveBeenCalled();
    const notifications = runCtx.ui.notify.mock.calls.map((c) => c[0] as string);
    expect(notifications.some((n) => n.includes("delegating to"))).toBe(true);
    expect(notifications.some((n) => n.includes("delegation complete"))).toBe(true);

    // The durable history is visible in /orca on the SAME session instance.
    const statusCtx = makeCtx(dir, true);
    await registered.commands.get("orca")!.handler("", statusCtx);
    const status = orcaText(statusCtx);
    expect(status).toContain("Delegation history (1):");
    expect(status).toContain("restyle the button");
    // Last-delegation detail carries the reconciled shell capability and retains
    // only a sanitized command digest, never the raw command.
    expect(status).toContain("Capability summary (not a mode): enforced");
    expect(status).toContain("Shell activities (sanitized digests)");
  });

  it("a resumed session rebuilds delegation history from session entries ALONE", async () => {
    // First instance runs a delegation and captures the persisted entry.
    const first = makeApi();
    installOrca(first.pi as never, { createSession: scriptedCreateSession() });
    writeSpec("multi-owner");
    await first.registered.tools.get("orca_delegate")!.execute(
      "d1",
      {
        task: "the earlier task",
        paths: ["apps/web/app.tsx", "services/billing/x.rb"],
        assignments: [
          { owner: "billing", task: "update billing", paths: ["services/billing/x.rb"] },
          {
            owner: "web",
            task: "update web after billing",
            paths: ["apps/web/app.tsx"],
            depends_on: ["billing"],
          },
        ],
      },
      undefined,
      undefined,
      makeCtx(dir, true),
    );
    const entry = {
      type: "custom",
      customType: DELEGATION_ENTRY_TYPE,
      data: first.registered.appended.find((e) => e.customType === DELEGATION_ENTRY_TYPE)!.data,
    };

    // A FRESH instance (fresh in-memory state) resumes: session_start rebuilds
    // history purely from the branch entries, with an unrelated entry interleaved.
    const resumed = makeApi();
    orcaPi(resumed.pi as never);
    const branch = [{ type: "message", message: { role: "user" } }, entry];
    const resumeCtx = makeCtx(dir, true, branch);
    await resumed.registered.events.get("session_start")!({ reason: "resume" }, resumeCtx);

    const statusCtx = makeCtx(dir, true, branch);
    await resumed.registered.commands.get("orca")!.handler("", statusCtx);
    expect(orcaText(statusCtx)).toContain("Delegation history (1):");
    expect(orcaText(statusCtx)).toContain("the earlier task");
  });

  it("session_start announces activation for a managed repo and stays quiet when unmanaged", async () => {
    const active = makeApi();
    orcaPi(active.pi as never);
    writeSpec("single-agent");
    const activeCtx = makeCtx(dir, true);
    await active.registered.events.get("session_start")!({ reason: "startup" }, activeCtx);
    expect(activeCtx.ui.setStatus).toHaveBeenCalledWith("orca", "orca: advisory");
    expect((activeCtx.ui.notify.mock.calls[0]?.[0] as string)).toContain("governance active");

    const bare = mkdtempSync(join(tmpdir(), "orca-pi-bare-"));
    try {
      const unmanaged = makeApi();
      orcaPi(unmanaged.pi as never);
      const bareCtx = makeCtx(bare, true);
      await unmanaged.registered.events.get("session_start")!({ reason: "startup" }, bareCtx);
      expect(bareCtx.ui.setStatus).toHaveBeenCalledWith("orca", "orca: unmanaged");
      expect(bareCtx.ui.notify).not.toHaveBeenCalled();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("drives a full delegation headless without any UI calls", async () => {
    const { pi, registered } = makeApi();
    installOrca(pi as never, { createSession: scriptedCreateSession() });
    writeSpec("multi-owner");
    const ctx = makeCtx(dir, false);
    await registered.tools.get("orca_delegate")!.execute(
      "d1",
      { task: "headless task", paths: ["apps/web/app.tsx"] },
      undefined,
      undefined,
      ctx,
    );
    // The delegation still ran and persisted; the surfaces were simply no-ops.
    expect(registered.appended.filter((e) => e.customType === DELEGATION_ENTRY_TYPE)).toHaveLength(1);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });
});
