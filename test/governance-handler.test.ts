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
    registerEntryRenderer(_customType: string, _renderer: unknown) {},
    appendEntry(_customType: string, _data?: unknown) {},
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

  it("intercepts nothing across every governed tool when unmanaged, and records no event", async () => {
    // Only the absence of a spec is pass-through. This is the boundary the
    // fail-closed broken-spec states must NOT creep across.
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    const handler = only(registered, "tool_call");
    const ctx = makeCtx(dir);
    for (const event of [
      writeEvent("secrets/prod.key"),
      editEvent("apps/web/app.tsx"),
      { type: "tool_call", toolName: "read", toolCallId: "r", input: { path: "secrets/prod.key" } },
      { type: "tool_call", toolName: "grep", toolCallId: "g", input: { pattern: "x", path: "secrets" } },
      { type: "tool_call", toolName: "find", toolCallId: "f", input: { pattern: "*", path: "secrets" } },
      { type: "tool_call", toolName: "ls", toolCallId: "l", input: {} },
    ]) {
      expect(await handler(event, ctx), (event as { toolName: string }).toolName).toBeUndefined();
    }
    expect(ctx.ui.notify).not.toHaveBeenCalled();

    const statusCtx = makeCtx(dir);
    await registered.commands.get("orca")!.handler("", statusCtx);
    const status = (statusCtx.ui.setWidget.mock.calls[0]?.[1] as string[]).join("\n");
    expect(status).toContain("no tool interception");
    expect(status).not.toContain("Governance events");
  });

  // --- Fail-closed governance on a broken spec (Phase 1) -------------------

  it("blocks a write in invalid_spec in BOTH requested modes, carrying a spec diagnostic", async () => {
    for (const requested of ["advisory", "enforce"] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpec("duplicate-agent-id"); // invalid_spec
      const handler = only(registered, "tool_call");
      // advisory is the default requested mode; enforce is set through /orca.
      if (requested === "enforce") {
        await registered.commands.get("orca")!.handler("mode enforce", makeCtx(dir));
      }
      const ctx = makeCtx(dir);
      const result = (await handler(writeEvent("apps/web/app.tsx"), ctx)) as {
        block?: boolean;
        reason?: string;
      };
      expect(result?.block, `${requested}: blocked`).toBe(true);
      expect(result?.reason, `${requested}: names the state`).toContain("invalid_spec");
      // At least one diagnostic from the state reaches the model.
      expect(result?.reason, `${requested}: carries a diagnostic`).toContain(
        "semantic.duplicate_agent_id",
      );
      expect(ctx.ui.notify, `${requested}: notifies the human`).toHaveBeenCalled();
    }
  });

  it("blocks an edit in unsupported_spec_version in BOTH modes, naming found vs supported version", async () => {
    for (const requested of ["advisory", "enforce"] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpec("unsupported-spec-version"); // declares 0.2; runtime supports 0.1
      const handler = only(registered, "tool_call");
      if (requested === "enforce") {
        await registered.commands.get("orca")!.handler("mode enforce", makeCtx(dir));
      }
      const result = (await handler(editEvent("apps/web/app.tsx"), makeCtx(dir))) as {
        block?: boolean;
        reason?: string;
      };
      expect(result?.block, `${requested}: blocked`).toBe(true);
      expect(result?.reason, `${requested}: names the state`).toContain("unsupported_spec_version");
      expect(result?.reason, `${requested}: names the found version`).toContain(
        "declares spec_version '0.2'",
      );
      expect(result?.reason, `${requested}: names the supported version`).toContain("supports '0.1'");
    }
  });

  it("lets discovery reads proceed in both broken states so the spec can be diagnosed", async () => {
    for (const fixture of ["duplicate-agent-id", "unsupported-spec-version"] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpec(fixture);
      const handler = only(registered, "tool_call");
      for (const event of [
        { type: "tool_call", toolName: "read", toolCallId: "r", input: { path: ".orca/orca.yaml" } },
        { type: "tool_call", toolName: "grep", toolCallId: "g", input: { pattern: "x", path: "." } },
        { type: "tool_call", toolName: "find", toolCallId: "f", input: { pattern: "*", path: "." } },
        { type: "tool_call", toolName: "ls", toolCallId: "l", input: { path: "." } },
      ]) {
        const result = await handler(event, makeCtx(dir));
        expect(result, `${fixture} ${event.toolName}`).toBeUndefined();
      }
    }
  });

  // --- Salvaged read protections on a broken spec (Phase 4) ----------------

  /** Write a hand-broken document, for damage no fixture carries. */
  function writeSpecSource(source: string): void {
    mkdirSync(join(dir, ".orca"), { recursive: true });
    writeFileSync(join(dir, ".orca", "orca.yaml"), source);
  }

  /** The multi-owner fixture (protected read deny `secrets/**`) broken far from its protections. */
  function brokenElsewhere(): string {
    return `${orcaspec.loadFixtureSource("multi-owner")}\nnot_a_section:\n  anything: true\n`;
  }

  /** The same fixture with its protections section itself made unreadable. */
  function brokenProtections(): string {
    return orcaspec
      .loadFixtureSource("multi-owner")
      .replace("protected_denies:\n  read:\n    - secrets/**", "protected_denies: 3\n#");
  }

  async function statusText(registered: Registered): Promise<string> {
    const ctx = makeCtx(dir);
    await registered.commands.get("orca")!.handler("", ctx);
    return (ctx.ui.setWidget.mock.calls[0]?.[1] as string[]).join("\n");
  }

  it("refuses a read of a salvaged protected path in BOTH requested modes", async () => {
    for (const requested of ["advisory", "enforce"] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpecSource(brokenElsewhere());
      if (requested === "enforce") {
        await registered.commands.get("orca")!.handler("mode enforce", makeCtx(dir));
      }
      const ctx = makeCtx(dir);
      const result = (await only(registered, "tool_call")(
        { type: "tool_call", toolName: "read", toolCallId: "p", input: { path: "secrets/prod.key" } },
        ctx,
      )) as { block?: boolean; reason?: string };
      expect(result?.block, `${requested}: refused`).toBe(true);
      expect(result?.reason, `${requested}: names the path`).toContain("secrets/prod.key");
      expect(result?.reason, `${requested}: names the salvaged scope`).toContain("secrets/**");
      expect(result?.reason, `${requested}: names the protection`).toContain("protected deny");
      expect(ctx.ui.notify, `${requested}: notifies the human`).toHaveBeenCalled();
    }
  });

  it("keeps every other discovery read open on that same broken spec", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpecSource(brokenElsewhere());
    const handler = only(registered, "tool_call");
    for (const event of [
      { type: "tool_call", toolName: "read", toolCallId: "r", input: { path: ".orca/orca.yaml" } },
      { type: "tool_call", toolName: "grep", toolCallId: "g", input: { pattern: "x", path: "." } },
      { type: "tool_call", toolName: "find", toolCallId: "f", input: { pattern: "*", path: "apps" } },
      { type: "tool_call", toolName: "ls", toolCallId: "l", input: {} },
    ]) {
      expect(await handler(event, makeCtx(dir)), event.toolName).toBeUndefined();
    }
  });

  it("refuses a protected path a symlink resolves onto, not the link that reached it", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpecSource(brokenElsewhere());
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "prod.key"), "shhh");
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    symlinkSync(join(dir, "secrets", "prod.key"), join(dir, "apps", "web", "innocent.txt"));

    const result = (await only(registered, "tool_call")(
      { type: "tool_call", toolName: "read", toolCallId: "sym", input: { path: "apps/web/innocent.txt" } },
      makeCtx(dir),
    )) as { block?: boolean; reason?: string };
    expect(result?.block, "the resolved target is what is checked").toBe(true);
    expect(result?.reason).toContain("protected deny");
    expect(result?.reason).toContain("secrets/prod.key");
  });

  it("leaves reads open and reports the lapse when the protections themselves are unrecoverable", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpecSource(brokenProtections());
    const result = await only(registered, "tool_call")(
      { type: "tool_call", toolName: "read", toolCallId: "l", input: { path: "secrets/prod.key" } },
      makeCtx(dir),
    );
    expect(result, "a lapse cannot be enforced, only stated").toBeUndefined();

    const status = await statusText(registered);
    expect(status).toContain("invalid_spec");
    expect(status, "the lapse is stated where the user reads the state").toContain("LAPSED");
    expect(status).toContain("protections_lapsed");
  });

  it("blocks a write the broken document's own grant covers, salvage or no salvage", async () => {
    // Only protections are honored from an unusable document; `infra/**` is the infra
    // agent's ownership and edit grant in this very file, and it authorizes nothing.
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpecSource(brokenElsewhere());
    const result = (await only(registered, "tool_call")(writeEvent("infra/main.tf"), makeCtx(dir))) as {
      block?: boolean;
      reason?: string;
    };
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("does not take effect");
  });

  it("agrees between /orca status and the refusal it just enforced", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpecSource(brokenElsewhere());
    await only(registered, "tool_call")(
      { type: "tool_call", toolName: "read", toolCallId: "p", input: { path: "secrets/prod.key" } },
      makeCtx(dir),
    );
    const status = await statusText(registered);
    expect(status, "names the regime the block enforced").toContain("ENFORCING 1");
    expect(status).toContain("secrets/**");
    expect(status, "and the refusal is on the record").toContain("blocked read");
  });

  it("tells the session which read-protection regime is in force before it starts", async () => {
    for (const [label, source, expected] of [
      ["salvaged", brokenElsewhere(), "ENFORCING 1"],
      ["lapsed", brokenProtections(), "LAPSED"],
    ] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpecSource(source);
      const result = (await only(registered, "before_agent_start")(
        { systemPrompt: "base" },
        makeCtx(dir),
      )) as { systemPrompt?: string };
      expect(result?.systemPrompt, `${label}: states the regime`).toContain(expected);
    }
  });

  it("records a broken-spec block under /orca so status and enforcement agree", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("duplicate-agent-id");
    await only(registered, "tool_call")(writeEvent("apps/web/app.tsx"), makeCtx(dir));

    const statusCtx = makeCtx(dir);
    await registered.commands.get("orca")!.handler("", statusCtx);
    const status = (statusCtx.ui.setWidget.mock.calls[0]?.[1] as string[]).join("\n");
    // The status claims writes are blocked and reads proceed; the block above is
    // the same behavior, recorded as a governance event.
    expect(status).toContain("invalid_spec");
    expect(status).toContain("write and edit are BLOCKED");
    expect(status).toContain("Discovery reads");
    expect(status).toContain("Governance events");
    expect(status).toContain("blocked write");
  });

  it("blocks writes on a spec that is empty, malformed, or not a mapping (not just a bad fixture)", async () => {
    // A hand-broken file is the common real case; each one must land in a blocked
    // state and fail closed rather than throwing out of the handler.
    for (const source of ["", "   \n\n", "- just\n- a\n- list\n", "  not yaml: [[[\n"]) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      mkdirSync(join(dir, ".orca"), { recursive: true });
      writeFileSync(join(dir, ".orca", "orca.yaml"), source);
      const handler = only(registered, "tool_call");
      const label = JSON.stringify(source);
      const result = (await handler(writeEvent("a.txt"), makeCtx(dir))) as { block?: boolean };
      expect(result?.block, `${label}: in-repo write blocked`).toBe(true);
      // A write whose path escapes the repository is blocked for the same reason;
      // there is no spec to authorize it against either way.
      const escaping = (await handler(writeEvent("../../etc/passwd"), makeCtx(dir))) as {
        block?: boolean;
      };
      expect(escaping?.block, `${label}: escaping write blocked`).toBe(true);
      // Reads stay available so the user can look at the broken file.
      const read = await handler(
        { type: "tool_call", toolName: "read", toolCallId: "r", input: { path: ".orca/orca.yaml" } },
        makeCtx(dir),
      );
      expect(read, `${label}: read proceeds`).toBeUndefined();
    }
  });

  it("does not intercept bash in a broken state, exactly as it does not when active", async () => {
    // Decided out of scope for fail-closed governance: the parent's bash is not
    // governed by this handler in ANY state, so a broken spec must not claim to
    // block shell-mediated writes it cannot see. Parity with `active` is the point.
    const bash = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "b",
      input: { command: "echo hi > a.txt" },
    };
    for (const fixture of ["duplicate-agent-id", "multi-owner"] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpec(fixture);
      expect(await only(registered, "tool_call")(bash, makeCtx(dir)), fixture).toBeUndefined();
    }
  });

  it("orca_delegate returns a blocked result in both broken states rather than crashing", async () => {
    for (const fixture of ["duplicate-agent-id", "unsupported-spec-version"] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpec(fixture);
      const result = await registered.tools.get("orca_delegate")!.execute(
        "d-broken",
        { task: "restyle the button", paths: ["apps/web/app.tsx"] },
        undefined,
        undefined,
        { cwd: dir },
      );
      const body = result.content.map((c) => c.text).join("\n");
      const kind = fixture === "duplicate-agent-id" ? "invalid_spec" : "unsupported_spec_version";
      // The result LEADS with the block, naming the state — not with a generic
      // "routing unavailable", which would read like an unmanaged repository.
      const lead = body.split("\n")[0];
      expect(lead, `${fixture}: leads with the block`).toContain("blocked");
      expect(lead, `${fixture}: lead names the state`).toContain(kind);
      expect(body, `${fixture}: explains both modes`).toContain("advisory and enforce modes alike");
      expect(result.details?.kind, `${fixture}: details kind`).toBe("inactive");
      // No session was spawned and nothing was written.
      expect(existsSync(join(dir, "apps", "web", "app.tsx")), `${fixture}: no write`).toBe(false);
    }
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

  it("injects no steward prompt in an unmanaged repository", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    const handler = only(registered, "before_agent_start");
    expect(await handler({ systemPrompt: "BASE" }, makeCtx(dir))).toBeUndefined();
  });

  it("appends a short broken-spec note (not the full steward prompt) in both broken states", async () => {
    for (const fixture of ["duplicate-agent-id", "unsupported-spec-version"] as const) {
      const { pi, registered } = makeApi();
      orcaPi(pi as never);
      writeSpec(fixture);
      const result = (await only(registered, "before_agent_start")(
        { systemPrompt: "BASE PROMPT" },
        makeCtx(dir),
      )) as { systemPrompt?: string };
      const prompt = result.systemPrompt ?? "";
      expect(prompt.startsWith("BASE PROMPT"), `${fixture}: appends to pi's prompt`).toBe(true);
      expect(prompt, `${fixture}: names the state`).toContain(
        fixture === "duplicate-agent-id" ? "invalid_spec" : "unsupported_spec_version",
      );
      expect(prompt, `${fixture}: states writes are blocked`).toContain("write");
      expect(prompt, `${fixture}: states reads still work`).toContain("read");
      // The full active-governance steward prompt does NOT apply: there is no
      // validated ownership map to describe.
      expect(prompt, `${fixture}: no discovery-scope section`).not.toContain(
        "## Discovery read scope",
      );
      expect(prompt, `${fixture}: no delegation directive`).not.toContain("## Delegation directive");
    }
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

  it("orca_delegate fails an unowned target in enforce mode before spawning (no session, no writes)", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    writeSpec("multi-owner"); // minimum_mode: enforce
    // An unowned target fails the whole delegation pre-spawn (ADR 0012), so no
    // session is ever constructed and the real (network-bound) factory is never
    // reached — a deterministic, offline assertion through the real extension.
    const result = await registered.tools.get("orca_delegate")!.execute(
      "d1",
      { task: "restyle the button and touch a script", paths: ["apps/web/app.tsx", "scripts/deploy.sh"] },
      undefined,
      undefined,
      { cwd: dir },
    );
    const body = result.content.map((c) => c.text).join("\n");
    expect(body).toContain("scripts/deploy.sh");
    expect(body).toContain("enforce mode");
    expect(result.details?.kind).toBe("unowned_blocked");
    // No side effect: neither the owned nor the unowned target was created.
    expect(existsSync(join(dir, "apps", "web", "app.tsx"))).toBe(false);
    expect(existsSync(join(dir, "scripts", "deploy.sh"))).toBe(false);
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
