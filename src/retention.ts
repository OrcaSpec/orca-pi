import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEPTED_PATCH_SUFFIX,
  EVIDENCE_PATCH_SUFFIX,
  GOVERNANCE_PATCH_SUFFIX,
  PATCHES_DIR,
  VALIDATOR_OUTPUT_DIR,
  VALIDATOR_OUTPUT_SUFFIX,
} from "./staging";

/** Age-based evidence retention (hardening plan, Phase 6). */

/** Milliseconds in one retention day. */
const DAY_MS = 86_400_000;

/**
 * One directory of the state root retention owns, and which of its files it may
 * expire. A file is a candidate only when the predicate claims it, so anything in
 * these directories that staging did not write — a user's note, a partial download,
 * a future artifact kind this version has never heard of — is left alone rather than
 * swept on the strength of living in the right folder.
 */
interface SweptKind {
  directory: string;
  expires(name: string): boolean;
}

const SWEPT_KINDS: readonly SweptKind[] = [
  {
    directory: PATCHES_DIR,
    // The governance test comes FIRST and wins, which decides an otherwise ambiguous
    // name: a delegation whose own id ends in `.governance` writes its cumulative
    // patch to a file indistinguishable from another delegation's held patch. Erring
    // toward retention costs a stale file; erring the other way deletes a proposal.
    expires: (name) =>
      !name.endsWith(GOVERNANCE_PATCH_SUFFIX) &&
      (name.endsWith(EVIDENCE_PATCH_SUFFIX) || name.endsWith(ACCEPTED_PATCH_SUFFIX)),
  },
  {
    directory: VALIDATOR_OUTPUT_DIR,
    expires: (name) => name.endsWith(VALIDATOR_OUTPUT_SUFFIX),
  },
];

export interface RetentionSweepInput {
  stateRoot: string;
  now: number;
  retainDays: number;
  referenced: Iterable<string>;
}

export interface RetentionSweep {
  removed: string[];
  failures: string[];
}

/**
 * Whether a filesystem error means the thing is simply not there. Retention treats
 * absence as SUCCESS everywhere it can occur: a state root with no `validators/`
 * directory is a repository that declared no validators, and a file that vanished
 * between the listing and the `unlink` has reached the state the sweep wanted it in.
 * Neither is worth a word to the user.
 */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sweepPreservedArtifacts(input: RetentionSweepInput): RetentionSweep {
  const removed: string[] = [];
  const failures: string[] = [];
  const referenced = new Set(input.referenced);
  const cutoff = input.now - input.retainDays * DAY_MS;

  // The one input whose failure mode is not "sweep less" but "sweep EVERYTHING": a
  // window of zero, a negative one, or a `NaN` one puts the cutoff at or after `now`,
  // and with `NaN` every age comparison is false so nothing looks young at all. The
  // overlay schema refuses such a value on the config path, but this is a public seam
  // and the asymmetry is worth a guard of its own — sweeping less than asked is a
  // stale file, sweeping more is destroyed evidence.
  if (!Number.isFinite(cutoff) || !(input.retainDays > 0)) {
    return {
      removed,
      failures: [
        `nothing was swept: the retention window (${input.retainDays} day(s) against a clock of ` +
          `${input.now}) is not a usable one, and a window Orca cannot read is never read as zero`,
      ],
    };
  }

  for (const kind of SWEPT_KINDS) {
    const directory = join(input.stateRoot, kind.directory);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (!isMissing(error)) failures.push(`${directory} could not be listed (${messageOf(error)})`);
      continue;
    }

    for (const name of names) {
      if (!kind.expires(name)) continue;
      const path = join(directory, name);
      if (referenced.has(path)) continue;
      try {
        // `lstat`, not `stat`: only a REGULAR file is ever swept. A symlink named like
        // an artifact would otherwise be aged by whatever it points at, and while the
        // `unlink` would remove only the link, deciding its fate from another file's
        // timestamp is not a decision retention should be making.
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
        unlinkSync(path);
        removed.push(path);
      } catch (error) {
        if (!isMissing(error)) failures.push(`${path} could not be removed (${messageOf(error)})`);
      }
    }
  }
  return { removed: removed.sort(), failures };
}
