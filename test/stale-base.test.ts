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
import { git, makeGitRepo, makeStateRoot, snapshotTree } from "./git-fixture";

/**
 * Stale-base detection and conflict recovery (staged-promotion plan, Phase 5).
 *
 * Phase 2 bound a staged delegation to the user's `HEAD` alone, which left the
 * dirty overlay unguarded: the child's patch was computed against the user's
 * uncommitted state, so a user who kept working while a delegation ran could have
 * a patch applied on top of a base that no longer existed. These tests pin the
 * FULL binding — `HEAD` plus a per-file digest of the dirty overlay, captured when
 * the workspace opens and re-verified before anything is applied — and the
 * `conflict` outcome it produces: nothing applied, the patch preserved, the
 * drifted paths named, and a recovery route the user can actually follow.
 */

const webGrant: CompiledGrant = compileGrant(
  {
    id: "web",
    name: "Web",
    description: "Owns the web application.",
    ownership: ["apps/web/**"],
    permissions: { edit: { allow: ["apps/web/**"] } },
  } satisfies DomainAgent,
  {},
);

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A seeded repository plus a state root, both torn down after the test. */
function fixture(): { repo: string; stateRoot: string } {
  const repo = makeGitRepo("orca-stale-base-");
  const stateRoot = makeStateRoot();
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "app.tsx"), "committed\n");
  writeFileSync(join(repo, "keep.md"), "committed keep\n");
  commit(repo, "seed");
  return { repo, stateRoot };
}

/** Commit whatever is in a fixture repository, with a pinned identity. */
function commit(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );
}

function open(repo: string, stateRoot: string, delegationId = "d1"): StagedWorkspace {
  const opened = gitWorktreeStaging.open({ cwd: repo, delegationId, stateRoot });
  if (!opened.ok) throw new Error(`staging refused: ${opened.diagnostics.join(" ")}`);
  cleanups.push(() => gitWorktreeStaging.close(opened.workspace));
  return opened.workspace;
}

/** The gate exactly as a single-owner delegation runs it (see `staging.ts`). */
function gate(workspace: StagedWorkspace, grant: CompiledGrant = webGrant): PromotionRecord {
  return promoteStagedCommits(workspace, [commitAuthorizedWork(workspace, grant, "web")]);
}

describe("a user who keeps working during a delegation", () => {
  it("gets a conflict, not a merge, when they edit a file that was dirty at staging time", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft\n");
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    const before = snapshotTree(repo);
    // The user keeps typing in their own checkout while the child works.
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft, revised\n");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["keep.md"]);
    // Nothing was applied: the user's own revision is the only change to their files.
    expect(snapshotTree(repo)).toEqual({
      ...before,
      "keep.md": expect.any(String),
    });
    expect(readFileSync(join(repo, "keep.md"), "utf8")).toBe("my uncommitted draft, revised\n");
    // The work survives, and the conflict says where.
    expect(readFileSync(record.patchPath!, "utf8")).toContain("delegated work");
    expect(record.diagnostics.join("\n")).toContain(record.patchPath!);
  });
});
