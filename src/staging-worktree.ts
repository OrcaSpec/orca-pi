import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalPath, gitFailure, tryGit } from "./git";
import {
  captureOverlayBinding,
  commitStagedBaseline,
  dirtyOverlayPaths,
  stagingPaths,
  type OverlayBinding,
  type OpenStagingInput,
  type OpenStagingResult,
  type StagedWorkspace,
  type StagingProvider,
} from "./staging";

/**
 * The `git worktree` staging provider — the only implementation of
 * {@link StagingProvider} today (staged-promotion plan, Phase 2).
 *
 * It satisfies the {@link StagedWorkspace} contract by checking `HEAD` out into a
 * linked worktree under the runtime state root, copying the user's dirty overlay
 * on top, and committing the synthetic baseline. `git worktree` is the
 * conservative first choice: the checkout is a real git working tree that shares
 * the repository's object database, so it costs one checkout rather than a copy of
 * the history, and `close` has an exact inverse (`git worktree remove`).
 *
 * A copy-on-write provider (APFS `clonefile`, btrfs subvolume) would satisfy the
 * same contract far more cheaply on a large repository — it clones the whole
 * working tree, including `.git`, in constant time, and gets the dirty overlay for
 * free instead of copying it file by file. Nothing in `staging.ts` or the
 * promotion gate assumes worktrees, so such a provider slots in beside this one.
 */

/**
 * Copy one dirty path from the user's checkout into the isolated checkout, so the
 * child sees the user's uncommitted state rather than a bare `HEAD`. A path that
 * is gone from the checkout is removed (a staged or unstaged deletion).
 * Directories are skipped: `git status --untracked-files=all` reports individual
 * files, so a directory entry can only be a dirty submodule, which is out of scope
 * for the MVP.
 */
function materializeOverlayPath(repoRoot: string, worktree: string, path: string): void {
  const from = join(repoRoot, path);
  const to = join(worktree, path);

  let stat;
  try {
    stat = lstatSync(from);
  } catch {
    rmSync(to, { recursive: true, force: true });
    return;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) return;

  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { recursive: true, force: true });
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
    return;
  }
  copyFileSync(from, to);
  chmodSync(to, stat.mode);
}

/**
 * Materialize the user's whole dirty overlay — staged, unstaged, and non-ignored
 * untracked files — into a fresh `HEAD` worktree, and report the base binding for
 * what was staged. Ignored files are deliberately excluded: they are not repository
 * content, so they neither enter the baseline nor can be promoted out of it.
 *
 * The overlay is enumerated ONCE (`dirtyOverlayPaths`) and both copied and digested
 * from that one enumeration, so the set of files the delegation is bound to is
 * exactly the set it was staged from. The digests are taken from the USER's checkout
 * rather than from the copies: the binding's question is whether the user's state has
 * moved, so both sides of that comparison are measured on the user's own tree.
 */
function materializeOverlay(repoRoot: string, worktree: string): OverlayBinding {
  const paths = dirtyOverlayPaths(repoRoot);
  for (const path of paths) materializeOverlayPath(repoRoot, worktree, path);
  return captureOverlayBinding(repoRoot, paths);
}

function open(input: OpenStagingInput): OpenStagingResult {
  const toplevel = tryGit(input.cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    return {
      ok: false,
      diagnostics: [
        `Orca refuses to delegate: \`${input.cwd}\` is not inside a git working tree ` +
          `(git rev-parse --show-toplevel failed: ${toplevel.reason}).`,
        "Delegated work runs in an isolated checkout and reaches your files only as an authorized, " +
          "verified patch. Without a repository there is no isolation and no way to undo a bad " +
          "change, so the delegation is refused rather than silently editing your files in place. " +
          "Run `git init` and make one commit, then delegate again.",
      ],
    };
  }
  const repoRoot = canonicalPath(toplevel.out.toString("utf8").trim());

  const head = tryGit(repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return {
      ok: false,
      diagnostics: [
        `Orca refuses to delegate: \`${repoRoot}\` has no commits yet, so there is no HEAD to ` +
          `stage a checkout from (${head.reason}).`,
        "Make an initial commit, then delegate again.",
      ],
    };
  }
  const baseCommit = head.out.toString("utf8").trim();
  const { dir, patchPath, validatorOutputPath } = stagingPaths(input);

  // Reclaim anything a crashed run left behind before claiming the path again, so
  // one crash cannot wedge every later delegation for this identity.
  tryGit(repoRoot, ["worktree", "prune"]);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });

  const added = tryGit(repoRoot, ["worktree", "add", "--detach", dir, baseCommit]);
  if (!added.ok) {
    return {
      ok: false,
      diagnostics: [
        `Orca could not create the staging worktree for this delegation at \`${dir}\` ` +
          `(git worktree add failed: ${added.reason}).`,
        "The delegation is refused; your checkout was not touched.",
      ],
    };
  }

  const workspace: StagedWorkspace = {
    repoRoot,
    dir: canonicalPath(dir),
    baseCommit,
    overlayBinding: new Map(),
    baselineCommit: baseCommit,
    patchPath,
    validatorOutputPath,
    provider: gitWorktreeStaging.name,
  };

  try {
    workspace.overlayBinding = materializeOverlay(repoRoot, workspace.dir);
    workspace.baselineCommit = commitStagedBaseline(workspace.dir);
  } catch (error) {
    close(workspace);
    return {
      ok: false,
      diagnostics: [
        "Orca could not stage your working state into the delegation checkout " +
          `(${gitFailure(error)}).`,
        "The delegation is refused; your checkout was not touched.",
      ],
    };
  }

  return { ok: true, workspace };
}

/**
 * Remove the worktree and its git metadata. Deliberately silent and idempotent:
 * it runs on every exit path, including after an unexpected throw, and must never
 * mask the outcome that caused it. A preserved patch lives outside the worktree,
 * so it survives.
 */
function close(workspace: StagedWorkspace): void {
  tryGit(workspace.repoRoot, ["worktree", "remove", "--force", workspace.dir]);
  rmSync(workspace.dir, { recursive: true, force: true });
  tryGit(workspace.repoRoot, ["worktree", "prune"]);
}

/** The default staging provider: one linked `git worktree` per delegation sequence. */
export const gitWorktreeStaging: StagingProvider = {
  name: "git-worktree",
  open,
  close,
};
