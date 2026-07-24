import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { DomainAgent, OrcaSpecDocument } from "orcaspec";
import { compileGrant, type CompiledGrant } from "../src/resolver";
import {
  DELEGATION_SECTIONS,
  buildDelegationSession,
  runDelegation,
  type DelegationInputs,
  type DelegationSession,
  type DelegationSessionConfig,
} from "../src/delegation";
import { CONTEXT_BUDGET_BYTES } from "../src/context-injection";

/**
 * Delegated-session assembly (no prompting) and a scripted end-to-end run driven
 * through an injected `createSession` seam — no live model, which conformance
 * never requires (ADR 0078, 0076, 0083; PRD "Testing and Conformance").
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;

function webAgent(overrides: Partial<DomainAgent> = {}): DomainAgent {
  return {
    id: "web",
    name: "Web",
    description: "Owns the web application.",
    ownership: ["apps/web/**"],
    permissions: { read: { allow: ["docs/**"] }, edit: { allow: ["apps/web/**"] } },
    ...overrides,
  };
}

function doc(agent: DomainAgent, stewardOverrides: Partial<OrcaSpecDocument["steward"]> = {}): OrcaSpecDocument {
  return {
    spec_version: "0.1",
    repository: { id: "018f4f72-0000-7000-8000-0000000000aa" },
    administration: { approvers: [{ provider: "orca-local", principal: "test" }] },
    steward: { discovery: { read: { allow: ["**"], deny: [] } }, ...stewardOverrides },
    protected_denies: {},
    agents: [agent],
  };
}

function inputsFor(
  cwd: string,
  agent: DomainAgent,
  overrides: Partial<DelegationInputs> = {},
): DelegationInputs {
  const grant: CompiledGrant = compileGrant(agent, {});
  return {
    document: doc(agent),
    owner: agent.id,
    targets: ["apps/web/app.tsx"],
    grant,
    task: "restyle the button",
    originalRequest: "Please make the button blue",
    effectiveMode: "enforce",
    cwd,
    parent: { model: fakeModel, thinkingLevel: "high" },
    ...overrides,
  };
}

describe("buildDelegationSession assembly", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-delg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds exactly the grant tools + bash + orca_checkpoint, nothing else", () => {
    const built = buildDelegationSession(inputsFor(dir, webAgent()));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.config.toolNames).toEqual(["read", "write", "edit", "bash", "orca_checkpoint"]);
  });

  it("composes the operator handoff, grant, write boundary, and checkpoint expectation root-first", () => {
    const built = buildDelegationSession(inputsFor(dir, webAgent()));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const prompt = built.config.systemPrompt;

    // Root-first section order.
    const indices = DELEGATION_SECTIONS.map((heading) => prompt.indexOf(heading));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));

    // Write boundary (ADR 0079) names the enforced write scope and the bash gap.
    expect(prompt).toContain("WRITE BOUNDARY");
    expect(prompt).toContain("apps/web/**");
    expect(prompt).toMatch(/bash.*not enforced|NOT enforced/i);

    // Operator handoff (original request, scoped assignment, authorized paths/ops).
    expect(prompt).toContain("Original request: Please make the button blue");
    expect(prompt).toContain("Scoped assignment: restyle the button");
    expect(prompt).toContain("apps/web/app.tsx");
    expect(prompt).toContain("write.allow: apps/web/**");

    // Expected checkpoint output.
    expect(prompt).toContain("orca_checkpoint");
    expect(prompt).toContain("Effective mode: enforce");
  });

  it("runs on the parent model and thinking level (no per-agent model config)", () => {
    const built = buildDelegationSession(
      inputsFor(dir, webAgent(), { parent: { model: fakeModel, thinkingLevel: "low" } }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.config.model).toBe(fakeModel);
    expect(built.config.thinkingLevel).toBe("low");
  });

  it("injects trusted instructions into the prompt and untrusted context as a labeled context file", () => {
    mkdirSync(join(dir, ".orca", "web"), { recursive: true });
    writeFileSync(join(dir, ".orca", "web", "inst.md"), "Follow the house style guide.");
    writeFileSync(join(dir, ".orca", "web", "ctx.md"), "Reference palette: blue #0af.");
    const agent = webAgent({
      instructions: { required: [".orca/web/inst.md"], optional: [] },
      context: { required: [], optional: [".orca/web/ctx.md"] },
    });

    const built = buildDelegationSession(inputsFor(dir, agent));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.config.systemPrompt).toContain("Follow the house style guide.");
    expect(built.config.systemPrompt).toContain("[trusted]");

    expect(built.config.contextFiles).toHaveLength(1);
    const ctxFile = built.config.contextFiles[0];
    expect(ctxFile.content).toContain("Reference palette: blue #0af.");
    expect(ctxFile.content).toMatch(/untrusted context/i);
    expect(built.config.instructionDigests[0]?.path).toBe(".orca/web/inst.md");
  });

  it("fails before spawning when a required instruction source is missing", () => {
    const agent = webAgent({ instructions: { required: [".orca/web/missing.md"], optional: [] } });
    const built = buildDelegationSession(inputsFor(dir, agent));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.kind).toBe("required_missing");
    expect(built.diagnostics.join("\n")).toContain(".orca/web/missing.md");
  });

  it("warns (does not fail) when an optional source is missing", () => {
    mkdirSync(join(dir, ".orca", "web"), { recursive: true });
    writeFileSync(join(dir, ".orca", "web", "inst.md"), "required present");
    const agent = webAgent({
      instructions: { required: [".orca/web/inst.md"], optional: [] },
      context: { required: [], optional: [".orca/web/absent.md"] },
    });
    const built = buildDelegationSession(inputsFor(dir, agent));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.config.warnings.map((w) => w.path)).toContain(".orca/web/absent.md");
  });

  it("fails with diagnostics on an oversized bundle rather than truncating", () => {
    mkdirSync(join(dir, ".orca", "web"), { recursive: true });
    writeFileSync(join(dir, ".orca", "web", "huge.md"), "x".repeat(CONTEXT_BUDGET_BYTES + 1024));
    const agent = webAgent({ instructions: { required: [".orca/web/huge.md"], optional: [] } });
    const built = buildDelegationSession(inputsFor(dir, agent));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.kind).toBe("oversized");
    expect(built.diagnostics.join("\n")).toMatch(/budget/i);
  });

  it("renders steward instruction sources when declared", () => {
    mkdirSync(join(dir, ".orca"), { recursive: true });
    writeFileSync(join(dir, ".orca", "steward.md"), "Repository-wide steward guidance.");
    const inputs = inputsFor(dir, webAgent());
    inputs.document = doc(webAgent(), {
      instructions: { required: [".orca/steward.md"], optional: [] },
      context: { required: [], optional: [] },
      discovery: { read: { allow: ["**"], deny: [] } },
    });
    const built = buildDelegationSession(inputs);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.config.systemPrompt).toContain("Repository-wide steward guidance.");
  });
});

// --- Scripted end-to-end via the createSession seam --------------------------

/** A fake session driven by a script over the assembled tools; records abort. */
function scriptedSession(
  script: (config: DelegationSessionConfig) => Promise<void>,
): { createSession: (config: DelegationSessionConfig) => Promise<DelegationSession>; abort: ReturnType<typeof vi.fn> } {
  const abort = vi.fn();
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => ({
    prompt: () => script(config),
    abort,
  });
  return { createSession, abort };
}

async function callTool(
  config: DelegationSessionConfig,
  name: string,
  params: unknown,
): Promise<void> {
  const tool = config.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`scripted agent referenced missing tool '${name}'`);
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

describe("runDelegation end-to-end (scripted, offline)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-run-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes within the grant and completes with an observed manifest", async () => {
    const { createSession } = scriptedSession(async (config) => {
      await callTool(config, "write", { path: "apps/web/app.tsx", content: "<button>ok</button>" });
      await callTool(config, "orca_checkpoint", { status: "completed", summary: "restyled" });
    });

    const result = await runDelegation(inputsFor(dir, webAgent()), { createSession });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Edited the working tree in place (ADR 0077).
    expect(readFileSync(join(dir, "apps", "web", "app.tsx"), "utf8")).toContain("<button>ok</button>");

    const cp = result.outcome.checkpoint;
    expect(cp.status).toBe("completed");
    expect(cp.synthesized).toBe(false);
    expect(cp.changedPaths).toEqual(["apps/web/app.tsx"]);
    expect(result.outcome.appendEntry.kind).toBe("orca_delegation");
    expect(result.outcome.appendEntry.changedPaths).toEqual(["apps/web/app.tsx"]);
  });

  it("finalizes child evidence with runtime and checkpoint outcomes", async () => {
    const finish = vi.fn();
    const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => ({
      prompt: async () => {
        await callTool(config, "write", {
          path: "apps/web/app.tsx",
          content: "<button>observed</button>",
        });
        await callTool(config, "orca_checkpoint", {
          status: "completed",
          summary: "observed",
        });
      },
      abort: vi.fn(),
      finish,
    });

    const result = await runDelegation(inputsFor(dir, webAgent()), { createSession });

    expect(result.ok).toBe(true);
    expect(finish).toHaveBeenCalledWith({
      status: "completed",
      checkpointStatus: "completed",
      changedPaths: ["apps/web/app.tsx"],
    });
  });

  it("synthesizes a failed checkpoint (with observed paths) when the session ends statusless", async () => {
    const { createSession } = scriptedSession(async (config) => {
      await callTool(config, "write", { path: "apps/web/app.tsx", content: "half done" });
      // No orca_checkpoint call — the session just ends.
    });

    const result = await runDelegation(inputsFor(dir, webAgent()), { createSession });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.checkpoint.status).toBe("failed");
    expect(result.outcome.checkpoint.synthesized).toBe(true);
    expect(result.outcome.checkpoint.changedPaths).toEqual(["apps/web/app.tsx"]);
  });

  it("attaches only observed mutations, never what the agent claims in the summary", async () => {
    const { createSession } = scriptedSession(async (config) => {
      // No write tool call at all; the summary claims changes.
      await callTool(config, "orca_checkpoint", {
        status: "completed",
        summary: "changed apps/web/app.tsx and apps/web/theme.ts",
      });
    });
    const result = await runDelegation(inputsFor(dir, webAgent()), { createSession });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.checkpoint.changedPaths).toEqual([]);
  });

  it("propagates parent cancellation to the session's abort", async () => {
    const controller = new AbortController();
    const { createSession, abort } = scriptedSession(async () => {
      controller.abort(); // parent cancels mid-run
    });
    const result = await runDelegation(inputsFor(dir, webAgent()), {
      createSession,
      signal: controller.signal,
    });
    expect(abort).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A cancelled, checkpoint-less session still ends with a status (ADR 0083).
    expect(result.outcome.checkpoint.synthesized).toBe(true);
  });

  it("aborts immediately when the parent signal is already aborted", async () => {
    const abort = vi.fn();
    const finish = vi.fn();
    const createSession = async (): Promise<DelegationSession> => ({
      prompt: async () => {},
      abort,
      finish,
    });
    const result = await runDelegation(inputsFor(dir, webAgent()), {
      createSession,
      signal: AbortSignal.abort(),
    });
    expect(abort).toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not spawn a session when a required source is missing (pre-spawn failure)", async () => {
    const spawn = vi.fn(async (): Promise<DelegationSession> => ({ prompt: async () => {}, abort: vi.fn() }));
    const agent = webAgent({ instructions: { required: [".orca/web/missing.md"], optional: [] } });
    const result = await runDelegation(inputsFor(dir, agent), { createSession: spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("required_missing");
  });
});
