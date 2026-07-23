import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import orcaPi, { installOrca } from "../index";
import { materializeFixtureRepo } from "./materialize-repo";
import {
  detectRepositoryState,
  ORCA_DIR,
  ORCA_SPEC_FILE,
  type ActiveState,
} from "../src/state";
import { compileGrant, resolve } from "../src/resolver";
import { classifyDiscovery, classifyWrite } from "../src/governance";
import { buildDelegationSession, type DelegationSession, type DelegationSessionConfig } from "../src/delegation";
import { DELEGATION_ENTRY_TYPE } from "../src/delegation-entry";
import type { OperatingMode } from "../src/mode";
import type { ResolveToolDetails } from "../src/tools";
import type { OrcaSpecDocument } from "orcaspec";

/**
 * The deterministic conformance / enforcement / lifecycle / state suite run
 * against the HAND-WRITTEN managed test repository (`test/fixture-repo/`),
 * materialized fresh per test — the Phase 9 fixture repo, driven with NO live
 * model. It exercises the real extension (`installOrca`) and the pure modules
 * together across: spec activation, resolver routing over nested + adjacent
 * ownership with agent and protected denies and edit-shorthand expansion, steward
 * governance per mode, provably-blocked out-of-scope delegated file tools, context
 * injection, and the full delegation lifecycle including a scope-expansion
 * round-trip and a multi-owner split. Scripted sessions stand in for the model.
 */

// --- Test doubles (minimal pi ExtensionAPI + ctx) ----------------------------

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text?: string }[]; details?: ResolveToolDetails }>;
}
interface Registered {
  events: Map<string, (event: unknown, ctx: unknown) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  tools: Map<string, RegisteredTool>;
  appended: { customType: string; data: unknown }[];
}

function makeApi(): { pi: unknown; registered: Registered } {
  const registered: Registered = {
    events: new Map(),
    commands: new Map(),
    tools: new Map(),
    appended: [],
  };
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      registered.events.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered.commands.set(name, options);
    },
    registerTool(tool: RegisteredTool) {
      registered.tools.set(tool.name, tool);
    },
    registerEntryRenderer() {},
    appendEntry(customType: string, data?: unknown) {
      registered.appended.push({ customType, data });
    },
  };
  return { pi, registered };
}

function makeCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    model: { id: "fake", provider: "fake" },
    sessionManager: { getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  };
}

function writeEvent(path: string, id = "c1") {
  return { type: "tool_call", toolName: "write", toolCallId: id, input: { path, content: "x" } };
}
function readEvent(path: string | undefined, id = "r1") {
  return { type: "tool_call", toolName: "read", toolCallId: id, input: path === undefined ? {} : { path } };
}

/** A path inside each owner's write grant, for scripted delegated writes. */
const OWNED: Record<string, string> = {
  web: "apps/web/src/app.tsx",
  "design-system": "apps/web/components/Button.tsx",
  "web-admin": "apps/web-admin/src/dashboard.tsx",
  billing: "services/billing/invoice.ts",
  api: "services/api/server.ts",
  infra: "infra/main.tf",
  docs: "docs/shared/architecture.md",
};

type Script = (config: DelegationSessionConfig) => Promise<void>;

async function callSessionTool(config: DelegationSessionConfig, name: string, params: unknown): Promise<void> {
  const tool = config.tools.find((t) => t.name === name)!;
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

/** Default script: write the owner's path through its granted write tool, then complete. */
const completeScript: Script = async (config) => {
  await callSessionTool(config, "write", { path: OWNED[config.owner], content: `// ${config.owner} edit` });
  await callSessionTool(config, "orca_checkpoint", { status: "completed", summary: `${config.owner} done` });
};

/** An owner-aware scripted session factory that records every config it built. */
function scriptedSessions(overrides: Record<string, Script> = {}) {
  const captured: DelegationSessionConfig[] = [];
  const createSession = vi.fn(async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    captured.push(config);
    const script = overrides[config.owner] ?? completeScript;
    return {
      prompt: () => script(config),
      abort: () => {},
      usage: () => ({ inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0.0001, available: true }),
    };
  });
  return { createSession, captured };
}

// --- Fixtures ----------------------------------------------------------------

let repo: string;
beforeEach(() => {
  repo = materializeFixtureRepo();
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function activeDoc(mode: OperatingMode = "advisory"): { state: ActiveState; document: OrcaSpecDocument } {
  const state = detectRepositoryState(repo, mode);
  if (state.kind !== "active") throw new Error(`expected active, got ${state.kind}`);
  return { state, document: state.document };
}

// --- A. Spec loads and activates --------------------------------------------

describe("dogfood repo: spec loads and activates", () => {
  it("activates with all seven declared agents, a digest, and advisory minimum", () => {
    const state = detectRepositoryState(repo, "advisory");
    expect(state.kind).toBe("active");
    if (state.kind !== "active") return;
    expect(state.minimumMode).toBe("advisory");
    expect(state.effectiveMode).toBe("advisory");
    expect(state.digest.short).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(state.agents.map((a) => a.id).sort()).toEqual([
      "api",
      "billing",
      "design-system",
      "docs",
      "infra",
      "web",
      "web-admin",
    ]);
  });

  it("computes the effective mode as the stricter of minimum and requested", () => {
    expect(detectRepositoryState(repo, "enforce").kind === "active" && detectRepositoryState(repo, "enforce")).toMatchObject({
      minimumMode: "advisory",
      requestedMode: "enforce",
      effectiveMode: "enforce",
    });
  });

  it("reports unmanaged once the spec is removed (state suite)", () => {
    unlinkSync(join(repo, ORCA_DIR, ORCA_SPEC_FILE));
    expect(detectRepositoryState(repo).kind).toBe("unmanaged");
  });

  it("goes blocked (invalid_spec) if the spec is corrupted, in both modes", () => {
    writeFileSync(join(repo, ORCA_DIR, ORCA_SPEC_FILE), "spec_version: '0.1'\n");
    expect(detectRepositoryState(repo, "advisory").kind).toBe("invalid_spec");
    expect(detectRepositoryState(repo, "enforce").kind).toBe("invalid_spec");
  });
});

// --- B. Resolver routing -----------------------------------------------------

describe("dogfood repo: resolver routing", () => {
  it("routes a nested target to the most-specific owner and its sibling to the broad owner", () => {
    const { document } = activeDoc();
    const res = resolve(document, ["apps/web/components/Button.tsx", "apps/web/src/app.tsx"]);
    expect(res.perTarget).toEqual([
      { path: "apps/web/components/Button.tsx", owner: "design-system", unowned: false, writable: true },
      { path: "apps/web/src/app.tsx", owner: "web", unowned: false, writable: true },
    ]);
  });

  it("keeps adjacent owners distinct across a shared textual prefix (web vs web-admin)", () => {
    const { document } = activeDoc();
    const res = resolve(document, ["apps/web-admin/src/dashboard.tsx"]);
    expect(res.perTarget[0]).toMatchObject({ owner: "web-admin", unowned: false, writable: true });
  });

  it("routes sibling-adjacent services to their own owners", () => {
    const { document } = activeDoc();
    const res = resolve(document, ["services/billing/invoice.ts", "services/api/server.ts"]);
    expect(res.perTarget.map((t) => t.owner)).toEqual(["billing", "api"]);
  });

  it("marks an agent-denied path owned-but-not-writable (agent deny)", () => {
    const { document } = activeDoc();
    const res = resolve(document, ["services/billing/generated/schema.ts"]);
    expect(res.perTarget[0]).toMatchObject({ owner: "billing", unowned: false, writable: false });
    expect(res.reasoning[0].writeDeny).toEqual({ scope: "services/billing/generated/**", source: "agent" });
  });

  it("marks a protected-denied path owned-but-not-writable (protected deny), sibling writable", () => {
    const { document } = activeDoc();
    const res = resolve(document, ["infra/production/deploy.tf", "infra/main.tf"]);
    expect(res.perTarget.map((t) => t.writable)).toEqual([false, true]);
    expect(res.reasoning[0].writeDeny).toEqual({ scope: "infra/production/**", source: "protected" });
  });

  it("flags a protected/secret path with no owner as unowned", () => {
    const { document } = activeDoc();
    const res = resolve(document, ["secrets/credentials.json"]);
    expect(res.perTarget[0]).toEqual({
      path: "secrets/credentials.json",
      owner: null,
      unowned: true,
      writable: false,
    });
    expect(res.unownedPaths).toEqual(["secrets/credentials.json"]);
  });

  it("compiles the billing grant: edit-expanded, cross-domain read, merged protected+agent denies", () => {
    const { document } = activeDoc();
    const billing = document.agents.find((a) => a.id === "billing")!;
    const grant = compileGrant(billing, document.protected_denies);
    expect(grant.read.allow).toEqual(["docs/shared/**", "services/billing/**"]);
    expect(grant.read.deny).toEqual(["secrets/**"]);
    expect(grant.write.allow).toEqual(["services/billing/**"]);
    expect(grant.write.deny).toEqual(["infra/production/**", "services/billing/generated/**"]);
    // A live grant is an immutable authority record (ADR 0008).
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.write.allow)).toBe(true);
  });

  it("splits a whole-repo target set into one delegation per owner, owner-id ordered", () => {
    const { document } = activeDoc();
    const res = resolve(document, [
      "apps/web/src/app.tsx",
      "apps/web/components/Button.tsx",
      "apps/web-admin/src/dashboard.tsx",
      "services/billing/invoice.ts",
      "services/api/server.ts",
      "infra/main.tf",
      "docs/shared/architecture.md",
    ]);
    expect(res.delegations.map((d) => d.owner)).toEqual([
      "api",
      "billing",
      "design-system",
      "docs",
      "infra",
      "web",
      "web-admin",
    ]);
    expect(res.unownedPaths).toEqual([]);
  });
});

// --- C. Steward governance per mode -----------------------------------------

describe("dogfood repo: steward governance", () => {
  it("blocks a parent write into an owned scope in enforce, flags it in advisory (names the owner)", () => {
    const { document } = activeDoc();
    const enforce = classifyWrite(document, "enforce", "apps/web/src/app.tsx");
    expect(enforce.verdict).toBe("block");
    expect(enforce.owner).toBe("web");
    const advisory = classifyWrite(document, "advisory", "apps/web/src/app.tsx");
    expect(advisory.verdict).toBe("flag");
    expect(advisory.owner).toBe("web");
  });

  it("blocks a protected-deny read in BOTH advisory and enforce (non-overridable)", () => {
    const { document } = activeDoc();
    for (const mode of ["advisory", "enforce"] as const) {
      const decision = classifyDiscovery(document, mode, { path: "secrets/credentials.json", symlink: false });
      expect(decision.verdict).toBe("block");
      expect(decision.reason).toContain("protected deny");
    }
  });

  it("allows an in-scope discovery read but governs one outside the narrowed scope (infra)", () => {
    const { document } = activeDoc();
    expect(classifyDiscovery(document, "enforce", { path: "apps/web/src/app.tsx", symlink: false }).verdict).toBe("allow");
    // infra/** is NOT in the steward discovery allow list — narrower than **.
    expect(classifyDiscovery(document, "enforce", { path: "infra/main.tf", symlink: false }).verdict).toBe("block");
    expect(classifyDiscovery(document, "advisory", { path: "infra/main.tf", symlink: false }).verdict).toBe("flag");
  });

  it("scope-checks pathless discovery as the repository root (out of this steward's scope)", () => {
    const { document } = activeDoc();
    // The empty path denotes the repository root; this steward's scope does not
    // include the bare root, so pathless discovery is governed (clarification).
    expect(classifyDiscovery(document, "enforce", { path: "", symlink: false }).verdict).toBe("block");
    expect(classifyDiscovery(document, "advisory", { path: "", symlink: false }).verdict).toBe("flag");
  });

  it("blocks the parent write through the real extension tool_call handler (enforce)", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never);
    const ctx = makeCtx(repo);
    await registered.commands.get("orca")!.handler("mode enforce", ctx);
    const result = (await registered.events.get("tool_call")!(writeEvent("services/billing/invoice.ts"), ctx)) as {
      block?: boolean;
      reason?: string;
    };
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("billing");
    expect(result?.reason).toContain("orca_delegate");
  });

  it("blocks a protected secrets read through the real extension in advisory mode", async () => {
    const { pi, registered } = makeApi();
    orcaPi(pi as never); // requested mode defaults to advisory
    const result = (await registered.events.get("tool_call")!(
      readEvent("secrets/credentials.json"),
      makeCtx(repo),
    )) as { block?: boolean; reason?: string };
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("protected deny");
  });
});

// --- D. Delegated-session enforcement + context injection -------------------

describe("dogfood repo: delegated-session grant enforcement", () => {
  function buildBilling(mode: OperatingMode = "enforce") {
    const { document } = activeDoc(mode);
    const grant = resolve(document, ["services/billing/invoice.ts"]).delegations[0].grant;
    const built = buildDelegationSession({
      document,
      owner: "billing",
      targets: ["services/billing/invoice.ts"],
      grant,
      task: "adjust invoice rounding",
      effectiveMode: mode,
      cwd: repo,
      parent: { model: undefined, thinkingLevel: "medium" },
    });
    if (!built.ok) throw new Error(`build failed: ${built.diagnostics.join("; ")}`);
    return built.config;
  }

  it("lets the owner write inside its grant and records the observed path", async () => {
    const config = buildBilling();
    const write = config.tools.find((t) => t.name === "write")!;
    await write.execute("t", { path: "services/billing/invoice.ts", content: "// edited" } as never, undefined, undefined, { cwd: repo } as never);
    expect(config.record.changedPaths.has("services/billing/invoice.ts")).toBe(true);
    expect(readFileSync(join(repo, "services", "billing", "invoice.ts"), "utf8")).toContain("// edited");
  });

  it("provably blocks an agent-denied write, a protected write, and an out-of-grant read", async () => {
    const config = buildBilling();
    const write = config.tools.find((t) => t.name === "write")!;
    const read = config.tools.find((t) => t.name === "read")!;
    // Agent write-deny inside the owned tree.
    await expect(
      write.execute("t", { path: "services/billing/generated/schema.ts", content: "x" } as never, undefined, undefined, { cwd: repo } as never),
    ).rejects.toThrow(/grant boundary/);
    // Protected write deny (also outside billing's write.allow).
    await expect(
      write.execute("t", { path: "infra/production/deploy.tf", content: "x" } as never, undefined, undefined, { cwd: repo } as never),
    ).rejects.toThrow(/grant boundary/);
    // Protected read deny.
    await expect(
      read.execute("t", { path: "secrets/credentials.json" } as never, undefined, undefined, { cwd: repo } as never),
    ).rejects.toThrow(/grant boundary/);
    // None of the denied targets were mutated.
    expect(readFileSync(join(repo, "services", "billing", "generated", "schema.ts"), "utf8")).toContain("GENERATED");
  });

  it("injects the declared optional instruction and context sources at build time", () => {
    // billing: optional context docs/shared/billing-glossary.md; steward: optional
    // instruction docs/steward.md — both exist in the repo, so both are injected.
    const config = buildBilling();
    expect(config.contextDigests.map((d) => d.path)).toContain("docs/shared/billing-glossary.md");
    expect(config.instructionDigests.map((d) => d.path)).toContain("docs/steward.md");
    expect(config.warnings).toEqual([]);

    // web: optional instruction docs/agents/web.md composes into the trusted prompt.
    const { document } = activeDoc();
    const grant = resolve(document, ["apps/web/src/app.tsx"]).delegations[0].grant;
    const web = buildDelegationSession({
      document,
      owner: "web",
      targets: ["apps/web/src/app.tsx"],
      grant,
      task: "tweak the shell",
      effectiveMode: "advisory",
      cwd: repo,
      parent: { model: undefined, thinkingLevel: "medium" },
    });
    expect(web.ok).toBe(true);
    if (!web.ok) return;
    expect(web.config.instructionDigests.map((d) => d.path)).toEqual(
      expect.arrayContaining(["docs/steward.md", "docs/agents/web.md"]),
    );
    expect(web.config.systemPrompt).toContain("Keep the application shell");
  });
});

// --- E. Delegation lifecycle through orca_delegate --------------------------

describe("dogfood repo: delegation lifecycle (scripted sessions)", () => {
  function install(overrides: Record<string, Script> = {}) {
    const { pi, registered } = makeApi();
    const { createSession, captured } = scriptedSessions(overrides);
    installOrca(pi as never, { createSession });
    return { registered, captured };
  }

  async function delegate(registered: Registered, task: string, paths: string[], ctx = makeCtx(repo)) {
    return registered.tools.get("orca_delegate")!.execute("d", { task, paths }, undefined, undefined, ctx);
  }

  it("runs a single-owner delegation end-to-end and persists it", async () => {
    const { registered, captured } = install();
    const result = await delegate(registered, "restyle the shell", ["apps/web/src/app.tsx"]);
    expect(captured.map((c) => c.owner)).toEqual(["web"]);
    expect(result.details?.kind).toBe("delegation");
    expect(readFileSync(join(repo, "apps", "web", "src", "app.tsx"), "utf8")).toContain("web edit");
    expect(registered.appended.filter((e) => e.customType === DELEGATION_ENTRY_TYPE)).toHaveLength(1);
  });

  it("splits a multi-owner task into sequential per-owner delegations (owner-id order)", async () => {
    const { registered, captured } = install();
    const result = await delegate(registered, "cross-cutting change", [
      "apps/web/src/app.tsx",
      "services/billing/invoice.ts",
      "apps/web-admin/src/dashboard.tsx",
    ]);
    // Owner-id ascending: billing < web < web-admin.
    expect(captured.map((c) => c.owner)).toEqual(["billing", "web", "web-admin"]);
    expect(result.details?.kind).toBe("delegation_sequence");
    if (result.details?.kind === "delegation_sequence") {
      expect(result.details.sequence.allCompleted).toBe(true);
    }
    expect(readFileSync(join(repo, "services", "billing", "invoice.ts"), "utf8")).toContain("billing edit");
    expect(readFileSync(join(repo, "apps", "web-admin", "src", "dashboard.tsx"), "utf8")).toContain("web-admin edit");
  });

  it("completes a scope-expansion round-trip: needs_scope, then a fresh re-delegation", async () => {
    // First delegation: web reports needs_scope for a billing path outside its grant.
    const first = install({
      web: async (config) => {
        await callSessionTool(config, "orca_checkpoint", {
          status: "needs_scope",
          summary: "the change also needs the billing invoice",
          scope_request: ["services/billing/invoice.ts"],
        });
      },
    });
    const paused = await delegate(first.registered, "wire the shell to billing", ["apps/web/src/app.tsx"]);
    const pausedBody = paused.content.map((c) => c.text).join("\n");
    expect(pausedBody).toContain("needs_scope");
    expect(pausedBody).toContain("FRESH grant");
    expect(pausedBody).toContain("services/billing/invoice.ts");

    // The steward re-delegates with the combined paths; the resolver re-runs and a
    // FRESH, separately-compiled grant is issued per owner — the paused grant is
    // never widened (ADR 0008). Both owners complete.
    const second = install();
    const resumed = await second.registered.tools.get("orca_delegate")!.execute(
      "d2",
      { task: "wire the shell to billing", paths: ["apps/web/src/app.tsx", "services/billing/invoice.ts"] },
      undefined,
      undefined,
      makeCtx(repo),
    );
    expect(resumed.details?.kind).toBe("delegation_sequence");
    expect(second.captured.map((c) => c.owner)).toEqual(["billing", "web"]);
    if (resumed.details?.kind === "delegation_sequence") {
      expect(resumed.details.sequence.allCompleted).toBe(true);
    }

    // Structural proof of non-widening: each resolve() compiles a fresh, frozen
    // grant object rather than mutating a shared one.
    const { document } = activeDoc();
    const g1 = resolve(document, ["apps/web/src/app.tsx"]).delegations[0].grant;
    const g2 = resolve(document, ["apps/web/src/app.tsx"]).delegations[0].grant;
    expect(g1).not.toBe(g2);
    expect(g1).toEqual(g2);
    expect(Object.isFrozen(g1)).toBe(true);
  });

  it("fails a delegation with an unowned target in enforce, proceeds with the owned subset in advisory", async () => {
    // enforce: the whole delegation is rejected pre-spawn (no session built).
    const enforce = install();
    const enfCtx = makeCtx(repo);
    await enforce.registered.commands.get("orca")!.handler("mode enforce", enfCtx);
    const blocked = await enforce.registered.tools.get("orca_delegate")!.execute(
      "d",
      { task: "touch a script too", paths: ["apps/web/src/app.tsx", "scripts/deploy.sh"] },
      undefined,
      undefined,
      enfCtx,
    );
    expect(blocked.details?.kind).toBe("unowned_blocked");
    expect(enforce.captured).toHaveLength(0);
    expect(existsSync(join(repo, "scripts", "deploy.sh"))).toBe(false);

    // advisory: the owned subset runs; the unowned path is reported as unmanaged.
    const advisory = install();
    const result = await delegate(advisory.registered, "touch a script too", [
      "apps/web/src/app.tsx",
      "scripts/deploy.sh",
    ]);
    expect(advisory.captured.map((c) => c.owner)).toEqual(["web"]);
    if (result.details?.kind === "delegation_sequence") {
      expect(result.details.unmanaged).toEqual(["scripts/deploy.sh"]);
      expect(result.details.sequence.allCompleted).toBe(true);
    }
  });
});
