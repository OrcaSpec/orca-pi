import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import orcaPi from "../index";

/**
 * Steward governance wired through index.ts: the tool_call / tool_result /
 * before_agent_start handlers, the violation record surfaced under /orca, the
 * Phase 5 tool surface, and reload idempotency. The pure decision matrix lives
 * in governance.test.ts; here we assert the wiring, the real-filesystem symlink
 * handling, and the advisory flagging round-trip.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Tool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text?: string }[]; details?: { kind?: string } }>;
}
interface Registered {
  events: Map<string, Handler[]>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  tools: Map<string, Tool>;
}

function makeApi(): { pi: unknown; registered: Registered } {
  const registered: Registered = { events: new Map(), commands: new Map(), tools: new Map() };
  const pi = {
    on(event: string, handler: Handler) {
      const list = registered.events.get(event) ?? [];
      list.push(handler);
      registered.events.set(event, list);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered.commands.set(name, options);
    },
    registerTool(tool: Tool) {
      registered.tools.set(tool.name, tool);
    },
  };
  return { pi, registered };
}

/** The single handler registered for an event (asserts no duplicate registration). */
function only(registered: Registered, event: string): Handler {
  const list = registered.events.get(event) ?? [];
  expect(list.length).toBe(1);
  return list[0];
}

function makeCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  };
}

function writeEvent(path: string, toolCallId = "c1") {
  return { type: "tool_call", toolName: "write", toolCallId, input: { path, content: "x" } };
}
function editEvent(path: string, toolCallId = "c1") {
  return {
    type: "tool_call",
    toolName: "edit",
    toolCallId,
    input: { path, edits: [{ oldText: "a", newText: "b" }] },
  };
}

describe("steward governance handlers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-gov-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSpec(fixture: string): void {
    mkdirSync(join(dir, ".orca"), { recursive: true });
    writeFileSync(join(dir, ".orca", "orca.yaml"), orcaspec.loadFixtureSource(fixture));
  }

  // --- Enforce write governance -------------------------------------------

  it("blocks a parent write into an owned scope in enforce mode, naming owner and orca_delegate", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner"); // minimum_mode: enforce
    const ctx = makeCtx(dir);
    const result = (await only(registered, "tool_call")(writeEvent("apps/web/app.tsx"), ctx)) as {
      block?: boolean;
      reason?: string;
    };
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("web");
    expect(result?.reason).toContain("orca_delegate");
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("blocks each distinct owned scope with the correct owner and blocks edit too", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner");
    const handler = only(registered, "tool_call");
    const billing = (await handler(writeEvent("services/billing/x.rb"), makeCtx(dir))) as {
      reason?: string;
    };
    expect(billing.reason).toContain("billing");
    const nested = (await handler(
      editEvent("apps/web/components/button.tsx"),
      makeCtx(dir),
    )) as { block?: boolean; reason?: string };
    expect(nested.block).toBe(true);
    expect(nested.reason).toContain("design-system");
  });

  it("blocks an unowned write closed in enforce mode (ADR 0012)", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner");
    const result = (await only(registered, "tool_call")(writeEvent("scripts/deploy.rb"), makeCtx(dir))) as {
      block?: boolean;
      reason?: string;
    };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("not owned");
  });

  // --- Advisory flagging round-trip ---------------------------------------

  it("advisory mode lets an owned write proceed but records and explains it (model + human)", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("single-agent"); // minimum_mode: advisory; billing owns services/billing/**
    const toolCall = only(registered, "tool_call");
    const toolResult = only(registered, "tool_result");
    const ctx = makeCtx(dir);

    const blocked = await toolCall(writeEvent("services/billing/x.rb", "call-adv"), ctx);
    expect(blocked).toBeUndefined(); // advisory: not blocked
    expect(ctx.ui.notify).toHaveBeenCalled(); // human-visible flag

    // Model-visible: the matching tool_result gets the same explanation appended.
    const patched = (await toolResult(
      {
        type: "tool_result",
        toolName: "write",
        toolCallId: "call-adv",
        input: {},
        content: [{ type: "text", text: "wrote file" }],
        isError: false,
      },
      {},
    )) as { content: { type: string; text: string }[] };
    const noteText = patched.content.map((c) => c.text).join("\n");
    expect(noteText).toContain("[orca advisory]");
    expect(noteText).toContain("orca_delegate");
    expect(noteText).toContain("billing");

    // Human-visible: the violation is recorded and surfaced under /orca.
    const widgetCtx = makeCtx(dir);
    await registered.commands.get("orca")!.handler("", widgetCtx);
    const widget = (widgetCtx.ui.setWidget.mock.calls[0]?.[1] as string[]).join("\n");
    expect(widget).toContain("Governance events");
    expect(widget).toContain("flagged write");
  });

  it("does not append a note for an unflagged (in-scope) call", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner");
    const patched = await only(registered, "tool_result")(
      {
        type: "tool_result",
        toolName: "read",
        toolCallId: "never-flagged",
        input: {},
        content: [{ type: "text", text: "body" }],
        isError: false,
      },
      {},
    );
    expect(patched).toBeUndefined();
  });

  // --- Discovery governance ------------------------------------------------

  it("allows an in-scope discovery read and does not record a violation", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner"); // discovery allow: **
    const ctx = makeCtx(dir);
    const result = await only(registered, "tool_call")(
      { type: "tool_call", toolName: "read", toolCallId: "r1", input: { path: "apps/web/app.tsx" } },
      ctx,
    );
    expect(result).toBeUndefined();
    await registered.commands.get("orca")!.handler("", ctx);
    const widget = (ctx.ui.setWidget.mock.calls[0]?.[1] as string[]).join("\n");
    expect(widget).not.toContain("Governance events");
  });

  it("blocks a protected-deny read in enforce and in advisory (non-overridable)", async () => {
    // Enforce (multi-owner) and advisory (single-agent) both declare protected read secrets/**.
    for (const fixture of ["multi-owner", "single-agent"] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpec(fixture);
      const result = (await only(registered, "tool_call")(
        { type: "tool_call", toolName: "read", toolCallId: "r", input: { path: "secrets/prod.key" } },
        makeCtx(dir),
      )) as { block?: boolean; reason?: string };
      expect(result.block).toBe(true);
      expect(result.reason).toContain("protected deny");
    }
  });

  it("covers every discovery tool shape (read/grep/find/ls), including pathless ls", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner");
    const handler = only(registered, "tool_call");
    // grep/find/ls on a protected path are blocked (path lives in .path per the builtin schema).
    for (const event of [
      { type: "tool_call", toolName: "grep", toolCallId: "g", input: { pattern: "x", path: "secrets" } },
      { type: "tool_call", toolName: "find", toolCallId: "f", input: { pattern: "*", path: "secrets" } },
      { type: "tool_call", toolName: "ls", toolCallId: "l", input: { path: "secrets" } },
    ]) {
      const result = (await handler(event, makeCtx(dir))) as { block?: boolean };
      expect(result.block).toBe(true);
    }
    // ls with no path = the repository root, allowed under the ** discovery scope.
    const rootLs = await handler(
      { type: "tool_call", toolName: "ls", toolCallId: "l2", input: {} },
      makeCtx(dir),
    );
    expect(rootLs).toBeUndefined();
  });

  it("splits an out-of-scope read by mode: advisory flags, enforce blocks (minimal spec)", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("minimal"); // discovery allow: [] — everything is out of scope; minimum advisory
    const handler = only(registered, "tool_call");

    const advisory = await handler(
      { type: "tool_call", toolName: "read", toolCallId: "o1", input: { path: "README.md" } },
      makeCtx(dir),
    );
    expect(advisory).toBeUndefined(); // advisory: flagged, not blocked

    // Elevate the requested mode to enforce via the command, then re-read.
    await registered.commands.get("orca")!.handler("mode enforce", makeCtx(dir));
    const enforce = (await handler(
      { type: "tool_call", toolName: "read", toolCallId: "o2", input: { path: "README.md" } },
      makeCtx(dir),
    )) as { block?: boolean; reason?: string };
    expect(enforce.block).toBe(true);
    expect(enforce.reason).toContain("discovery read scope");
  });

  it("rejects a symlink whose real target escapes scope, even though its path is in scope (ADR 0032)", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner"); // enforce; discovery allow: **
    const external = mkdtempSync(join(tmpdir(), "orca-pi-ext-target-"));
    try {
      const target = join(external, "secret.txt");
      writeFileSync(target, "top secret");
      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      symlinkSync(target, join(dir, "apps", "web", "link.txt"));

      const result = (await only(registered, "tool_call")(
        { type: "tool_call", toolName: "read", toolCallId: "sym", input: { path: "apps/web/link.txt" } },
        makeCtx(dir),
      )) as { block?: boolean; reason?: string };
      expect(result.block).toBe(true);
      expect(result.reason).toContain("symbolic link");
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("blocks a symlink read in enforce even when the real target is in scope (ADR 0032)", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner");
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "real.txt"), "in scope");
    symlinkSync(join(dir, "apps", "web", "real.txt"), join(dir, "apps", "web", "alias.txt"));
    const result = (await only(registered, "tool_call")(
      { type: "tool_call", toolName: "read", toolCallId: "sym2", input: { path: "apps/web/alias.txt" } },
      makeCtx(dir),
    )) as { block?: boolean; reason?: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("symbolic link");
  });

  // --- No interception outside the active state ---------------------------

  it("intercepts nothing in an unmanaged repository", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    // No spec written: unmanaged.
    const write = await only(registered, "tool_call")(writeEvent("apps/web/app.tsx"), makeCtx(dir));
    const read = await only(registered, "tool_call")(
      { type: "tool_call", toolName: "read", toolCallId: "u", input: { path: "secrets/x" } },
      makeCtx(dir),
    );
    expect(write).toBeUndefined();
    expect(read).toBeUndefined();
  });

  it("intercepts nothing in a blocked (invalid_spec) repository", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("duplicate-agent-id"); // invalid_spec
    const result = await only(registered, "tool_call")(writeEvent("apps/web/app.tsx"), makeCtx(dir));
    expect(result).toBeUndefined();
  });

  // --- Steward identity composition ---------------------------------------

  it("appends the steward prompt (root-first) only in the active state", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner");
    const result = (await only(registered, "before_agent_start")(
      { systemPrompt: "BASE PROMPT" },
      makeCtx(dir),
    )) as { systemPrompt?: string };
    expect(result.systemPrompt?.startsWith("BASE PROMPT")).toBe(true);
    expect(result.systemPrompt).toContain("## Orca harness invariants");
    expect(result.systemPrompt).toContain("## Delegation directive");
    expect(result.systemPrompt!.indexOf("## Orca harness invariants")).toBeLessThan(
      result.systemPrompt!.indexOf("## Delegation directive"),
    );
  });

  it("injects no steward prompt in unmanaged or blocked states", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    const handler = only(registered, "before_agent_start");
    expect(await handler({ systemPrompt: "BASE" }, makeCtx(dir))).toBeUndefined(); // unmanaged
    writeSpec("duplicate-agent-id");
    expect(await handler({ systemPrompt: "BASE" }, makeCtx(dir))).toBeUndefined(); // invalid_spec
  });

  // --- Tool surface --------------------------------------------------------

  it("registers orca_delegate and never registers orca_checkpoint in the parent", () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    expect(registered.tools.has("orca_resolve")).toBe(true);
    expect(registered.tools.has("orca_explain")).toBe(true);
    expect(registered.tools.has("orca_delegate")).toBe(true);
    expect(registered.tools.has("orca_checkpoint")).toBe(false);
  });

  it("orca_delegate defers a multi-owner task to Phase 7 without spawning or writing", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner");
    // Two owners (web + billing) => not the single-owner happy path; returns the
    // Phase-7-pending explanation without constructing a session (no network).
    const result = await registered.tools.get("orca_delegate")!.execute(
      "d1",
      { task: "restyle the button and touch billing", paths: ["apps/web/app.tsx", "services/billing/x.rb"] },
      undefined,
      undefined,
      { cwd: dir },
    );
    const body = result.content.map((c) => c.text).join("\n");
    expect(body).toContain("Phase 7");
    expect(body).toContain("owner");
    expect(result.details?.kind).toBe("phase7_pending");
    // No side effect: neither planned target was created.
    expect(existsSync(join(dir, "apps", "web", "app.tsx"))).toBe(false);
    expect(existsSync(join(dir, "services", "billing", "x.rb"))).toBe(false);
  });

  // --- Reload idempotency --------------------------------------------------

  it("registers exactly one handler per event (reload rebuilds, never accumulates)", () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    for (const event of ["tool_call", "tool_result", "before_agent_start", "session_start"]) {
      expect(registered.events.get(event)?.length).toBe(1);
    }
    // A fresh instance (as /reload builds) still has exactly one of each.
    const second = makeApi();
    orcaPi(second.pi as never);
    expect(second.registered.events.get("tool_call")?.length).toBe(1);
  });
});
