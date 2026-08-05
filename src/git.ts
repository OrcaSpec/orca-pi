import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/**
 * The one way this extension runs `git`.
 *
 * Every invocation goes through {@link gitRaw} with an ARGV ARRAY — never a shell
 * string — so a path, ref, or commit message can never be interpolated into a
 * command line. There is no variant that takes a command string, which is what
 * makes that guarantee structural rather than a rule to remember.
 *
 * Output is captured as a Buffer, because staged patches carry binary data that a
 * utf8 round-trip would corrupt.
 */

/** Git configuration pinned on any invocation that writes a commit. */
export const COMMIT_CONFIG: readonly string[] = [
  "-c",
  "user.name=Orca staging",
  "-c",
  "user.email=orca-staging@localhost",
  "-c",
  "commit.gpgsign=false",
];

/**
 * Run one `git` command in `cwd` and return its stdout. Throws on a non-zero
 * exit; use {@link tryGit} when a failure is an expected outcome rather than a bug.
 */
export function gitRaw(cwd: string, args: readonly string[], input?: Buffer): Buffer {
  return execFileSync("git", ["-C", cwd, ...args], {
    input: input ?? Buffer.alloc(0),
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Run one `git` command and decode its stdout as text. */
export function gitText(cwd: string, args: readonly string[]): string {
  return gitRaw(cwd, args).toString("utf8");
}

/** The outcome of a `git` command whose failure is a legitimate answer. */
export type GitAttempt = { ok: true; out: Buffer } | { ok: false; reason: string };

export function tryGit(cwd: string, args: readonly string[], input?: Buffer): GitAttempt {
  try {
    return { ok: true, out: gitRaw(cwd, args, input) };
  } catch (error) {
    return { ok: false, reason: gitFailure(error) };
  }
}

/** Reduce a failed `git` invocation to one readable line for a diagnostic. */
export function gitFailure(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  const text = stderr
    ? Buffer.isBuffer(stderr)
      ? stderr.toString("utf8")
      : String(stderr)
    : error instanceof Error
      ? error.message
      : String(error);
  return text.trim().split("\n").join(" ").slice(0, 500);
}

/**
 * Canonicalize a path when it exists, else keep it literal. Staging compares
 * paths that git reports (already canonical) against paths the caller supplied,
 * and on macOS `/var` is a symlink to `/private/var`.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
