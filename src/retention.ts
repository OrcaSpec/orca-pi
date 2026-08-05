import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { OrcaSpecDocument } from "orcaspec";
import { readRuntimeOverlay, type RuntimeOverlayResult } from "./runtime-overlay";
import {
  EVIDENCE_PATCH_SUFFIX,
  GOVERNANCE_PATCH_SUFFIX,
  PATCHES_DIR,
  VALIDATOR_OUTPUT_DIR,
  VALIDATOR_OUTPUT_SUFFIX,
} from "./staging";

/**
 * Age-based evidence retention (hardening plan, Phase 6).
 *
 * The state directory accumulates. A delegation that does not land preserves its
 * cumulative patch, a `needs_scope` stop preserves the completed owners' reusable one,
 * a refused acceptance gate preserves its validator output, and a crash leaves whatever
 * it had written. All of it is EVIDENCE — useful for exactly as long as something can
 * still point a user at it — so this module expires it on two conditions that must both
 * hold: the file is past a window, and no retained history entry references it.
 *
 * Both halves matter, and the second is the load-bearing one. Age alone would delete
 * the patch a `/orca` history line is still offering as a recovery route, so
 * reference-safety is what makes the sweep unable to leave a dangling pointer;
 * `DelegationHistory.referencedArtifacts` is the operative definition of "referenced",
 * and age only ever reclaims ORPHANS — crash leftovers, and the artifacts of sessions
 * whose entries have aged past the history's capacity.
 *
 * Two things are exempt on principle rather than by age. Held governance patches are
 * never swept, whatever their age and whether or not any history remembers the hold:
 * they are outstanding proposals, and a rule that depended on remembering would delete
 * one precisely when the runtime had forgotten it was owed. And a `worktrees/` checkout
 * is not retention's to remove — staging already deletes it on every exit path and
 * reclaims a crashed one on the next run.
 *
 * The sweep is OPPORTUNISTIC and its failures are inert: it runs at extension
 * activation (`index.ts`), where no delegation is in flight, so "a sweep failure never
 * blocks a delegation" is a fact about where it is called from rather than a promise
 * about how carefully it handles errors. Nothing here throws, either way.
 *
 * One residual worth stating: {@link defaultStateRoot} is pi's agent directory, which is
 * shared across every repository on the machine, while the reference set comes from the
 * ONE session doing the sweeping. A 30-day-old artifact belonging to another repository's
 * still-open session is therefore reclaimable. It takes a session left open longer than
 * the window with the delegation still inside its visible history, it costs a pointer to
 * evidence rather than anything in a checkout, and an embedding that gives each
 * repository its own `stateRoot` has no exposure at all.
 */

/** Milliseconds in one retention day. */
const DAY_MS = 86_400_000;

/**
 * How long preserved evidence is kept when a repository does not say otherwise. Thirty
 * days is long enough that a patch is still there when someone comes back to the work
 * after a fortnight away, and short enough that the state directory does not grow
 * without bound.
 */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * The window in force for a repository, or `undefined` when nothing may be swept.
 *
 * An UNUSABLE overlay is the interesting case, and it does not sweep. The window is
 * configured in the very file that failed to validate, so the runtime does not know
 * whether the user widened it; and since an invalid overlay already refuses every
 * delegation (`runtime-overlay.ts`), nothing new is accumulating to justify guessing.
 * Deleting evidence is the one action here that cannot be taken back, so the unreadable
 * case declines to take it.
 */
export function retentionDaysFor(overlay: RuntimeOverlayResult): number | undefined {
  if (overlay.kind === "invalid") return undefined;
  if (overlay.kind === "absent") return DEFAULT_RETENTION_DAYS;
  return overlay.overlay.retention?.days ?? DEFAULT_RETENTION_DAYS;
}

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
    // One `.patch` test covers two of the three kinds, because the reusable accepted
    // patch's suffix ENDS in the evidence one (`ACCEPTED_PATCH_SUFFIX`); spelling
    // it out again would be a clause that cannot change the answer. The third kind is
    // the carve-out, and it is tested first so it wins an otherwise ambiguous name: a
    // delegation whose own id ends in `.governance` writes its cumulative patch to a
    // file indistinguishable from another delegation's held patch. Erring toward
    // retention costs a stale file; erring the other way deletes a proposal.
    expires: (name) =>
      !name.endsWith(GOVERNANCE_PATCH_SUFFIX) && name.endsWith(EVIDENCE_PATCH_SUFFIX),
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
        // `>=` RETAINS the boundary: an artifact exactly `retainDays` old has not been
        // kept for longer than the window, and a window is a promise about how long
        // evidence survives, so it is honored down to its final millisecond.
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        unlinkSync(path);
        removed.push(path);
      } catch (error) {
        if (!isMissing(error)) failures.push(`${path} could not be removed (${messageOf(error)})`);
      }
    }
  }
  return { removed: removed.sort(), failures };
}

/** What an activation-time sweep needs to know about the repository it is sweeping for. */
export interface RetentionSweepRequest {
  /** The user's checkout, where the overlay carrying the window is read from. */
  cwd: string;
  /** The validated document the overlay is checked against (`runtime-overlay.ts`). */
  document: OrcaSpecDocument;
  /** Root of the runtime state directory holding the artifacts. */
  stateRoot: string;
  now: number;
  /** Every artifact the visible history can still point at; see `delegation-entry.ts`. */
  referenced: Iterable<string>;
}

/**
 * The whole sweep as activation performs it: read the window, apply it, and never let
 * any of it reach the caller as a throw. `undefined` means no sweep happened — the
 * overlay was unusable, so no window could be trusted (see {@link retentionDaysFor}).
 *
 * The overlay read is inside the guard on purpose. `readRuntimeOverlay` touches the
 * filesystem, and a `.orca/runtime.yaml` that exists but cannot be read would otherwise
 * throw out of a `session_start` handler and break activation over housekeeping.
 */
export function runRetentionSweep(request: RetentionSweepRequest): RetentionSweep | undefined {
  try {
    const retainDays = retentionDaysFor(readRuntimeOverlay(request.cwd, request.document));
    if (retainDays === undefined) return undefined;
    return sweepPreservedArtifacts({
      stateRoot: request.stateRoot,
      now: request.now,
      retainDays,
      referenced: request.referenced,
    });
  } catch (error) {
    return {
      removed: [],
      failures: [`the retention sweep could not run (${messageOf(error)})`],
    };
  }
}

/**
 * The one line a sweep contributes to `/orca`, or nothing.
 *
 * Silent unless something actually happened, which is the common case by a wide margin:
 * most activations find every artifact either young or referenced, and a status surface
 * that announced "expired 0 files" on every session start would be pure noise. When
 * files did go, or when the sweep could not do its job, the user gets exactly one line
 * — enough to explain a missing patch or a state directory that is not shrinking.
 */
export function retentionSweepLine(sweep: RetentionSweep | undefined): string | undefined {
  if (!sweep) return undefined;
  if (sweep.removed.length === 0 && sweep.failures.length === 0) return undefined;
  const expired = `expired ${sweep.removed.length} preserved artifact(s) past the retention window`;
  const failed =
    sweep.failures.length > 0 ? `; ${sweep.failures.length} could not be removed` : "";
  return `Retention: ${expired}${failed}.`;
}
