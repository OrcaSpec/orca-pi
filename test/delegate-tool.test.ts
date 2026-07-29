import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { detectRepositoryState, ORCA_DIR, ORCA_SPEC_FILE } from "../src/state";
import {
  createDelegateTool,
  type DelegateDeps,
  type DelegateToolInput,
  type ResolveToolDetails,
} from "../src/tools";
import type { DelegationSession, DelegationSessionConfig } from "../src/delegation";
import type { OperatingMode } from "../src/mode";

/**
 * The full delegation lifecycle through `orca_delegate` (Phase 7): the four
 * terminal statuses round-tripping to the steward, the scope-expansion recipe on
 * needs_scope (ADR 0008), multi-owner sequential splits with early stop (ADR
 * 0006/0009/0077), unowned-target handling by mode (ADR 0012), and cancellation
 * (ADR 0083). Offline — the session factory is a scripted, owner-aware fake.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;

const textOf = (result: AgentToolResult<ResolveToolDetails>): string =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

async function callTool(config: DelegationSessionConfig, name: string, params: unknown): Promise<void> {
  const tool = config.tools.find((t) => t.name === name)!;
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

/** A path inside each fixture owner's write grant, for scripted writes. */
const OWNED: Record<string, string> = {
  billing: "services/billing/x.rb",
  web: "apps/web/app.tsx",
  "design-system": "apps/web/components/button.tsx",
  infra: "infra/main.tf",
};

type Script = (config: DelegationSessionConfig) => Promise<void>;

/** Write the owner's path, then checkpoint completed. */
const complete: Script = async (config) => {
  await callTool(config, "write", { path: OWNED[config.owner], content: `// ${config.owner}` });
  await callTool(config, "orca_checkpoint", {
    status: "completed",
    summary: `${config.owner} done`,
    validation_activities: [
      {
        kind: "test",
        name: `${config.owner} focused tests`,
        status: "passed",
        summary: "passed",
      },
    ],
  });
};

/** Checkpoint with a non-completed status (no write), plus optional extra params. */
function ends(status: string, extra: Record<string, unknown> = {}): Script {
  return async (config) => {
    await callTool(config, "orca_checkpoint", { status, summary: `${config.owner}: ${status}`, ...extra });
  };
}

/** A scripted, owner-keyed session factory that records the configs it built. */
function sessions(scripts: Record<string, Script> = {}, fallback: Script = complete) {
  const captured: DelegationSessionConfig[] = [];
  const abort = vi.fn();
  const createSession = vi.fn(async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    captured.push(config);
    const script = scripts[config.owner] ?? fallback;
    return { prompt: () => script(config), abort };
  });
  return { createSession, captured, abort };
}

describe("orca_delegate full lifecycle", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-deleg7-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSpec(fixture: string): void {
    mkdirSync(join(dir, ORCA_DIR), { recursive: true });
    writeFileSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), orcaspec.loadFixtureSource(fixture));
  }

  function run(
    paths: string[],
    createSession: DelegateDeps["createSession"],
    opts: {
      mode?: OperatingMode;
      task?: string;
      onDelegation?: DelegateDeps["onDelegation"];
      onUnowned?: DelegateDeps["onUnowned"];
      signal?: AbortSignal;
      assignments?: DelegateToolInput["assignments"] | null;
      stewardDecision?: DelegateToolInput["steward_decision"];
    } = {},
  ): Promise<AgentToolResult<ResolveToolDetails>> {
    const deps: DelegateDeps = {
      getState: (cwd) => detectRepositoryState(cwd, opts.mode ?? "enforce"),
      getThinkingLevel: () => "medium",
      createSession,
      onDelegation: opts.onDelegation,
      onUnowned: opts.onUnowned,
    };
    const ownerFor = (path: string): string | undefined => {
      if (path.startsWith("apps/web/components/")) return "design-system";
      if (path.startsWith("apps/web/")) return "web";
      if (path.startsWith("services/billing/")) return "billing";
      if (path.startsWith("infra/")) return "infra";
      return undefined;
    };
    const grouped = new Map<string, string[]>();
    for (const path of paths) {
      const owner = ownerFor(path);
      if (!owner) continue;
      grouped.set(owner, [...(grouped.get(owner) ?? []), path]);
    }
    const owners = [...grouped.keys()].sort();
    const inferredAssignments =
      owners.length > 1
        ? owners.map((owner, index) => ({
            owner,
            task: `${owner} owner-specific work`,
            paths: grouped.get(owner)!,
            depends_on: index === 0 ? [] : [owners[index - 1]],
          }))
        : undefined;
    const assignments =
      opts.assignments === null ? undefined : (opts.assignments ?? inferredAssignments);
    return createDelegateTool(deps).execute(
      "d1",
      {
        task: opts.task ?? "do the work",
        paths,
        assignments,
        steward_decision: opts.stewardDecision,
      },
      opts.signal,
      undefined,
      { cwd: dir, model: fakeModel } as never,
    );
  }

  // --- Single-owner + four statuses ---------------------------------------

  it("runs a single-owner delegation end-to-end and reports the observed manifest", async () => {
    writeSpec("multi-owner");
    const { createSession, captured } = sessions();
    const onDelegation = vi.fn();
    const result = await run(["apps/web/app.tsx"], createSession, { onDelegation });
    expect(captured).toHaveLength(1);
    expect(readFileSync(join(dir, "apps", "web", "app.tsx"), "utf8")).toContain("web");
    expect(result.details?.kind).toBe("delegation");
    if (result.details?.kind !== "delegation") return;
    expect(result.details.outcome.owner).toBe("web");
    expect(result.details.outcome.checkpoint.status).toBe("completed");
    expect(result.details.outcome.checkpoint.changedPaths).toEqual(["apps/web/app.tsx"]);
    expect(onDelegation).toHaveBeenCalledTimes(1);
  });

  it("persists an explicit ready steward decision only after all integration audits pass", async () => {
    writeSpec("multi-owner");
    const { createSession } = sessions();
    const result = await run(["apps/web/app.tsx"], createSession, {
      stewardDecision: { status: "ready", reason: "reviewed combined change" },
    });
    expect(result.details?.kind).toBe("delegation");
    if (result.details?.kind !== "delegation") return;
    expect(result.details.record.integration?.decision).toEqual({
      status: "ready",
      reason: "reviewed combined change",
      acknowledgedValidationGaps: [],
    });
    expect(result.details.record.integration?.ownershipAudit.compliant).toBe(true);
    expect(result.details.record.integration?.dependencyAudit.complete).toBe(true);
    expect(result.details.record.integration?.validationAudit.verified).toBe(true);
  });

  it("passes the parent model and thinking level into the session (ADR 0076)", async () => {
    writeSpec("multi-owner");
    const { createSession, captured } = sessions();
    await run(["apps/web/app.tsx"], createSession);
    expect(captured[0].model).toBe(fakeModel);
    expect(captured[0].thinkingLevel).toBe("medium");
  });

  it("surfaces a needs_scope outcome with the scope request and re-delegation recipe (ADR 0008)", async () => {
    writeSpec("multi-owner");
    const { createSession } = sessions({
      web: ends("needs_scope", { scope_request: ["services/billing/x.rb"] }),
    });
    const result = await run(["apps/web/app.tsx"], createSession);
    expect(result.details?.kind).toBe("delegation");
    if (result.details?.kind !== "delegation") return;
    expect(result.details.outcome.checkpoint.status).toBe("needs_scope");
    expect(result.details.outcome.checkpoint.scopeRequest).toEqual(["services/billing/x.rb"]);
    const body = textOf(result);
    expect(body).toContain("needs_scope");
    expect(body).toContain("Scope requested");
    expect(body).toContain("services/billing/x.rb");
    expect(body).toContain("FRESH grant");
    expect(body).toContain("Suggested combined paths");
  });

  it("surfaces a blocked outcome with summary, remaining risks, and the partial manifest", async () => {
    writeSpec("multi-owner");
    const { createSession } = sessions({
      web: async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "partial" });
        await callTool(config, "orca_checkpoint", {
          status: "blocked",
          summary: "cannot finish without a design decision",
          remaining_risks: ["left half-applied change on disk"],
        });
      },
    });
    const result = await run(["apps/web/app.tsx"], createSession);
    const body = textOf(result);
    expect(body).toContain("blocked");
    expect(body).toContain("cannot finish without a design decision");
    expect(body).toContain("Remaining risks");
    expect(body).toContain("left half-applied change on disk");
    expect(body).toContain("apps/web/app.tsx");
    if (result.details?.kind !== "delegation") return;
    expect(result.details.outcome.checkpoint.changedPaths).toEqual(["apps/web/app.tsx"]);
    expect(result.details.outcome.checkpoint.remainingRisks).toEqual(["left half-applied change on disk"]);
  });

  it("surfaces a failed outcome distinctly", async () => {
    writeSpec("multi-owner");
    const { createSession } = sessions({ web: ends("failed") });
    const result = await run(["apps/web/app.tsx"], createSession);
    expect(textOf(result)).toContain("failed");
    if (result.details?.kind !== "delegation") return;
    expect(result.details.outcome.checkpoint.status).toBe("failed");
  });

  it("synthesizes a failed checkpoint through the tool when a session ends statusless (ADR 0083)", async () => {
    writeSpec("multi-owner");
    const { createSession } = sessions({
      web: async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "half" });
        // No orca_checkpoint call — the session just ends.
      },
    });
    const result = await run(["apps/web/app.tsx"], createSession);
    if (result.details?.kind !== "delegation") return;
    expect(result.details.outcome.checkpoint.status).toBe("failed");
    expect(result.details.outcome.checkpoint.synthesized).toBe(true);
    expect(result.details.outcome.checkpoint.changedPaths).toEqual(["apps/web/app.tsx"]);
    expect(textOf(result)).toContain("synthesized");
  });

  // --- Multi-owner sequential splits --------------------------------------

  it("rejects ambiguous multi-owner shorthand before starting a child", async () => {
    writeSpec("multi-owner");
    const { createSession, captured } = sessions();
    const result = await run(
      ["apps/web/app.tsx", "services/billing/x.rb"],
      createSession,
      { assignments: null },
    );
    expect(result.details?.kind).toBe("assignment_invalid");
    expect(textOf(result)).toContain("one explicit assignment per resolved owner");
    expect(captured).toHaveLength(0);
  });

  it("splits a multi-owner task into sequential per-owner delegations (owner-id order)", async () => {
    writeSpec("multi-owner");
    const order: string[] = [];
    const track: Script = async (config) => {
      order.push(config.owner);
      await complete(config);
    };
    const { createSession, captured } = sessions({ billing: track, web: track });
    const onDelegation = vi.fn();
    const result = await run(["apps/web/app.tsx", "services/billing/x.rb"], createSession, { onDelegation });

    // The resolver orders owners ascending: billing before web.
    expect(order).toEqual(["billing", "web"]);
    expect(captured.map((config) => config.owner)).toEqual(["billing", "web"]);
    expect(result.details?.kind).toBe("delegation_sequence");
    if (result.details?.kind !== "delegation_sequence") return;
    expect(result.details.sequence.allCompleted).toBe(true);
    expect(onDelegation).toHaveBeenCalledTimes(2);
    expect(captured.every((config) => config.grantId?.startsWith("sha256:"))).toBe(true);
    expect(captured.every((config) => config.sequenceId === captured[0].sequenceId)).toBe(true);
    expect(new Set(captured.map((config) => config.stepId)).size).toBe(2);
    expect(new Set(captured.map((config) => config.delegationId)).size).toBe(2);
    expect(new Set(captured.map((config) => config.childSessionId)).size).toBe(2);
    expect(captured[0].systemPrompt).toContain("write.allow: services/billing/x.rb");
    expect(captured[1].systemPrompt).toContain("write.allow: apps/web/app.tsx");

    // Each owner wrote only its own path.
    expect(readFileSync(join(dir, "services", "billing", "x.rb"), "utf8")).toContain("billing");
    expect(readFileSync(join(dir, "apps", "web", "app.tsx"), "utf8")).toContain("web");
  });

  it("runs a 3-owner sequence in owner-id order", async () => {
    writeSpec("multi-owner");
    const order: string[] = [];
    const track: Script = async (config) => {
      order.push(config.owner);
      await complete(config);
    };
    const { createSession } = sessions({ billing: track, infra: track, web: track });
    const result = await run(
      ["apps/web/app.tsx", "services/billing/x.rb", "infra/main.tf"],
      createSession,
    );
    expect(order).toEqual(["billing", "infra", "web"]);
    if (result.details?.kind !== "delegation_sequence") return;
    expect(result.details.sequence.allCompleted).toBe(true);
  });

  it("stops the sequence on the first non-completed status and leaves later owners not run", async () => {
    writeSpec("multi-owner");
    const { createSession, captured } = sessions({ billing: ends("blocked"), web: complete });
    const result = await run(["apps/web/app.tsx", "services/billing/x.rb"], createSession);

    // billing (first) blocked → web is never spawned.
    expect(captured.map((config) => config.owner)).toEqual(["billing"]);
    if (result.details?.kind !== "delegation_sequence") return;
    const seq = result.details.sequence;
    expect(seq.stoppedAt).toBe("billing");
    expect(seq.cancelled).toBe(false);
    expect(seq.allCompleted).toBe(false);
    expect(seq.steps[0].kind).toBe("delegated");
    expect(seq.steps[1].kind).toBe("not_run");
    if (seq.steps[1].kind === "not_run") {
      expect(seq.steps[1].reason).toBe("dependency_blocked");
      expect(seq.steps[1].blockedBy).toEqual(["billing"]);
    }
    expect(textOf(result)).toContain("not run");
  });

  it("stops on needs_scope mid-sequence and shows the stopping owner's re-delegation recipe", async () => {
    writeSpec("multi-owner");
    const { createSession } = sessions({
      billing: ends("needs_scope", { scope_request: ["infra/main.tf"] }),
      web: complete,
    });
    const result = await run(["apps/web/app.tsx", "services/billing/x.rb"], createSession);
    const body = textOf(result);
    expect(body).toContain("needs_scope");
    expect(body).toContain("infra/main.tf");
    expect(body).toContain("FRESH grant");
    if (result.details?.kind !== "delegation_sequence") return;
    expect(result.details.sequence.stoppedAt).toBe("billing");
  });

  // --- Unowned targets by mode (ADR 0012) ---------------------------------

  it("fails a delegation with an unowned target in enforce mode before spawning", async () => {
    writeSpec("multi-owner"); // minimum_mode: enforce
    const { createSession, captured } = sessions();
    const onUnowned = vi.fn();
    const result = await run(["apps/web/app.tsx", "scripts/deploy.sh"], createSession, { onUnowned });

    expect(captured).toHaveLength(0);
    expect(result.details?.kind).toBe("unowned_blocked");
    if (result.details?.kind !== "unowned_blocked") return;
    expect(result.details.unownedPaths).toEqual(["scripts/deploy.sh"]);
    expect(textOf(result)).toContain("scripts/deploy.sh");
    expect(onUnowned).toHaveBeenCalledWith(["scripts/deploy.sh"], "enforce", "blocked");
    // The owned path was not written either — the whole delegation is rejected.
    expect(existsSync(join(dir, "apps", "web", "app.tsx"))).toBe(false);
  });

  it("proceeds with the owned subset and marks unowned paths unmanaged in advisory mode", async () => {
    writeSpec("nested-ownership"); // minimum_mode: advisory
    const { createSession, captured } = sessions();
    const onUnowned = vi.fn();
    const result = await run(["apps/web/app.tsx", "scripts/deploy.sh"], createSession, {
      mode: "advisory",
      onUnowned,
    });

    expect(captured.map((config) => config.owner)).toEqual(["web"]);
    expect(result.details?.kind).toBe("delegation_sequence");
    if (result.details?.kind !== "delegation_sequence") return;
    expect(result.details.unmanaged).toEqual(["scripts/deploy.sh"]);
    expect(result.details.sequence.allCompleted).toBe(true);
    expect(onUnowned).toHaveBeenCalledWith(["scripts/deploy.sh"], "advisory", "flagged");
    const body = textOf(result);
    expect(body).toContain("Unmanaged targets (advisory)");
    expect(body).toContain("scripts/deploy.sh");
    expect(readFileSync(join(dir, "apps", "web", "app.tsx"), "utf8")).toContain("web");
  });

  it("mixes multi-owner delegations with unmanaged paths in advisory mode", async () => {
    writeSpec("nested-ownership");
    const { createSession, captured } = sessions();
    const result = await run(
      ["apps/web/app.tsx", "apps/web/components/button.tsx", "scripts/deploy.sh"],
      createSession,
      { mode: "advisory" },
    );
    // design-system (nested) before web; unowned handled separately.
    expect(captured.map((config) => config.owner)).toEqual(["design-system", "web"]);
    if (result.details?.kind !== "delegation_sequence") return;
    expect(result.details.unmanaged).toEqual(["scripts/deploy.sh"]);
    expect(result.details.sequence.allCompleted).toBe(true);
  });

  it("delegates nothing when every target is unowned in advisory mode", async () => {
    writeSpec("nested-ownership");
    const { createSession, captured } = sessions();
    const result = await run(["scripts/a.sh", "scripts/b.sh"], createSession, { mode: "advisory" });
    expect(captured).toHaveLength(0);
    expect(result.details?.kind).toBe("all_unmanaged");
    if (result.details?.kind !== "all_unmanaged") return;
    expect(result.details.unownedPaths).toEqual(["scripts/a.sh", "scripts/b.sh"]);
  });

  // --- Cancellation (ADR 0083) --------------------------------------------

  it("does not spawn any session when the parent signal is already aborted", async () => {
    writeSpec("multi-owner");
    const { createSession, captured } = sessions();
    const result = await run(["apps/web/app.tsx", "services/billing/x.rb"], createSession, {
      signal: AbortSignal.abort(),
    });
    expect(captured).toHaveLength(0);
    expect(result.details?.kind).toBe("delegation_sequence");
    if (result.details?.kind !== "delegation_sequence") return;
    expect(result.details.sequence.cancelled).toBe(true);
    expect(result.details.sequence.steps.every((step) => step.kind === "not_run")).toBe(true);
  });
});
