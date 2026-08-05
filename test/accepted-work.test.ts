import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
});
