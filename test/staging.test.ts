import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainAgent } from "orcaspec";
import { compileGrant, type CompiledGrant } from "../src/resolver";
import {
  abandonStagedWork,
  commitAuthorizedWork,
  defaultStateRoot,
  promoteStagedCommits,
  stagedDiff,
  type PromotionRecord,
  type StagedWorkspace,
} from "../src/staging";
import { gitWorktreeStaging } from "../src/staging-worktree";
import {
  git,
  headOf,
  makeGitRepo,
  makeStateRoot,
  snapshotTree,
  worktreePathsOf,
} from "./git-fixture";

/**
 * The staging workspace and the two-part promotion gate on their own
 * (staged-promotion plan, Phases 2–3). These tests drive the gate DIRECTLY,
 * including states a well-behaved child could never produce — an unauthorized
 * change sitting in the worktree, a patch that cannot apply — because the gate is
 * the last line of defense and has to hold even when the layer above it has
 * already failed. The multi-owner transaction the gate's two halves exist for
 * lives in `staged-sequence.test.ts`.
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
  const repo = makeGitRepo("orca-staging-");
  const stateRoot = makeStateRoot();
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "app.tsx"), "committed\n");
  writeFileSync(join(repo, "keep.md"), "committed keep\n");
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-q",
    "-m",
    "seed",
  );
  return { repo, stateRoot };
}

function open(repo: string, stateRoot: string, delegationId = "d1"): StagedWorkspace {
  const opened = gitWorktreeStaging.open({ cwd: repo, delegationId, stateRoot });
  if (!opened.ok) throw new Error(`staging refused: ${opened.diagnostics.join(" ")}`);
  cleanups.push(() => gitWorktreeStaging.close(opened.workspace));
  return opened.workspace;
}

describe("opening a staging workspace", () => {
  it("checks out HEAD into a per-delegation directory under the state root", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot, "delegation_abc");

    expect(workspace.dir).toBe(join(stateRoot, "worktrees", "delegation_abc"));
    expect(workspace.repoRoot).toBe(repo);
    expect(workspace.baseCommit).toBe(headOf(repo));
    expect(readFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
    // The checkout is a real linked worktree of the user's repository.
    expect(worktreePathsOf(repo)).toContain(workspace.dir);
  });

  it("caps the worktree with a synthetic baseline commit so the diff has a left side", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "keep.md"), "dirty keep\n");
    const workspace = open(repo, stateRoot);

    expect(workspace.baselineCommit).not.toBe(workspace.baseCommit);
    // The baseline captured the overlay, so a freshly-staged worktree is clean.
    expect(git(workspace.dir, "status", "--porcelain").trim()).toBe("");
    expect(stagedDiff(workspace)).toMatchObject({ paths: [] });
  });

  it("reclaims a directory a crashed run left behind instead of refusing forever", () => {
    const { repo, stateRoot } = fixture();
    const stale = join(stateRoot, "worktrees", "d1");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "leftover.txt"), "from a crashed run\n");

    const workspace = open(repo, stateRoot, "d1");

    expect(workspace.dir).toBe(stale);
    expect(existsSync(join(stale, "leftover.txt"))).toBe(false);
  });

  it("sanitizes a delegation identity into a single safe directory segment", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot, "../../escape/../id with spaces");

    expect(workspace.dir).toBe(
      join(stateRoot, "worktrees", ".._.._escape_.._id_with_spaces"),
    );
    expect(existsSync(workspace.dir)).toBe(true);
  });

  it("falls back to a fixed segment for an identity with nothing usable in it", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot, "///");

    expect(workspace.dir).toBe(join(stateRoot, "worktrees", "___"));
  });

  it("stages from a detached HEAD as readily as from a branch", () => {
    const { repo, stateRoot } = fixture();
    const detachedAt = headOf(repo);
    git(repo, "checkout", "-q", "--detach", detachedAt);

    const workspace = open(repo, stateRoot);

    expect(workspace.baseCommit).toBe(detachedAt);
    expect(readFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
  });

  it("refuses a directory that is not a git working tree", () => {
    const stateRoot = makeStateRoot();
    cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
    const opened = gitWorktreeStaging.open({ cwd: stateRoot, delegationId: "d1", stateRoot });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.diagnostics.join("\n")).toContain("not inside a git working tree");
  });
});

describe("materializing the dirty overlay", () => {
  it("carries staged, unstaged, and non-ignored untracked files into the worktree", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, "apps", "web", "app.tsx"), "unstaged edit\n");
    writeFileSync(join(repo, "keep.md"), "staged edit\n");
    git(repo, "add", "keep.md");
    writeFileSync(join(repo, "fresh.md"), "untracked\n");

    const workspace = open(repo, stateRoot);

    expect(readFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "utf8")).toBe(
      "unstaged edit\n",
    );
    expect(readFileSync(join(workspace.dir, "keep.md"), "utf8")).toBe("staged edit\n");
    expect(readFileSync(join(workspace.dir, "fresh.md"), "utf8")).toBe("untracked\n");
  });

  it("reproduces a deletion the user has not committed", () => {
    const { repo, stateRoot } = fixture();
    rmSync(join(repo, "keep.md"));

    const workspace = open(repo, stateRoot);

    expect(existsSync(join(workspace.dir, "keep.md"))).toBe(false);
  });

  it("carries an uncommitted symlink across as a symlink, not as its target's bytes", () => {
    const { repo, stateRoot } = fixture();
    symlinkSync("keep.md", join(repo, "link.md"));

    const workspace = open(repo, stateRoot);

    const staged = join(workspace.dir, "link.md");
    expect(lstatSync(staged).isSymbolicLink()).toBe(true);
    expect(readlinkSync(staged)).toBe("keep.md");
  });

  it("leaves ignored files out of the worktree entirely", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, ".gitignore"), "secret.env\n");
    writeFileSync(join(repo, "secret.env"), "TOKEN=abc\n");

    const workspace = open(repo, stateRoot);

    expect(existsSync(join(workspace.dir, "secret.env"))).toBe(false);
  });
});

/**
 * The gate exactly as a single-owner delegation runs it: authorize this owner's
 * change against its own grant and commit it in staging, then promote the
 * accumulated commits. A single-owner delegation IS this composition (see
 * `delegation.ts`), so driving it this way keeps these tests a specification of
 * the real path rather than of a test-only shortcut.
 */
function gate(workspace: StagedWorkspace, grant: CompiledGrant): PromotionRecord {
  return promoteStagedCommits(workspace, [commitAuthorizedWork(workspace, grant, "web")]);
}

describe("the promotion gate", () => {
  it("applies an authorized change to the checkout as an unstaged edit", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "promoted\n");

    const record = gate(workspace, webGrant);

    expect(record).toMatchObject({
      status: "promoted",
      appliedPaths: ["apps/web/app.tsx"],
      rejectedPaths: [],
    });
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("promoted\n");
    // Applied to the working tree only: the user's index is left as they had it.
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("promotes an authorized new file and an authorized deletion", () => {
    const { repo, stateRoot } = fixture();
    mkdirSync(join(repo, "apps", "web", "old"), { recursive: true });
    writeFileSync(join(repo, "apps", "web", "old", "gone.tsx"), "delete me\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "more");

    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "added.tsx"), "brand new\n");
    rmSync(join(workspace.dir, "apps", "web", "old", "gone.tsx"));

    const record = gate(workspace, webGrant);

    expect(record.status).toBe("promoted");
    expect(record.appliedPaths).toEqual(["apps/web/added.tsx", "apps/web/old/gone.tsx"]);
    expect(readFileSync(join(repo, "apps", "web", "added.tsx"), "utf8")).toBe("brand new\n");
    expect(existsSync(join(repo, "apps", "web", "old", "gone.tsx"))).toBe(false);
  });

  it("rejects the WHOLE promotion when any staged path is outside the grant", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    // Both an authorized and an unauthorized change, written straight into the
    // worktree so no accountability layer can have filtered them first.
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "authorized\n");
    writeFileSync(join(workspace.dir, "keep.md"), "smuggled\n");

    const record = gate(workspace, webGrant);

    expect(record.status).toBe("rejected");
    expect(record.rejectedPaths).toEqual(["keep.md"]);
    expect(record.appliedPaths).toEqual([]);
    // Fail closed: the authorized half does not land either.
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
    expect(readFileSync(join(repo, "keep.md"), "utf8")).toBe("committed keep\n");
    // The evidence is preserved, and it names the unauthorized path.
    expect(readFileSync(record.patchPath!, "utf8")).toContain("keep.md");
  });

  it("rejects an unauthorized DELETION, not only an unauthorized write", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    rmSync(join(workspace.dir, "keep.md"));

    const record = gate(workspace, webGrant);

    expect(record.status).toBe("rejected");
    expect(record.rejectedPaths).toEqual(["keep.md"]);
    expect(readFileSync(join(repo, "keep.md"), "utf8")).toBe("committed keep\n");
  });

  it("reports a conflict without applying when HEAD moved since staging", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "staged work\n");
    writeFileSync(join(repo, "later.md"), "later\n");
    git(repo, "add", "later.md");
    git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "moved");

    const record = gate(workspace, webGrant);

    expect(record.status).toBe("conflict");
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
    expect(readFileSync(record.patchPath!, "utf8")).toContain("staged work");
  });

  it("rejects and preserves when the patch cannot apply, with no drift to blame", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "added.tsx"), "a new file\n");
    // A structural collision the base binding cannot see: the user occupies the
    // patch's new path with a DIRECTORY, so no bound path drifted (the binding
    // compares exact paths — see `detectBaseDrift`) and git is what has to catch it,
    // here when it tries to write. The distinction is deliberate: a stale base is a
    // `conflict`, a patch that simply cannot land is a `rejected`.
    mkdirSync(join(repo, "apps", "web", "added.tsx"), { recursive: true });
    writeFileSync(join(repo, "apps", "web", "added.tsx", "note.md"), "occupied\n");

    const record = gate(workspace, webGrant);

    expect(record.status).toBe("rejected");
    expect(record.driftedPaths).toEqual([]);
    expect(record.diagnostics.join("\n")).toMatch(/could not apply the staged patch/);
    expect(readFileSync(join(repo, "apps", "web", "added.tsx", "note.md"), "utf8")).toBe(
      "occupied\n",
    );
    expect(existsSync(record.patchPath!)).toBe(true);
  });

  it("promotes nothing, and preserves nothing, when the delegation changed no files", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);

    const record = gate(workspace, webGrant);

    expect(record).toMatchObject({ status: "promoted", appliedPaths: [], rejectedPaths: [] });
    expect(record.patchPath).toBeUndefined();
    expect(existsSync(join(stateRoot, "patches", "d1.patch"))).toBe(false);
  });

  it("never promotes a change to an ignored path, authorized or not", () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, ".gitignore"), "apps/web/build.log\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "ignore");

    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "build.log"), "noise\n");

    const record = gate(workspace, webGrant);

    expect(record).toMatchObject({ status: "promoted", appliedPaths: [] });
    expect(existsSync(join(repo, "apps", "web", "build.log"))).toBe(false);
  });

  it("promotes a binary change byte-for-byte", () => {
    const { repo, stateRoot } = fixture();
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f]);
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "logo.bin"), bytes);

    const record = gate(workspace, webGrant);

    expect(record.status).toBe("promoted");
    expect(readFileSync(join(repo, "apps", "web", "logo.bin"))).toEqual(bytes);
  });

  it("does not throw when the worktree is gone; it reports the refusal", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    gitWorktreeStaging.close(workspace);

    const record = gate(workspace, webGrant);

    expect(record.status).toBe("rejected");
    expect(record.appliedPaths).toEqual([]);
    expect(record.diagnostics.join("\n")).toMatch(/could not compute the staged change/);
  });

  it("promotes nothing when no owner committed anything, uncommitted work included", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "never committed\n");

    // No steps at all: there is nothing authorized to promote, and the change
    // sitting in the worktree is not a substitute for one.
    const record = promoteStagedCommits(workspace, []);

    expect(record).toMatchObject({ status: "promoted", appliedPaths: [] });
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
  });

  it("carries an owner label into the staged commit inertly, whatever it contains", () => {
    const { repo, stateRoot } = fixture();
    // Owner and assignment ids come from a repository's spec, so a label can hold
    // anything. Git runs argv-only (`git.ts`), so a label that looks like a shell
    // payload or a git flag is just text in a commit message.
    const before = snapshotTree(repo);
    const labels = ["web; rm -rf /", "--allow-empty-message", "$(whoami)`id`", "🐙", ""];
    for (const [index, label] of labels.entries()) {
      const workspace = open(repo, stateRoot, `labelled-${index}`);
      writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), `by ${label}\n`);

      const staged = commitAuthorizedWork(workspace, webGrant, label);

      expect(staged, `label ${JSON.stringify(label)} should commit`).toMatchObject({
        status: "committed",
        paths: ["apps/web/app.tsx"],
        label,
      });
      expect(
        git(workspace.dir, "log", "-1", "--pretty=%s").trim(),
        `label ${JSON.stringify(label)} belongs in the commit subject, uninterpreted`,
      ).toBe(`orca staged step: ${label}`.trim());
      // Nothing ran: the repository it staged from is untouched, file for file.
      expect(snapshotTree(repo), `label ${JSON.stringify(label)} must not touch the repo`).toEqual(
        before,
      );
    }
  });
});

describe("abandoning staged work", () => {
  it("preserves the patch as evidence and applies nothing", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "unfinished\n");

    const record = abandonStagedWork(workspace, "the delegation ended 'blocked'.");

    expect(record.status).toBe("not_attempted");
    expect(record.appliedPaths).toEqual([]);
    expect(record.diagnostics[0]).toContain("blocked");
    expect(readFileSync(record.patchPath!, "utf8")).toContain("unfinished");
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
  });

  it("preserves an unauthorized change too, since nothing is being applied", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "keep.md"), "out of grant\n");

    const record = abandonStagedWork(workspace, "cancelled.");

    expect(record.status).toBe("not_attempted");
    expect(readFileSync(record.patchPath!, "utf8")).toContain("out of grant");
    expect(readFileSync(join(repo, "keep.md"), "utf8")).toBe("committed keep\n");
  });
});

describe("closing a staging workspace", () => {
  it("removes the checkout and the repository's worktree metadata", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    expect(existsSync(workspace.dir)).toBe(true);

    gitWorktreeStaging.close(workspace);

    expect(existsSync(workspace.dir)).toBe(false);
    expect(worktreePathsOf(repo)).toEqual([repo]);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
  });

  it("leaves a preserved patch in place, since it outlives the worktree", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "evidence\n");
    const record = abandonStagedWork(workspace, "failed.");

    gitWorktreeStaging.close(workspace);

    expect(existsSync(record.patchPath!)).toBe(true);
    expect(readFileSync(record.patchPath!, "utf8")).toContain("evidence");
  });

  it("is idempotent and silent when called twice", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    gitWorktreeStaging.close(workspace);
    expect(() => gitWorktreeStaging.close(workspace)).not.toThrow();
  });
});

describe("the runtime state root", () => {
  it("lives under pi's agent directory, so it follows the same convention as the child loader", () => {
    expect(defaultStateRoot().endsWith(join("agent", "orca"))).toBe(true);
  });
});
