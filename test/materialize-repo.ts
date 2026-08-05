import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initGitRepo } from "./git-fixture";

/**
 * The canonical managed test repository template, committed under
 * `test/fixture-repo/` so the deterministic suite is hermetic: each test
 * materializes a fresh copy into a temp dir and drives the real extension
 * against it. The SAME template seeds the standalone dogfood repo at
 * `~/Documents/orca-dogfood` (see `scripts/sync-dogfood.sh`), so the two cannot
 * drift.
 */
export const FIXTURE_REPO_DIR = fileURLToPath(new URL("./fixture-repo", import.meta.url));

/**
 * Copy the committed template into a fresh temp dir and return its path.
 *
 * The copy is initialized as a git repository with one commit, because delegation
 * runs in a staging worktree taken from `HEAD` and refuses a checkout it cannot
 * stage. The standalone dogfood instance already carries its own git history (see
 * `scripts/sync-dogfood.sh`), so this only gives the in-suite copy the same
 * footing the real one has.
 */
export function materializeFixtureRepo(): string {
  const dest = realpathSync(mkdtempSync(join(tmpdir(), "orca-dogfood-")));
  // Recursive copy includes the .orca/ dotdir and every source file verbatim.
  cpSync(FIXTURE_REPO_DIR, dest, { recursive: true });
  return initGitRepo(dest);
}
