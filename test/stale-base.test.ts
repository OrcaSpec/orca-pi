import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainAgent } from "orcaspec";
import { compileGrant, type CompiledGrant } from "../src/resolver";
import {
  commitAuthorizedWork,
  detectBaseDrift,
  promoteStagedCommits,
  type PromotionRecord,
  type StagedWorkspace,
} from "../src/staging";
import { gitWorktreeStaging } from "../src/staging-worktree";
import { git, headOf, makeGitRepo, makeStateRoot, snapshotTree } from "./git-fixture";

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

  it("gets a conflict when they rewrite a committed file the delegation also changed", () => {
    const { repo, stateRoot } = fixture();
    // `apps/web/app.tsx` is committed and clean when staging begins, so it is not in
    // the binding at all. The user making it dirty is drift only because the staged
    // patch touches the same path — which is the case that used to reach `git apply`
    // and come back as a bare rejection.
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    writeFileSync(join(repo, "apps", "web", "app.tsx"), "the user rewrote this entirely\n");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["apps/web/app.tsx"]);
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe(
      "the user rewrote this entirely\n",
    );
    expect(readFileSync(record.patchPath!, "utf8")).toContain("delegated work");
  });

  it("promotes anyway when the file they touched is not one the delegation changed", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    // Editing an unrelated file is what working normally looks like. Treating it as
    // drift would make every long delegation a coin flip, so the binding ignores a
    // path the staged patch does not touch.
    writeFileSync(join(repo, "notes.md"), "thinking out loud\n");

    const record = gate(workspace);

    expect(record).toMatchObject({
      status: "promoted",
      appliedPaths: ["apps/web/app.tsx"],
      driftedPaths: [],
    });
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("delegated work\n");
    expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("thinking out loud\n");
  });

  it("holds a file that was already dirty to its digest, whatever the patch touches", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft\n");
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    // `keep.md` is nowhere in the patch, but the delegation was staged FROM this
    // content: the child read it, and its work may depend on what it said.
    writeFileSync(join(repo, "keep.md"), "second thoughts\n");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["keep.md"]);
  });
});

describe("what the overlay digest does and does not count as drift", () => {
  it("counts a revert: the file is back to HEAD, which is not what was staged", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft\n");
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    git(repo, "checkout", "--", "keep.md");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["keep.md"]);
  });

  it("counts an edit that changes no file size", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "ship the blue button\n");
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    // Same length, different meaning: the binding is over CONTENT, so nothing about a
    // file's size or timestamp can stand in for reading it.
    writeFileSync(join(repo, "keep.md"), "ship the green butto\n");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["keep.md"]);
  });

  it("counts restoring a file the user had deleted uncommitted", () => {
    const { repo, stateRoot } = fixture();
    rmSync(join(repo, "keep.md"));
    // The delegation is staged from a checkout where `keep.md` does not exist; the
    // binding records that absence, so the file coming back is drift like any other.
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    writeFileSync(join(repo, "keep.md"), "on reflection, I want it back\n");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["keep.md"]);
  });

  it("counts a chmod +x, which git itself tracks", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft\n");
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    chmodSync(join(repo, "keep.md"), 0o755);

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["keep.md"]);
  });

  it("ignores a permission change git does not track", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft\n");
    chmodSync(join(repo, "keep.md"), 0o644);
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    // Dropping group read changes no byte git will ever record, so it cannot make a
    // patch stale.
    chmodSync(join(repo, "keep.md"), 0o600);

    const record = gate(workspace);

    expect(record).toMatchObject({ status: "promoted", appliedPaths: ["apps/web/app.tsx"] });
  });

  it("counts a symlink that now points somewhere else", () => {
    const { repo, stateRoot } = fixture();
    symlinkSync("keep.md", join(repo, "link.md"));
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    rmSync(join(repo, "link.md"));
    symlinkSync("apps/web/app.tsx", join(repo, "link.md"));

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["link.md"]);
  });

  it("ignores staging a file whose bytes never changed", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft\n");
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    // `git add` of content the delegation was already staged from moves nothing the
    // patch depends on: promotion applies to the working tree, so the user's index is
    // deliberately outside the binding.
    git(repo, "add", "keep.md");

    const record = gate(workspace);

    expect(record).toMatchObject({ status: "promoted", appliedPaths: ["apps/web/app.tsx"] });
    expect(readFileSync(join(repo, "keep.md"), "utf8")).toBe("my uncommitted draft\n");
    // ...and the user's staged change is still staged afterwards.
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("keep.md");
  });

  it("reports a conflict, not a vacuous promotion, when a drifted base carried no change", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft\n");
    const workspace = open(repo, stateRoot);
    // The delegation changed nothing at all, so nothing would be applied either way.
    // The outcome still describes what was VERIFIED: a base that moved is reported as
    // a conflict rather than dressed up as a promotion of nothing.
    writeFileSync(join(repo, "keep.md"), "second thoughts\n");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual(["keep.md"]);
    expect(record.patchPath).toBeUndefined();
    expect(record.diagnostics.join("\n")).toContain("no change to preserve");
  });

  it("treats a base it cannot read as drift, never as a pass", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "orca-not-a-repo-")));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }));

    // An unverifiable base is indistinguishable from a moved one, so it fails closed.
    const drift = detectBaseDrift({ ...workspace, repoRoot: plain }, ["apps/web/app.tsx"]);

    expect(drift?.unreadable).toMatch(/HEAD could not be read/);
    expect(drift?.paths).toEqual([]);
  });
});

describe("a user who commits during a delegation", () => {
  it("gets a conflict naming the commit their checkout moved to", () => {
    const { repo, stateRoot } = fixture();
    const stagedFrom = headOf(repo);
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    writeFileSync(join(repo, "later.md"), "unrelated work of my own\n");
    commit(repo, "a commit landed mid-delegation");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.diagnostics.join("\n")).toContain(stagedFrom);
    expect(record.diagnostics.join("\n")).toContain(headOf(repo));
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
    expect(readFileSync(record.patchPath!, "utf8")).toContain("delegated work");
  });

  it("gets a conflict from an amend, which moves HEAD without changing a file", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    // Rewording the tip leaves the working tree byte-identical, so only the `HEAD`
    // half of the binding can see it — and it must, because the commit the patch is
    // based on is no longer in the user's history.
    const before = snapshotTree(repo);
    git(
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-q",
      "--amend",
      "-m",
      "seed, reworded",
    );

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual([]);
    expect(record.diagnostics.join("\n")).toMatch(/HEAD moved/);
    expect(snapshotTree(repo)).toEqual(before);
  });

  it("counts committing the very file it staged from as drift on both halves", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "my uncommitted draft\n");
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "delegated work\n");
    // The user commits the dirty file: `HEAD` moves and the file stops being dirty,
    // so the overlay digest no longer describes a working-tree state at all.
    commit(repo, "I committed my draft");

    const record = gate(workspace);

    expect(record.status).toBe("conflict");
    expect(record.diagnostics.join("\n")).toMatch(/HEAD moved/);
    expect(record.driftedPaths).toEqual([]);
    expect(readFileSync(join(repo, "keep.md"), "utf8")).toBe("my uncommitted draft\n");
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
  });
});
