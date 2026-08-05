import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { promotionDetailLines, promotionHeadline } from "../src/render";
import type { PromotionRecord } from "../src/staging";
import { git, makeGitRepo, makeStateRoot, snapshotTree } from "./git-fixture";

/**
 * The completed-owners patch on `needs_scope` (hardening plan, Phase 5).
 *
 * A sequence that stops because an owner needs paths outside its grant promotes
 * nothing, exactly as before — but the owners that DID complete had their work
 * authorized and accepted in staging, and the steward is about to re-delegate the
 * same task with a wider target set. So a second patch is preserved beside the
 * cumulative evidence patch: the completed owners' staged commits alone. The two
 * artifacts answer different questions, and these tests pin the difference —
 * evidence of the whole attempt versus reusable accepted work — as well as the
 * boundary that makes the second one trustworthy: nothing from the owner that
 * stopped the sequence is in it.
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
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    captured.push(config);
    const script = scripts[config.owner];
    if (!script) throw new Error(`no script for owner '${config.owner}'`);
    return { prompt: () => script(config), abort: vi.fn() };
  };
  return { createSession, captured };
}

/** What a steward reads about the promotion, through the one shared renderer. */
function promotionText(promotion: PromotionRecord): string {
  return [promotionHeadline(promotion), ...promotionDetailLines(promotion)].join("\n");
}

/** Every patch file the sequence left in the state root, by file name. */
function patchesIn(stateRoot: string): string[] {
  try {
    return readdirSync(join(stateRoot, "patches")).sort();
  } catch {
    return [];
  }
}

describe("a sequence that stops at needs_scope after an owner completed", () => {
  let repo: string;
  let stateRoot: string;
  beforeEach(() => {
    repo = makeGitRepo("orca-accepted-");
    stateRoot = makeStateRoot();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("preserves the completed owner's accepted work as a patch of its own", async () => {
    const before = snapshotTree(repo);
    const { createSession } = sessions({
      "design-system": async (config) => {
        await callTool(config, "write", {
          path: "apps/web/components/button.tsx",
          content: "<Button/>\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "button added" });
      },
      web: async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "half-built\n" });
        await callTool(config, "orca_checkpoint", {
          status: "needs_scope",
          summary: "the API client is outside my grant",
          scope_request: ["services/billing/client.rb"],
        });
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "apps/web/components/button.tsx"]),
      { createSession, stateRoot },
    );

    // Nothing about the stop changes: no promotion, checkout untouched.
    expect(sequence.stoppedAt).toBe("web");
    expect(sequence.promotion.status).toBe("not_attempted");
    expect(snapshotTree(repo)).toEqual(before);

    // The cumulative evidence patch still holds everything, the stopping owner's
    // unfinished work included.
    const evidence = readFileSync(sequence.promotion.patchPath!, "utf8");
    expect(evidence).toContain("<Button/>");
    expect(evidence).toContain("half-built");

    // Beside it, a second patch of exactly the accepted work.
    const accepted = sequence.promotion.acceptedWork;
    expect(accepted?.owners).toEqual(["design-system"]);
    expect(accepted?.paths).toEqual(["apps/web/components/button.tsx"]);
    expect(accepted!.patchPath).not.toBe(sequence.promotion.patchPath);
    expect(patchesIn(stateRoot)).toHaveLength(2);
    const reusable = readFileSync(accepted!.patchPath, "utf8");
    expect(reusable).toContain("<Button/>");
    // Path-level: the file the stopping owner touched is not in it at all.
    expect(reusable).not.toContain("apps/web/app.tsx");
    expect(reusable).not.toContain("half-built");
  });

  it("keeps the stopping owner's edit of a file an earlier owner accepted out of it", async () => {
    // The sharpest case for the boundary: the owner that stops the sequence rewrites a
    // file an earlier owner already had accepted, and its grant covers that file, so
    // path-level exclusion cannot see the difference. Only the commit boundary can.
    const { createSession } = sessions({
      billing: async (config) => {
        await callTool(config, "write", {
          path: "services/billing/x.rb",
          content: "PROVIDER = 'ready'\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "provider ready" });
      },
      "design-system": async (config) => {
        await callTool(config, "write", {
          path: "apps/web/components/button.tsx",
          content: "<Button/>\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "button added" });
      },
      web: async (config) => {
        await callTool(config, "write", {
          path: "apps/web/components/button.tsx",
          content: "<Button onClick={half}/>\n",
        });
        await callTool(config, "orca_checkpoint", {
          status: "needs_scope",
          summary: "the click handler lives outside my grant",
          scope_request: ["services/billing/client.rb"],
        });
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, [
        "apps/web/app.tsx",
        "apps/web/components/button.tsx",
        "services/billing/x.rb",
      ]),
      { createSession, stateRoot },
    );

    expect(sequence.stoppedAt).toBe("web");
    const accepted = sequence.promotion.acceptedWork!;
    // Both owners that completed are named, in execution order.
    expect(accepted.owners).toEqual(["billing", "design-system"]);
    expect(accepted.paths).toEqual([
      "apps/web/components/button.tsx",
      "services/billing/x.rb",
    ]);

    const reusable = readFileSync(accepted.patchPath, "utf8");
    expect(reusable).toContain("PROVIDER = 'ready'");
    // Content-level: the accepted version of the shared file, not the stopping
    // owner's rewrite of it.
    expect(reusable).toContain("<Button/>");
    expect(reusable).not.toContain("onClick");
    // The evidence patch is the other half of the story and does have the rewrite.
    expect(readFileSync(sequence.promotion.patchPath!, "utf8")).toContain("onClick");
  });
});

describe("a needs_scope stop with nothing accepted behind it", () => {
  let repo: string;
  let stateRoot: string;
  beforeEach(() => {
    repo = makeGitRepo("orca-accepted-");
    stateRoot = makeStateRoot();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("writes no second patch when the first step is the one that needs scope", async () => {
    const { createSession, captured } = sessions({
      billing: async (config) => {
        await callTool(config, "write", { path: "services/billing/x.rb", content: "started\n" });
        await callTool(config, "orca_checkpoint", {
          status: "needs_scope",
          summary: "the web client is outside my grant",
          scope_request: ["apps/web/client.ts"],
        });
      },
      web: async (config) => {
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "never runs" });
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    expect(captured.map((config) => config.owner)).toEqual(["billing"]);
    expect(sequence.promotion.acceptedWork).toBeUndefined();
    // One patch, not a second empty one, and the evidence still holds the attempt.
    expect(patchesIn(stateRoot)).toHaveLength(1);
    expect(readFileSync(sequence.promotion.patchPath!, "utf8")).toContain("started");

    // The outcome says why there is nothing to reuse instead of dangling an offer.
    const text = promotionText(sequence.promotion);
    expect(text).toContain("No owner completed before the sequence stopped");
    expect(text).toContain("nothing in it was accepted");
    expect(text).not.toContain("REUSABLE");
    expect(text).not.toContain(".accepted.patch");
  });

  it("says the same for a single owner that needs scope, the commonest case of all", async () => {
    const { createSession } = sessions({
      web: async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "started\n" });
        await callTool(config, "orca_checkpoint", {
          status: "needs_scope",
          summary: "the billing client is outside my grant",
          scope_request: ["services/billing/client.rb"],
        });
      },
    });

    const sequence = await runDelegationSequence(orderedFor(repo, ["apps/web/app.tsx"]), {
      createSession,
      stateRoot,
    });

    expect(sequence.promotion.acceptedWork).toBeUndefined();
    expect(patchesIn(stateRoot)).toHaveLength(1);
    expect(promotionText(sequence.promotion)).toContain(
      "No owner completed before the sequence stopped",
    );
  });

  it("writes no second patch when the completed owner changed nothing at all", async () => {
    const { createSession } = sessions({
      billing: async (config) => {
        // A completed owner that touched no file still gets a staged commit, so this is
        // the case where a tip exists and there is still nothing worth handing back.
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "already done" });
      },
      web: async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "half-built\n" });
        await callTool(config, "orca_checkpoint", {
          status: "needs_scope",
          summary: "needs more",
          scope_request: ["packages/client/**"],
        });
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    expect(sequence.promotion.acceptedWork).toBeUndefined();
    expect(patchesIn(stateRoot)).toHaveLength(1);
    const text = promotionText(sequence.promotion);
    expect(text).toContain("changed no files, so there is no accepted work to reuse");
    expect(text).not.toContain("REUSABLE");
  });
});

describe("reusing what a needs_scope stop preserved", () => {
  let repo: string;
  let stateRoot: string;
  beforeEach(() => {
    repo = makeGitRepo("orca-accepted-");
    stateRoot = makeStateRoot();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("hands the user a patch git takes on the base it was staged from", async () => {
    // The base a delegation is staged from is `HEAD` PLUS the user's uncommitted work,
    // so the reusable patch is only real if it applies over that — here the completed
    // owner edits a file the user already had dirty.
    mkdirSync(join(repo, "services", "billing"), { recursive: true });
    writeFileSync(join(repo, "services", "billing", "x.rb"), "PROVIDER = 'draft'\n");
    writeFileSync(join(repo, "notes.md"), "my uncommitted notes\n");
    const { createSession } = sessions({
      billing: async (config) => {
        await callTool(config, "write", {
          path: "services/billing/x.rb",
          content: "PROVIDER = 'draft, finished'\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "finished it" });
      },
      web: async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "half-built\n" });
        await callTool(config, "orca_checkpoint", {
          status: "needs_scope",
          summary: "needs the shared client",
          scope_request: ["packages/client/**"],
        });
      },
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    const accepted = sequence.promotion.acceptedWork!;
    // The recovery route the outcome recommends, followed literally: no Orca-specific
    // tool, no `--3way`, just git on the state the delegation was staged from.
    expect(promotionText(sequence.promotion)).toContain(`git apply ${accepted.patchPath}`);
    git(repo, "apply", accepted.patchPath);

    expect(readFileSync(join(repo, "services", "billing", "x.rb"), "utf8")).toBe(
      "PROVIDER = 'draft, finished'\n",
    );
    // Reusing the accepted work brings nothing from the owner that stopped, and leaves
    // the user's own uncommitted work alone.
    expect(existsSync(join(repo, "apps", "web", "app.tsx"))).toBe(false);
    expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("my uncommitted notes\n");
  });
});
