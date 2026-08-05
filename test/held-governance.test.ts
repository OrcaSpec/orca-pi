import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainAgent } from "orcaspec";
import { compileGrant, type CompiledGrant } from "../src/resolver";
import {
  commitAuthorizedWork,
  promoteStagedCommits,
  type PromotionRecord,
  type StagedWorkspace,
} from "../src/staging";
import { gitWorktreeStaging } from "../src/staging-worktree";
import { git, makeGitRepo, makeStateRoot } from "./git-fixture";

/**
 * Governance changes are HELD, never applied (hardening plan, Phase 2).
 *
 * A delegation may be authorized to edit `.orca/**` — that is a per-owner grant
 * question and this phase does not touch it. What this phase adds is a narrowing
 * AFTER authorization: an authorized governance change is written to its own patch
 * in the state directory and waits for the user, because a change to the document
 * that governs the agents is the one change an agent must not land on its own.
 *
 * Driven against real git repositories through the real gate, and every held patch
 * is proved by actually running `git apply` on it — the recovery route is only real
 * if git accepts it.
 */

/** An owner whose grant covers the governance directory itself. */
const governanceGrant: CompiledGrant = compileGrant(
  {
    id: "governance",
    name: "Governance",
    description: "Owns the governance documents.",
    ownership: [".orca/**"],
    permissions: { edit: { allow: [".orca/**"] } },
  } satisfies DomainAgent,
  {},
);

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A repository holding both a governance document and ordinary source. */
function fixture(): { repo: string; stateRoot: string } {
  const repo = makeGitRepo("orca-held-");
  const stateRoot = makeStateRoot();
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  mkdirSync(join(repo, ".orca"), { recursive: true });
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, ".orca", "runtime.yaml"), "committed overlay\n");
  writeFileSync(join(repo, "apps", "web", "app.tsx"), "committed app\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "seed");
  return { repo, stateRoot };
}

function open(repo: string, stateRoot: string, delegationId = "d1"): StagedWorkspace {
  const opened = gitWorktreeStaging.open({ cwd: repo, delegationId, stateRoot });
  if (!opened.ok) throw new Error(`staging refused: ${opened.diagnostics.join(" ")}`);
  cleanups.push(() => gitWorktreeStaging.close(opened.workspace));
  return opened.workspace;
}

/** The gate exactly as a single-owner delegation runs it. */
async function gate(workspace: StagedWorkspace, grant: CompiledGrant): Promise<PromotionRecord> {
  return promoteStagedCommits(workspace, [commitAuthorizedWork(workspace, grant, "governance")]);
}

describe("an authorized governance change is held, not applied", () => {
  it("keeps it out of the checkout and preserves it as a patch git will take", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), "agent overlay\n");

    const record = await gate(workspace, governanceGrant);

    expect(record.heldGovernance?.paths).toEqual([".orca/runtime.yaml"]);
    expect(record.appliedPaths).toEqual([]);
    // The governance document in the user's checkout is exactly as they left it.
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe("committed overlay\n");

    // The hold is only honest if the work is recoverable, so the patch is proved by
    // running the very command the diagnostics tell the user to run.
    git(repo, "apply", record.heldGovernance!.patchPath);
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe("agent overlay\n");
  });

  it("holds every governance path it touched, whichever they are", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "orca.yaml"), "rewritten spec\n");
    mkdirSync(join(workspace.dir, ".orca", "nested"), { recursive: true });
    writeFileSync(join(workspace.dir, ".orca", "nested", "extra.yaml"), "new\n");

    const record = await gate(workspace, governanceGrant);

    expect(record.heldGovernance?.paths).toEqual([".orca/nested/extra.yaml", ".orca/orca.yaml"]);
    expect(record.appliedPaths).toEqual([]);
  });

  it("reports `held` rather than `promoted` when governance is all there was", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), "agent overlay\n");

    const record = await gate(workspace, governanceGrant);

    // `promoted` is the word the compact history line prints, and nothing was
    // promoted: the delegation's whole change is still waiting for a decision.
    expect(record.status).toBe("held");
    expect(record.patchPath).toBeUndefined();
  });
});

/** An owner authorized over both the governance directory and the application. */
const wideGrant: CompiledGrant = compileGrant(
  {
    id: "wide",
    name: "Wide",
    description: "Owns everything.",
    ownership: ["**"],
    permissions: { edit: { allow: ["**"] } },
  } satisfies DomainAgent,
  {},
);

describe("the rest of the delegation promotes alongside the hold", () => {
  it("applies the non-governance half and holds only the governance half", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "agent app\n");
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), "agent overlay\n");

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, wideGrant, "wide"),
    ]);

    expect(record.status).toBe("promoted");
    expect(record.appliedPaths).toEqual(["apps/web/app.tsx"]);
    expect(record.heldGovernance?.paths).toEqual([".orca/runtime.yaml"]);
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("agent app\n");
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe("committed overlay\n");
  });

  it("keeps the two patches disjoint, so each applies without the other", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "agent app\n");
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), "agent overlay\n");

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, wideGrant, "wide"),
    ]);

    // The promotable half is already applied; the held patch must still go in on top
    // of it, which is only true because the split is by path and no file is on both
    // sides. Applying it is the whole delegation, landed in two deliberate steps.
    git(repo, "apply", record.heldGovernance!.patchPath);
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe("agent overlay\n");
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("agent app\n");
    // The held patch is exactly the governance change and nothing else.
    expect(readFileSync(record.heldGovernance!.patchPath, "utf8")).not.toContain("app.tsx");
  });
});
