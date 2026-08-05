import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real git repositories for the offline suite. Staged promotion is git behavior
 * end to end (worktree, synthetic baseline commit, `git apply`), so the tests
 * drive real repositories in temp directories rather than doubling git — a
 * `git init` plus one commit costs a few milliseconds and keeps every assertion
 * about the actual mechanism.
 */

/** Run one git command in `cwd`; arguments are argv, never a shell string. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Turn `dir` into a git repository with one commit containing whatever it
 * already holds. Delegation staging checks out `HEAD`, so a fixture repository
 * needs at least one commit; identity and hooks are pinned so the fixture never
 * depends on the developer's global git configuration.
 */
export function initGitRepo(dir: string): string {
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.name=Orca Fixture",
    "-c",
    "user.email=fixture@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--no-verify",
    "--allow-empty",
    "-m",
    "fixture baseline",
  );
  return dir;
}

/** A fresh, canonical temp git repository with one (empty) commit. */
export function makeGitRepo(prefix: string): string {
  return initGitRepo(realpathSync(mkdtempSync(join(tmpdir(), prefix))));
}

/**
 * A fresh runtime state root for staged worktrees and preserved patches.
 * Canonical, so a test can compare it against paths git and the staging module
 * report (on macOS `/var` is a symlink to `/private/var`).
 */
export function makeStateRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "orca-state-")));
}

/** The current `HEAD` commit id of a repository. */
export function headOf(dir: string): string {
  return git(dir, "rev-parse", "HEAD").trim();
}

/** The absolute worktree paths git currently tracks for a repository. */
export function worktreePathsOf(dir: string): string[] {
  return git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}
