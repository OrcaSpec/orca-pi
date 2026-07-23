import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import orcaPi from "../index";

// A minimal ExtensionAPI double that captures registrations. The extension's
// pi-framework imports are type-only, so index.ts pulls in no pi runtime here.
interface Registered {
  events: Map<string, (event: unknown, ctx: unknown) => unknown>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
}

function makeApi(): { pi: unknown; registered: Registered } {
  const registered: Registered = { events: new Map(), commands: new Map() };
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      registered.events.set(event, handler);
    },
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered.commands.set(name, options);
    },
  };
  return { pi, registered };
}

function makeCtx(cwd: string, hasUI: boolean) {
  return {
    cwd,
    hasUI,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
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
});
