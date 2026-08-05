import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import { resolve } from "../src/resolver";
import {
  runDelegationSequence,
  type DelegationInputs,
  type DelegationSession,
  type DelegationSessionConfig,
} from "../src/delegation";
import { makeGitRepo, makeStateRoot, snapshotTree, worktreePathsOf } from "./git-fixture";

/**
 * Transactional multi-owner sequences (staged-promotion plan, Phase 3): every
 * owner in a sequence works in ONE shared staged checkout, each completed owner's
 * authorized change is committed there so the next owner builds on it, and a
 * single cumulative patch reaches the user's checkout only after every owner
 * completes. Driven offline through the `createSession` seam against real git
 * repositories.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;
const doc = orcaspec.loadFixture("multi-owner");

/** One DelegationInputs per resolved owner, in the resolver's order. */
function orderedFor(cwd: string, paths: string[]): DelegationInputs[] {
  return resolve(doc, paths).delegations.map((delegation) => ({
    document: doc,
    owner: delegation.owner,
    targets: delegation.targets,
    grant: delegation.grant,
    task: "work",
    effectiveMode: "enforce" as const,
    cwd,
    parent: { model: fakeModel, thinkingLevel: "high" as const },
  }));
}

async function callTool(
  config: DelegationSessionConfig,
  name: string,
  params: unknown,
): Promise<void> {
  const tool = config.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`scripted agent referenced missing tool '${name}'`);
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

type Script = (config: DelegationSessionConfig) => Promise<void>;

/** Scripted sessions per owner, over the really-assembled grant-compiled tools. */
function sessions(scripts: Record<string, Script>) {
  const captured: DelegationSessionConfig[] = [];
  const abort = vi.fn();
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    captured.push(config);
    const script = scripts[config.owner];
    if (!script) throw new Error(`no script for owner '${config.owner}'`);
    return { prompt: () => script(config), abort };
  };
  return { createSession, captured, abort };
}

describe("a multi-owner sequence shares one staged checkout", () => {
  let repo: string;
  let stateRoot: string;
  beforeEach(() => {
    repo = makeGitRepo("orca-staged-seq-");
    stateRoot = makeStateRoot();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("lets a later owner build on the earlier owner's committed work, unseen by the checkout", async () => {
    const seen: Record<string, string> = {};
    const checkoutDuringWeb: Record<string, boolean> = {};
    const { createSession, captured } = sessions({
      billing: async (config) => {
        await callTool(config, "write", {
          path: "services/billing/x.rb",
          content: "PROVIDER = 'ready'\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "provider ready" });
      },
      web: async (config) => {
        // The earlier owner's work is right here, in this owner's own checkout.
        seen.billing = readFileSync(join(config.cwd, "services", "billing", "x.rb"), "utf8");
        // ...and has not reached the user's files.
        checkoutDuringWeb.billing = existsSync(join(repo, "services", "billing", "x.rb"));
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "<App/>\n" });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "consumed it" });
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    expect(sequence.allCompleted).toBe(true);
    expect(seen.billing).toBe("PROVIDER = 'ready'\n");
    expect(checkoutDuringWeb.billing).toBe(false);
    // One checkout for the whole sequence, not one per owner.
    expect(new Set(captured.map((config) => config.cwd)).size).toBe(1);
    // One promotion, after every owner completed, carrying both owners' work.
    expect(sequence.promotion.status).toBe("promoted");
    expect(sequence.promotion.appliedPaths).toEqual([
      "apps/web/app.tsx",
      "services/billing/x.rb",
    ]);
    expect(readFileSync(join(repo, "services", "billing", "x.rb"), "utf8")).toBe(
      "PROVIDER = 'ready'\n",
    );
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("<App/>\n");
  });

  it("leaves the checkout byte-identical at every step boundary and applies it once at the end", async () => {
    const before = snapshotTree(repo);
    // What the checkout looked like as each owner started working.
    const atStepStart: Record<string, Record<string, string>> = {};
    const worktreesDuring: Record<string, number> = {};
    const write: Script = async (config) => {
      atStepStart[config.owner] = snapshotTree(repo);
      worktreesDuring[config.owner] = worktreePathsOf(repo).length;
      await callTool(config, "write", {
        path: config.owner === "billing" ? "services/billing/x.rb" : "apps/web/app.tsx",
        content: `${config.owner}\n`,
      });
      await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
    };
    const { createSession } = sessions({ billing: write, web: write });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    // Neither owner ever saw a checkout that had been written to.
    expect(atStepStart.billing).toEqual(before);
    expect(atStepStart.web).toEqual(before);
    // One shared linked worktree for the whole sequence, not one per owner.
    expect(worktreesDuring).toEqual({ billing: 2, web: 2 });
    // The one promotion is what changed the checkout, and it changed exactly the
    // two authorized paths.
    expect(sequence.promotion.status).toBe("promoted");
    expect(snapshotTree(repo)).toEqual({
      ...before,
      "services/billing/x.rb": expect.any(String),
      "apps/web/app.tsx": expect.any(String),
    });
    expect(readFileSync(join(repo, "services", "billing", "x.rb"), "utf8")).toBe("billing\n");
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("web\n");
  });
});

describe("a sequence that does not finish promotes nothing", () => {
  let repo: string;
  let stateRoot: string;
  beforeEach(() => {
    repo = makeGitRepo("orca-staged-seq-");
    stateRoot = makeStateRoot();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  for (const status of ["failed", "blocked", "needs_scope"] as const) {
    it(`discards the completed owner's work too when a later owner ends '${status}'`, async () => {
      const before = snapshotTree(repo);
      const { createSession } = sessions({
        billing: async (config) => {
          await callTool(config, "write", {
            path: "services/billing/x.rb",
            content: "PROVIDER = 'ready'\n",
          });
          await callTool(config, "orca_checkpoint", { status: "completed", summary: "provider ready" });
        },
        web: async (config) => {
          await callTool(config, "write", { path: "apps/web/app.tsx", content: "half\n" });
          await callTool(config, "orca_checkpoint", { status, summary: `ended ${status}` });
        },
      });

      const sequence = await runDelegationSequence(
        orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
        { createSession, stateRoot },
      );

      // The sequence names the step that stopped it, in both places the steward reads.
      expect(sequence.allCompleted).toBe(false);
      expect(sequence.stoppedAt).toBe("web");
      expect(sequence.promotion.status).toBe("not_attempted");
      expect(sequence.promotion.diagnostics.join("\n")).toContain(`step 'web' ended '${status}'`);
      // Even the owner that completed contributed nothing to the checkout.
      expect(snapshotTree(repo)).toEqual(before);
      // ...and the whole cumulative attempt survives as one recoverable patch.
      const patch = readFileSync(sequence.promotion.patchPath!, "utf8");
      expect(patch).toContain("PROVIDER = 'ready'");
      expect(patch).toContain("half");
    });
  }

  it("promotes nothing when the parent cancels after an owner already completed", async () => {
    const before = snapshotTree(repo);
    const controller = new AbortController();
    const { createSession, abort } = sessions({
      billing: async (config) => {
        await callTool(config, "write", {
          path: "services/billing/x.rb",
          content: "PROVIDER = 'ready'\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "provider ready" });
      },
      web: async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "interrupted\n" });
        controller.abort(); // the parent cancels before this owner checkpoints
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot, signal: controller.signal },
    );

    expect(abort).toHaveBeenCalled();
    expect(sequence.cancelled).toBe(true);
    expect(sequence.promotion.status).toBe("not_attempted");
    expect(snapshotTree(repo)).toEqual(before);
    expect(readFileSync(sequence.promotion.patchPath!, "utf8")).toContain("PROVIDER = 'ready'");
  });

  it("stages nothing at all when the parent cancels before the first owner starts", async () => {
    const before = snapshotTree(repo);
    const { createSession, captured } = sessions({});

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot, signal: AbortSignal.abort() },
    );

    expect(captured).toHaveLength(0);
    expect(sequence.promotion.status).toBe("not_attempted");
    expect(sequence.promotion.patchPath).toBeUndefined();
    expect(snapshotTree(repo)).toEqual(before);
    // No checkout was created for a sequence that never ran an owner.
    expect(worktreePathsOf(repo)).toEqual([repo]);
    expect(existsSync(join(stateRoot, "worktrees"))).toBe(false);
  });
});

describe("each owner is held to its own grant inside the shared checkout", () => {
  let repo: string;
  let stateRoot: string;
  beforeEach(() => {
    repo = makeGitRepo("orca-staged-seq-");
    stateRoot = makeStateRoot();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("refuses each owner the other's paths while promoting both owners' own work", async () => {
    const refusals: Record<string, string> = {};
    const attempt = async (config: DelegationSessionConfig, path: string): Promise<void> => {
      try {
        await callTool(config, "write", { path, content: "not mine\n" });
        refusals[config.owner] = "allowed";
      } catch (error) {
        refusals[config.owner] = error instanceof Error ? error.message : String(error);
      }
    };
    const { createSession } = sessions({
      billing: async (config) => {
        // Sharing a checkout does not share authority: the other owner's path is
        // still outside this owner's grant.
        await attempt(config, "apps/web/app.tsx");
        await callTool(config, "write", { path: "services/billing/x.rb", content: "billing\n" });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "mine only" });
      },
      web: async (config) => {
        await attempt(config, "services/billing/x.rb");
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "web\n" });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "mine only" });
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    expect(refusals.billing).toMatch(/apps\/web\/app\.tsx/);
    expect(refusals.web).toMatch(/services\/billing\/x\.rb/);
    expect(sequence.promotion.status).toBe("promoted");
    expect(sequence.promotion.appliedPaths).toEqual([
      "apps/web/app.tsx",
      "services/billing/x.rb",
    ]);
    // Each owner's step claims only its own contribution to the one promotion.
    const byOwner = new Map(
      sequence.steps.flatMap((step) =>
        step.kind === "delegated" ? [[step.outcome.owner, step.outcome.promotion] as const] : [],
      ),
    );
    expect(byOwner.get("billing")!.appliedPaths).toEqual(["services/billing/x.rb"]);
    expect(byOwner.get("web")!.appliedPaths).toEqual(["apps/web/app.tsx"]);
  });

  it("refuses the whole sequence when an owner's staged change reaches outside its own grant", async () => {
    const before = snapshotTree(repo);
    const { createSession, captured } = sessions({
      billing: async (config) => {
        await callTool(config, "write", { path: "services/billing/x.rb", content: "mine\n" });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
        // Written straight into the shared checkout, AFTER the checkpoint's
        // reconciliation pass, so mutation accountability cannot have reverted it:
        // reaching the gate at all requires the layer above to have failed, and the
        // gate is what has to hold when it does.
        mkdirSync(join(config.cwd, "apps", "web"), { recursive: true });
        writeFileSync(join(config.cwd, "apps", "web", "app.tsx"), "smuggled by billing\n");
      },
      web: async (config) => {
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "never runs" });
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    // The unauthorized path fails the whole transaction, including the authorized
    // half of the same owner's change...
    expect(sequence.promotion.status).toBe("rejected");
    expect(sequence.promotion.rejectedPaths).toEqual(["apps/web/app.tsx"]);
    expect(snapshotTree(repo)).toEqual(before);
    // ...the later owner is never started on top of work that cannot be promoted...
    expect(captured.map((config) => config.owner)).toEqual(["billing"]);
    expect(sequence.stoppedAt).toBe("billing");
    // ...and the attempt is preserved as evidence, naming what it smuggled.
    expect(readFileSync(sequence.promotion.patchPath!, "utf8")).toContain("smuggled by billing");
  });
});
