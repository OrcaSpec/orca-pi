import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The canonical managed test repository template, committed under
 * `test/fixture-repo/` so the deterministic suite is hermetic: each test
 * materializes a fresh copy into a temp dir and drives the real extension
 * against it. The SAME template seeds the standalone dogfood repo at
 * `~/Documents/orca-dogfood` (see `scripts/sync-dogfood.sh`), so the two cannot
 * drift.
 */
export const FIXTURE_REPO_DIR = fileURLToPath(new URL("./fixture-repo", import.meta.url));

/** Copy the committed template into a fresh temp dir and return its path. */
export function materializeFixtureRepo(): string {
  const dest = mkdtempSync(join(tmpdir(), "orca-dogfood-"));
  // Recursive copy includes the .orca/ dotdir and every source file verbatim.
  cpSync(FIXTURE_REPO_DIR, dest, { recursive: true });
  return dest;
}
