import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CompiledGrant } from "./resolver";
import { checkGrant } from "./grant";
import { COMMIT_CONFIG, gitFailure, gitRaw, gitText, tryGit } from "./git";

/**
 * The staging seam and the promotion gate (staged-promotion plan, Phases 2–3;
 * PRD items 2, 3 and the minimal part of item 5).
 *
 * A delegated session never edits the user's checkout. It runs instead in an
 * ISOLATED CHECKOUT that a {@link StagingProvider} prepares: the user's `HEAD`
 * plus their materialized dirty overlay, capped by a synthetic baseline commit.
 * Mutation accountability gates writes inside that checkout, and nothing leaves
 * it except through the two-part gate below.
 *
 * The gate is two-part because a delegation SEQUENCE is one transaction over one
 * shared checkout (Phase 3):
 *
 * - {@link commitAuthorizedWork} runs once per owner, as that owner finishes:
 *   every path the owner changed is authorized against ITS OWN compiled grant and
 *   the result is committed inside staging. The next owner therefore starts from
 *   accepted work, and each staged commit is attributable to exactly one grant.
 * - {@link promoteStagedCommits} runs once per sequence, after the last owner:
 *   it diffs the baseline against the last staged COMMIT — never the worktree — so
 *   only content that already passed a per-owner authorization can reach the
 *   user's files, and it reaches them as one patch or not at all.
 *
 * A single-owner delegation is the degenerate case of exactly that: one
 * authorized staged commit, then one promotion.
 *
 * The split in this module is the point:
 *
 * - HOW an isolated checkout is produced is a provider concern
 *   ({@link StagingProvider}). `staging-worktree.ts` supplies the only current
 *   implementation, `git worktree`. A copy-on-write provider (APFS `clonefile`,
 *   btrfs subvolume) is a drop-in alternative — it satisfies the same contract
 *   and nothing below has to change.
 * - WHAT may leave staging is not. The promotion gate here is git-native and
 *   provider-independent: it diffs the checkout against its baseline commit,
 *   authorizes each path, and applies the result with `git apply`. Every provider
 *   funnels through this one gate, so a new provider cannot invent a laxer path
 *   to the user's files.
 *
 * Two invariants are structural rather than conventional:
 *
 * - Git runs only through `git.ts`, argv-only, so nothing is shell-interpolated.
 * - The isolated checkout is torn down on EVERY exit path (the caller's
 *   `finally`); a preserved patch is written OUTSIDE it, so evidence survives
 *   cleanup.
 *
 * A repository that cannot be staged gets no silent in-place fallback: the
 * provider refuses with a diagnostic and the delegation never spawns. Explicit
 * degradation is the point — an ungoverned in-place edit is exactly what staging
 * exists to prevent.
 */

/** The subdirectory of the state root holding one isolated checkout per delegation. */
export const CHECKOUTS_DIR = "worktrees";

/** The subdirectory of the state root holding patches preserved as evidence. */
export const PATCHES_DIR = "patches";

/** The commit message of the synthetic baseline the cumulative diff is taken against. */
export const BASELINE_MESSAGE = "orca staged baseline (HEAD + dirty overlay)";

/** The commit-message prefix of one owner's authorized staged change. */
export const STEP_MESSAGE_PREFIX = "orca staged step";

/**
 * The runtime state directory for staged checkouts and preserved patches. It
 * follows the one state-directory convention the extension already uses — pi's
 * agent directory (`session-runner.ts` hands the same `getAgentDir()` to the
 * child's resource loader) — under an `orca/` subtree, and therefore honors pi's
 * own `PI_CODING_AGENT_DIR` override.
 */
export function defaultStateRoot(): string {
  return join(getAgentDir(), "orca");
}

/**
 * One prepared staging workspace: an isolated checkout, valid until the provider
 * closes it.
 *
 * This is the whole contract between a provider and the promotion gate. A
 * provider MUST guarantee, for the workspace it returns:
 *
 * 1. {@link dir} is a git working tree outside the user's working tree, whose
 *    content equals the user's working tree for every non-ignored path (`HEAD`
 *    plus the dirty overlay: staged, unstaged, and non-ignored untracked files).
 * 2. Its `HEAD` is {@link baselineCommit}, a commit whose tree is exactly that
 *    content — so a diff of {@link dir} against {@link baselineCommit} is the
 *    delegation's cumulative change and nothing else.
 * 3. {@link baseCommit} is the user's `HEAD` at the moment staging began.
 *
 * Given those three, promotion works identically for any provider.
 */
export interface StagedWorkspace {
  /** Canonical root of the user's checkout (never written during the delegation). */
  repoRoot: string;
  /** Canonical isolated checkout; the child session's `cwd`. */
  dir: string;
  /** `HEAD` at staging time; re-verified before promotion (minimal base guard). */
  baseCommit: string;
  /** The synthetic baseline commit inside the checkout; the diff's left side. */
  baselineCommit: string;
  /** Where a patch is preserved when it is not promoted. */
  patchPath: string;
  /** Which provider produced this workspace, for diagnostics. */
  provider: string;
}

/** What a provider is asked for. */
export interface OpenStagingInput {
  /** Any directory inside the user's repository. */
  cwd: string;
  /** Identity of the delegation; names its subdirectory under the state root. */
  delegationId: string;
  /** Runtime state root; defaults to {@link defaultStateRoot}. */
  stateRoot?: string;
}

/** Opening a workspace either yields one or refuses with human-readable diagnostics. */
export type OpenStagingResult =
  | { ok: true; workspace: StagedWorkspace }
  | { ok: false; diagnostics: string[] };

/**
 * A strategy for isolating a delegation's work from the user's checkout.
 *
 * Implementations differ only in HOW they produce the isolated checkout and how
 * they dispose of it; the {@link StagedWorkspace} contract above is what they all
 * promise, and the promotion gate in this module is what they all go through.
 * Keep the surface at exactly these two operations — anything more and providers
 * start owning policy that belongs to the gate.
 */
export interface StagingProvider {
  /** Provider name, surfaced in diagnostics and evidence. */
  readonly name: string;
  /** Prepare an isolated checkout, or refuse with diagnostics. */
  open(input: OpenStagingInput): OpenStagingResult;
  /**
   * Dispose of the checkout and any metadata it created. Must be safe to call on
   * every exit path and more than once, and must never throw: cleanup runs in a
   * `finally` and must not mask the outcome that got it there.
   */
  close(workspace: StagedWorkspace): void;
}

/** Resolve where a delegation's checkout and preserved patch belong. */
export function stagingPaths(input: OpenStagingInput): {
  stateRoot: string;
  dir: string;
  patchPath: string;
} {
  const stateRoot = input.stateRoot ?? defaultStateRoot();
  const segment = safeSegment(input.delegationId);
  return {
    stateRoot,
    dir: join(stateRoot, CHECKOUTS_DIR, segment),
    patchPath: join(stateRoot, PATCHES_DIR, `${segment}.patch`),
  };
}

/** A filesystem-safe directory name for a delegation identity. */
function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned.length > 0 ? cleaned : "delegation";
}

/**
 * Commit everything currently in the isolated checkout and report the commit id.
 * The pinned identity and disabled signing keep a staged commit from depending on
 * (or being broken by) the user's global git configuration: an unset `user.email`
 * or `commit.gpgsign = true` would otherwise fail an otherwise valid delegation.
 * Hooks are skipped for the same reason — a repository's own hooks are the user's,
 * not something a staged commit may run.
 */
function commitStagedTree(dir: string, message: string): string {
  gitRaw(dir, ["add", "-A"]);
  gitRaw(dir, [...COMMIT_CONFIG, "commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
  return gitText(dir, ["rev-parse", "HEAD"]).trim();
}

/**
 * Commit the isolated checkout's current content as its synthetic baseline and
 * report the commit id. Shared by every provider: whatever mechanism produced the
 * checkout, the baseline it will be diffed against is made the same way, so
 * clause 2 of the {@link StagedWorkspace} contract cannot drift between providers.
 */
export function commitStagedBaseline(dir: string): string {
  return commitStagedTree(dir, BASELINE_MESSAGE);
}

// --- The promotion gate (provider-independent) --------------------------------

/** What the promotion gate did with the staged change. */
export type PromotionStatus = "promoted" | "rejected" | "conflict" | "not_attempted";

/**
 * The steward-facing record of one promotion attempt. {@link appliedPaths} is
 * non-empty only for `promoted`; {@link patchPath} points at the preserved patch
 * whenever a non-empty change was not applied, so the work is recoverable.
 */
export interface PromotionRecord {
  status: PromotionStatus;
  /** Repository-relative paths applied to the user's checkout (sorted). */
  appliedPaths: string[];
  /** Changed paths the grant did not authorize; they fail the whole promotion. */
  rejectedPaths: string[];
  /** Absolute path of the preserved patch, when one was written. */
  patchPath?: string;
  /** Why the gate reached this status, in the words the steward reads. */
  diagnostics: string[];
}

/** The change of an isolated checkout against one of its commits. */
export interface StagedDiff {
  /** A binary-safe patch, empty when nothing changed. */
  patch: Buffer;
  /** Every changed repository-relative path, sorted. */
  paths: string[];
}

/**
 * The diff of the isolated checkout's WORKING TREE against `ref`. Staging
 * everything first (`git add -A`) makes newly created files part of the diff while
 * still honoring `.gitignore` — an ignored file is not repository content and is
 * never promoted. Renames are not detected, so every change is an add, delete, or
 * modify of a single path and can be authorized on its own.
 */
function worktreeDiff(dir: string, ref: string): StagedDiff {
  gitRaw(dir, ["add", "-A"]);
  const names = gitText(dir, ["diff", "--cached", "--no-renames", "--name-only", "-z", ref]);
  const patch = gitRaw(dir, ["diff", "--cached", "--binary", "--no-renames", ref]);
  return { patch, paths: names.split("\0").filter(Boolean).sort() };
}

/** The diff between two commits inside the isolated checkout. */
function commitDiff(dir: string, from: string, to: string): StagedDiff {
  const names = gitText(dir, ["diff", "--no-renames", "--name-only", "-z", from, to]);
  const patch = gitRaw(dir, ["diff", "--binary", "--no-renames", from, to]);
  return { patch, paths: names.split("\0").filter(Boolean).sort() };
}

/**
 * The cumulative diff of the isolated checkout's working tree against its
 * synthetic baseline: everything the delegation left behind, authorized or not.
 * This is the EVIDENCE view — what a preserved patch contains — and deliberately
 * not what promotion applies (see {@link promoteStagedCommits}).
 */
export function stagedDiff(workspace: StagedWorkspace): StagedDiff {
  return worktreeDiff(workspace.dir, workspace.baselineCommit);
}

/** The evidence diff, or nothing when the checkout can no longer be read. */
function tryStagedDiff(workspace: StagedWorkspace): StagedDiff {
  try {
    return stagedDiff(workspace);
  } catch {
    return { patch: Buffer.alloc(0), paths: [] };
  }
}

/** Write a patch into the state directory as evidence; returns its path. */
function preservePatch(workspace: StagedWorkspace, patch: Buffer): string | undefined {
  if (patch.length === 0) return undefined;
  mkdirSync(dirname(workspace.patchPath), { recursive: true });
  writeFileSync(workspace.patchPath, patch);
  return workspace.patchPath;
}

function refused(
  workspace: StagedWorkspace,
  status: Exclude<PromotionStatus, "promoted">,
  diff: StagedDiff,
  rejectedPaths: string[],
  diagnostics: string[],
): PromotionRecord {
  const patchPath = preservePatch(workspace, diff.patch);
  return {
    status,
    appliedPaths: [],
    rejectedPaths,
    patchPath,
    diagnostics: [
      ...diagnostics,
      patchPath
        ? `Nothing was applied; your checkout is unchanged. The staged patch is preserved at ${patchPath}.`
        : "Nothing was applied; the delegation produced no change to preserve.",
    ],
  };
}

/** What the per-owner staging gate did with one owner's change. */
export type StagedCommitStatus = "committed" | "rejected" | "not_attempted";

/**
 * The record of one owner's pass through the per-owner half of the gate. Only a
 * `committed` record can contribute to a promotion, and {@link commit} is the
 * staged commit the next owner starts from.
 */
export interface StagedCommitRecord {
  status: StagedCommitStatus;
  /** Who the staged commit belongs to, for diagnostics and the commit message. */
  label: string;
  /** Repository-relative paths this owner changed (sorted). */
  paths: string[];
  /** Paths this owner's own grant did not authorize; they fail the step. */
  rejectedPaths: string[];
  /** The staged commit id, present exactly when {@link status} is `committed`. */
  commit?: string;
  diagnostics: string[];
}

/**
 * The per-owner half of the gate: authorize everything this owner changed against
 * ITS OWN compiled grant and, if all of it is authorized, commit it inside
 * staging.
 *
 * A single unauthorized path fails the whole step rather than being filtered out,
 * so a partial commit is never invented from a change the grant did not cover —
 * and because the refusal leaves the change uncommitted, it can never be promoted
 * (promotion reads commits, not the worktree). The commit is what makes a
 * multi-owner sequence work: the next owner starts from accepted work, and every
 * promoted path traces back to the one grant that authorized it.
 *
 * Like the rest of the gate this never throws; a git failure becomes a `rejected`
 * record with the reason in its diagnostics.
 */
export function commitAuthorizedWork(
  workspace: StagedWorkspace,
  grant: CompiledGrant,
  label: string,
): StagedCommitRecord {
  let diff: StagedDiff;
  try {
    diff = worktreeDiff(workspace.dir, "HEAD");
  } catch (error) {
    return {
      status: "rejected",
      label,
      paths: [],
      rejectedPaths: [],
      diagnostics: [
        `Orca could not compute the staged change for promotion (${gitFailure(error)}).`,
      ],
    };
  }

  const unauthorized = diff.paths.filter((path) => !checkGrant(grant, "write", path).allowed);
  if (unauthorized.length > 0) {
    return {
      status: "rejected",
      label,
      paths: diff.paths,
      rejectedPaths: unauthorized,
      diagnostics: [
        `The staged change made by '${label}' touches path(s) outside its write grant: ` +
          `${unauthorized.join(", ")}.`,
      ],
    };
  }

  try {
    const commit = commitStagedTree(workspace.dir, `${STEP_MESSAGE_PREFIX}: ${label}`);
    return {
      status: "committed",
      label,
      paths: diff.paths,
      rejectedPaths: [],
      commit,
      diagnostics: [
        diff.paths.length > 0
          ? `Committed ${diff.paths.length} authorized path(s) in staging for '${label}'.`
          : `'${label}' changed no files; nothing was committed in staging for it.`,
      ],
    };
  } catch (error) {
    return {
      status: "rejected",
      label,
      paths: diff.paths,
      rejectedPaths: [],
      diagnostics: [
        `Orca could not commit '${label}'s authorized change in staging (${gitFailure(error)}).`,
      ],
    };
  }
}

/**
 * The once-per-sequence half of the gate: apply the accumulated authorized staged
 * commits to the user's checkout, or refuse and preserve them.
 *
 * The order is deliberate. Every step must have committed, because an owner whose
 * change was not authorized must not have its work reach the checkout inside
 * somebody else's patch — one refused step fails the WHOLE promotion. Then the
 * minimal base guard: `HEAD` must still be the commit staging started from, or the
 * patch's base is stale and the outcome is a `conflict`. Only then is the patch
 * offered to `git apply --check` and, if that passes, applied.
 *
 * The patch is the diff between the synthetic baseline and the LAST STAGED COMMIT,
 * not the worktree, so anything a session left uncommitted — including a change no
 * grant authorized — is structurally excluded from what can be promoted. The
 * preserved evidence patch is the worktree view, because evidence should show
 * everything that happened.
 *
 * This never throws: a promotion failure must not destroy the delegation's
 * outcome, so an unexpected git error becomes a `rejected` record with the reason
 * in its diagnostics.
 */
export function promoteStagedCommits(
  workspace: StagedWorkspace,
  staged: readonly StagedCommitRecord[],
): PromotionRecord {
  const refusedSteps = staged.filter((step) => step.status !== "committed");
  if (refusedSteps.length > 0) {
    return refused(
      workspace,
      "rejected",
      tryStagedDiff(workspace),
      [...new Set(refusedSteps.flatMap((step) => step.rejectedPaths))].sort(),
      [
        "Orca refused to promote this delegation: not every step's change was authorized and " +
          "committed in staging.",
        ...refusedSteps.flatMap((step) => step.diagnostics),
      ],
    );
  }

  let diff: StagedDiff;
  try {
    const head = gitText(workspace.dir, ["rev-parse", "HEAD"]).trim();
    diff = commitDiff(workspace.dir, workspace.baselineCommit, head);
  } catch (error) {
    return {
      status: "rejected",
      appliedPaths: [],
      rejectedPaths: [],
      diagnostics: [
        `Orca could not compute the staged change for promotion (${gitFailure(error)}). ` +
          "Nothing was applied; your checkout is unchanged.",
      ],
    };
  }

  const head = tryGit(workspace.repoRoot, ["rev-parse", "HEAD"]);
  const currentHead = head.ok ? head.out.toString("utf8").trim() : undefined;
  if (currentHead !== workspace.baseCommit) {
    return refused(workspace, "conflict", diff, [], [
      "Orca refused to promote this delegation: HEAD moved while it was running " +
        `(staged from ${workspace.baseCommit}, now ${currentHead ?? "unreadable"}), so the staged ` +
        "change is no longer based on your current commit.",
    ]);
  }

  if (diff.patch.length === 0) {
    return {
      status: "promoted",
      appliedPaths: [],
      rejectedPaths: [],
      diagnostics: ["The delegation changed no files, so there was nothing to promote."],
    };
  }

  const check = tryGit(
    workspace.repoRoot,
    ["apply", "--check", "--whitespace=nowarn"],
    diff.patch,
  );
  if (!check.ok) {
    return refused(workspace, "rejected", diff, [], [
      "Orca refused to promote this delegation: the staged patch does not apply cleanly to your " +
        `checkout (git apply --check failed: ${check.reason}).`,
    ]);
  }

  const applied = tryGit(workspace.repoRoot, ["apply", "--whitespace=nowarn"], diff.patch);
  if (!applied.ok) {
    return refused(workspace, "rejected", diff, [], [
      `Orca could not apply the staged patch to your checkout (${applied.reason}).`,
    ]);
  }

  return {
    status: "promoted",
    appliedPaths: diff.paths,
    rejectedPaths: [],
    diagnostics: [
      `Promoted ${diff.paths.length} authorized path(s) to your checkout as unstaged changes.`,
    ],
  };
}

/**
 * Record that promotion was never attempted — the delegation did not complete —
 * while still preserving whatever it staged, so a failed or cancelled attempt
 * leaves recoverable evidence instead of discarding the work with the checkout.
 * Like {@link promoteStagedCommits} this never throws.
 */
export function abandonStagedWork(workspace: StagedWorkspace, reason: string): PromotionRecord {
  let diff: StagedDiff;
  try {
    diff = stagedDiff(workspace);
  } catch (error) {
    return {
      status: "not_attempted",
      appliedPaths: [],
      rejectedPaths: [],
      diagnostics: [reason, `The staged change could not be read (${gitFailure(error)}).`],
    };
  }
  const patchPath = preservePatch(workspace, diff.patch);
  return {
    status: "not_attempted",
    appliedPaths: [],
    rejectedPaths: [],
    patchPath,
    diagnostics: [
      reason,
      patchPath
        ? `Your checkout is unchanged. The staged patch is preserved at ${patchPath}.`
        : "Your checkout is unchanged; the delegation staged no change to preserve.",
    ],
  };
}

/**
 * One owner's view of the sequence's single promotion.
 *
 * A sequence promotes once, so no owner has a promotion of its own; what an owner
 * can honestly report is which of ITS paths the one promotion carried. On a
 * promotion that is its committed paths narrowed to what the cumulative patch
 * actually applied — a path an owner created and a later owner deleted nets out and
 * is not claimed. On any refusal every owner reports the same refusal, because
 * that is what happened to all of them: nothing was applied.
 */
export function stepPromotion(
  sequence: PromotionRecord,
  staged: StagedCommitRecord,
): PromotionRecord {
  if (sequence.status !== "promoted") return sequence;
  const applied = staged.paths.filter((path) => sequence.appliedPaths.includes(path));
  return {
    status: "promoted",
    appliedPaths: applied,
    rejectedPaths: [],
    diagnostics: [
      `Promoted ${applied.length} path(s) from this owner to your checkout, as part of the ` +
        `sequence's single promotion of ${sequence.appliedPaths.length} path(s).`,
    ],
  };
}
