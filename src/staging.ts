import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CompiledGrant } from "./resolver";
import { checkGrant } from "./grant";
import { COMMIT_CONFIG, gitFailure, gitRaw, gitText, tryGit } from "./git";

/**
 * The staging seam and the promotion gate (staged-promotion plan, Phases 2–5;
 * PRD items 2, 3, 5).
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
 * - WHAT may leave staging is not. The gate here is git-native and
 *   provider-independent: it authorizes each changed path, commits it, and applies
 *   the accumulated commits with `git apply`. Every provider funnels through this
 *   one gate, so a new provider cannot invent a laxer path to the user's files.
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

/** The subdirectory of the state root holding one isolated checkout per delegation sequence. */
export const CHECKOUTS_DIR = "worktrees";

/** The subdirectory of the state root holding patches preserved as evidence. */
export const PATCHES_DIR = "patches";

/** The subdirectory of the state root holding preserved validator output. */
export const VALIDATOR_OUTPUT_DIR = "validators";

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
 * 3. {@link baseCommit} is the user's `HEAD` at the moment staging began, and
 *    {@link overlayBinding} digests the dirty overlay it staged from. Together they
 *    are the BASE BINDING (Phase 5): the complete description of the state the
 *    delegation's patch will be computed against, re-verified before promotion.
 *
 * Given those three, promotion works identically for any provider.
 */
export interface StagedWorkspace {
  /** Canonical root of the user's checkout (never written during the delegation). */
  repoRoot: string;
  /** Canonical isolated checkout; the child session's `cwd`. */
  dir: string;
  /** `HEAD` at staging time; half of the base binding (see {@link overlayBinding}). */
  baseCommit: string;
  /**
   * The other half: one digest per dirty-overlay path, as the user's checkout held
   * it when staging began. Produced by {@link captureOverlayBinding} so every
   * provider measures the same thing the same way.
   */
  overlayBinding: OverlayBinding;
  /** The synthetic baseline commit inside the checkout; the diff's left side. */
  baselineCommit: string;
  /** Where a patch is preserved when it is not promoted. */
  patchPath: string;
  /** Where validator output is preserved when the acceptance gate refuses. */
  validatorOutputPath: string;
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

/** Resolve where a delegation's checkout and its preserved evidence belong. */
export function stagingPaths(input: OpenStagingInput): {
  stateRoot: string;
  dir: string;
  patchPath: string;
  validatorOutputPath: string;
} {
  const stateRoot = input.stateRoot ?? defaultStateRoot();
  const segment = safeSegment(input.delegationId);
  return {
    stateRoot,
    dir: join(stateRoot, CHECKOUTS_DIR, segment),
    patchPath: join(stateRoot, PATCHES_DIR, `${segment}.patch`),
    validatorOutputPath: join(stateRoot, VALIDATOR_OUTPUT_DIR, `${segment}.log`),
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

// --- The base binding (staged-promotion plan, Phase 5) ------------------------

/**
 * One digest per dirty-overlay path: what the user's uncommitted state contained
 * when staging began.
 *
 * A `Map` rather than an object because the keys are repository paths and a
 * repository may contain a file called `__proto__`; a plain object would let that
 * path collide with `Object.prototype`. It is held IN MEMORY on the workspace and
 * never persisted: the binding is meaningful only for the life of the one sequence
 * that staged it, so persisting it would create a second source of truth and a
 * stale-file problem. What outlives the sequence is the {@link PromotionRecord} —
 * the drifted paths and the preserved patch — which is what a later session and the
 * `/orca` history actually need.
 */
export type OverlayBinding = ReadonlyMap<string, string>;

/**
 * Every path the user's dirty overlay covers: staged, unstaged, and non-ignored
 * untracked files, one record per path.
 *
 * This is THE definition of the overlay set, shared by the two things that must
 * agree about it: the provider materializing the overlay into the isolated checkout
 * (`staging-worktree.ts`) and {@link captureOverlayBinding} digesting it. If they
 * enumerated separately, a delegation could be bound to a set of files different
 * from the set it was staged from, which is the exact class of bug the binding
 * exists to catch.
 */
export function dirtyOverlayPaths(repoRoot: string): string[] {
  const status = gitText(repoRoot, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  // Porcelain v1 records are `XY <path>`, NUL-terminated; `--no-renames` keeps
  // every record single-pathed so no second path can be mistaken for a status.
  return status
    .split("\0")
    .filter((entry) => entry.length >= 4)
    .map((entry) => entry.slice(3));
}

/**
 * The digest of one overlay path as it exists on disk.
 *
 * What is digested is CONTENT plus the two things git itself tracks about a
 * working-tree file — whether it is a symlink, and whether it is executable — so a
 * `chmod +x` counts as drift while a `chmod g-r` does not. What is deliberately NOT
 * digested is the INDEX: promotion applies its patch to the working tree, so a
 * `git add` of unchanged bytes moves nothing the patch depends on, and treating it
 * as drift would cost the user a promotion for staging a file they had already
 * edited before the delegation started.
 *
 * `sha256` over content rather than a size/mtime pair: mtime is unreliable across
 * editors and filesystems, and size collides on any same-length edit. The cost is
 * bounded by the overlay — the same files staging already copies once.
 */
function overlayDigest(absolute: string): string {
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return `symlink:${digestOf(Buffer.from(readlinkSync(absolute)))}`;
    // Anything that is neither a file nor a symlink is a dirty submodule, which the
    // MVP does not stage and therefore does not bind (see `staging-worktree.ts`).
    if (!stat.isFile()) return "other";
    return `${(stat.mode & 0o111) !== 0 ? "exec" : "file"}:${digestOf(readFileSync(absolute))}`;
  } catch {
    // Gone, or no longer readable. Symmetric on both sides of the comparison: a
    // path that is absent when the binding is captured and still absent when it is
    // verified has not drifted (an uncommitted deletion is a normal overlay state),
    // while one that was readable and now is not has.
    return "absent";
  }
}

function digestOf(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Digest `paths` as they exist under `root`. The caller supplies the enumeration
 * (from {@link dirtyOverlayPaths}) so the set that is bound is exactly the set that
 * was staged, taken from ONE `git status`.
 */
export function captureOverlayBinding(root: string, paths: readonly string[]): OverlayBinding {
  return new Map(paths.map((path) => [path, overlayDigest(join(root, path))]));
}

/**
 * How the user's checkout has moved away from the base a workspace was staged
 * from. Any of the three fields being present means the staged patch's base no
 * longer exists, so nothing may be applied.
 */
export interface BaseDrift {
  /** The user's `HEAD` now, when it is no longer the commit staging began from. */
  head?: string;
  /** Paths whose content the user changed since staging began (sorted). */
  paths: string[];
  /** Why the base could not be re-read at all, when that is what happened. */
  unreadable?: string;
}

/**
 * Re-verify the base binding against the user's checkout, and report the drift, or
 * `undefined` when the base is exactly what the delegation was staged from.
 *
 * Two classes of path are checked, and the difference matters:
 *
 * - Every path in the binding, by re-digesting it. This catches an edit, a
 *   revert, a deletion, a restoration, and a `chmod +x` of a file the user already
 *   had uncommitted work in — the patch was computed against that content.
 * - Paths NOT in the binding, but only where the staged patch touches them and the
 *   user has since made them dirty. At staging time such a path matched `HEAD`, so
 *   "dirty now" means the user has touched it; that is the plan's "added
 *   overlapping files". A path the user made dirty that the patch does NOT touch is
 *   ignored on purpose: refusing a promotion because the user edited an unrelated
 *   file would make every long delegation a coin flip.
 *
 * Overlap is compared by exact path, not by prefix. A structural collision that
 * exact paths cannot see — the user creating a DIRECTORY where the patch creates a
 * file — is left to git, which refuses it when the patch is offered; that refusal is
 * a `rejected`, because nothing the user did to a BOUND path moved.
 *
 * A base that cannot be read at all is drift too, not a pass: an unverifiable base
 * is indistinguishable from a moved one, and the fail-closed reading is the only
 * safe one.
 */
export function detectBaseDrift(
  workspace: StagedWorkspace,
  patchPaths: readonly string[],
): BaseDrift | undefined {
  const head = tryGit(workspace.repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return { paths: [], unreadable: `your repository's HEAD could not be read (${head.reason})` };
  }
  const currentHead = head.out.toString("utf8").trim();

  let dirtyNow: Set<string>;
  try {
    dirtyNow = new Set(dirtyOverlayPaths(workspace.repoRoot));
  } catch (error) {
    return {
      paths: [],
      unreadable: `your working state could not be re-read (${gitFailure(error)})`,
    };
  }

  const drifted = new Set<string>();
  for (const [path, digest] of workspace.overlayBinding) {
    if (overlayDigest(join(workspace.repoRoot, path)) !== digest) drifted.add(path);
  }
  for (const path of patchPaths) {
    if (workspace.overlayBinding.has(path)) continue;
    if (dirtyNow.has(path)) drifted.add(path);
  }

  const moved = currentHead !== workspace.baseCommit;
  if (!moved && drifted.size === 0) return undefined;
  return {
    head: moved ? currentHead : undefined,
    paths: [...drifted].sort(),
  };
}

// --- The promotion gate (provider-independent) --------------------------------

/**
 * What the promotion gate did with the staged change.
 *
 * The line between the two refusals is which side needs attention, and it is worth
 * keeping sharp: `rejected` is about the CHANGE — a path no grant authorized, a
 * validator that did not pass, a patch git will not take — so the delegation is what
 * has to be different. `conflict` is about the BASE: the work is sound and the state
 * it was built on is gone, so the answer is to recover the preserved patch or
 * delegate again, and nothing about the delegation would have helped.
 * `not_attempted` means the delegation never reached the gate at all.
 */
export type PromotionStatus = "promoted" | "rejected" | "conflict" | "not_attempted";

/**
 * How one declared validator ended. `unavailable` covers a validator that could
 * not be started at all (a program that is not on this machine, a declared `cwd`
 * that does not exist in the checkout); like the other two failures it refuses the
 * promotion, because a declared check that did not run is not a check that passed.
 */
export type ValidatorStatus = "passed" | "failed" | "timed_out" | "unavailable";

/**
 * One run of one declared validator (`runtime.yaml`, see `validators.ts`).
 *
 * Distinct from the `ValidationEvidence` on a checkpoint: that is the agent's own
 * account of what it verified — advisory metadata, believed only as far as the
 * agent is honest — while this is the runtime's own observation of a program it
 * executed itself. Only this one gates a promotion.
 */
export interface ValidatorRun {
  /** The OrcaSpec agent id whose declaration this run came from. */
  agent: string;
  program: string;
  /** Arguments as declared; recorded as an array because that is how they are passed. */
  args: string[];
  /** Repository-relative directory it ran in; `""` is the checkout root. */
  cwd: string;
  timeoutSeconds: number;
  status: ValidatorStatus;
  /** Exit code, when the process ran to completion. */
  exitCode?: number;
  /** Terminating signal, when one killed it (including the timeout's). */
  signal?: string;
  /** Captured stdout, truncated for evidence. */
  stdout: string;
  /** Captured stderr, truncated for evidence. */
  stderr: string;
}

/**
 * What an acceptance gate decided about the staged work as a whole. `ok: false`
 * refuses the promotion; {@link validations} is recorded either way, so a steward
 * can see what gated (or cleared) their change.
 */
export interface AcceptanceResult {
  ok: boolean;
  validations: ValidatorRun[];
  /** Absolute path of preserved validator output, when any was written. */
  validatorOutputPath?: string;
  diagnostics: string[];
}

/**
 * The seam through which anything other than authorization can refuse a
 * promotion. `validators.ts` supplies the only implementation — the programs
 * `.orca/runtime.yaml` declares — and this module owns WHEN it runs: after every
 * owner's change is authorized and committed, so the gate sees the sequence's
 * complete work, and before a single byte reaches the user's checkout.
 *
 * A gate may write into the checkout (a test run leaves caches; a formatter
 * rewrites files) and it does not matter: promotion applies the diff between
 * COMMITS, so nothing a gate does to the working tree can ride along.
 */
export type AcceptanceGate = (workspace: StagedWorkspace) => AcceptanceResult;

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
  /**
   * Paths in the user's own checkout that moved while the delegation ran, on a
   * `conflict`. Non-empty only there, and distinct from {@link rejectedPaths}: a
   * rejected path is something the DELEGATION was not allowed to change, a drifted
   * path is something the USER changed under it.
   */
  driftedPaths: string[];
  /** Absolute path of the preserved patch, when one was written. */
  patchPath?: string;
  /**
   * Every declared validator that ran as the acceptance gate, in the order they
   * ran. Empty when the repository declared none, or when the promotion was
   * refused before the gate was reached.
   */
  validations: ValidatorRun[];
  /** Absolute path of preserved validator output, when any was written. */
  validatorOutputPath?: string;
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

/** {@link commitDiff} where a git failure is an outcome the gate reports, not a throw. */
function tryCommitDiff(
  dir: string,
  from: string,
  to: string,
): { ok: true; diff: StagedDiff } | { ok: false; reason: string } {
  try {
    return { ok: true, diff: commitDiff(dir, from, to) };
  } catch (error) {
    return { ok: false, reason: gitFailure(error) };
  }
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
  diff: StagedDiff,
  rejectedPaths: string[],
  diagnostics: string[],
  acceptance?: AcceptanceResult,
): PromotionRecord {
  const patchPath = preservePatch(workspace, diff.patch);
  return {
    status: "rejected",
    appliedPaths: [],
    rejectedPaths,
    driftedPaths: [],
    patchPath,
    validations: acceptance?.validations ?? [],
    validatorOutputPath: acceptance?.validatorOutputPath,
    diagnostics: [
      ...diagnostics,
      patchPath
        ? `Nothing was applied; your checkout is unchanged. The staged patch is preserved at ${patchPath}.`
        : "Nothing was applied; the delegation produced no change to preserve.",
    ],
  };
}

/**
 * The refusal for a base that moved: the delegation's work is sound, but the state
 * it was built on is gone, so applying it would silently interleave the staged
 * change with whatever the user did meanwhile.
 *
 * This is the one refusal that comes with a RECOVERY ROUTE rather than a fix. There
 * is nothing for the delegation to do differently — the user moved — so the record
 * names what moved, where the work is, and the two ways to get it: apply the
 * preserved patch by hand (which is why the patch is a real `git apply` input, not a
 * summary), or delegate again so the work is re-staged on the current base.
 */
function conflicted(
  workspace: StagedWorkspace,
  diff: StagedDiff,
  drift: BaseDrift,
  acceptance?: AcceptanceResult,
): PromotionRecord {
  const patchPath = preservePatch(workspace, diff.patch);
  const diagnostics = [
    "Orca refused to promote this delegation: your checkout moved while it was running, so the " +
      "staged change is no longer based on the state it was made from.",
  ];
  if (drift.head) {
    diagnostics.push(
      `HEAD moved: the delegation was staged from ${workspace.baseCommit}, your checkout is now at ` +
        `${drift.head}.`,
    );
  }
  if (drift.paths.length > 0) {
    diagnostics.push(
      `Changed in your checkout since the delegation started (${drift.paths.length}): ` +
        `${drift.paths.join(", ")}.`,
    );
  }
  if (drift.unreadable) diagnostics.push(`Orca could not verify your base: ${drift.unreadable}.`);
  diagnostics.push(
    patchPath
      ? `Nothing was applied; your checkout is unchanged. The staged patch is preserved at ${patchPath}.`
      : "Nothing was applied; the delegation produced no change to preserve.",
  );
  if (patchPath) {
    diagnostics.push(
      `To recover the work: apply it yourself with \`git apply ${patchPath}\` (add \`--3way\` to merge ` +
        "it into your current state), or delegate the task again so it is re-staged on your current base.",
    );
  }
  return {
    status: "conflict",
    appliedPaths: [],
    rejectedPaths: [],
    driftedPaths: drift.paths,
    patchPath,
    validations: acceptance?.validations ?? [],
    validatorOutputPath: acceptance?.validatorOutputPath,
    diagnostics,
  };
}

/**
 * The refusal for a staged change git can no longer read. Nothing is applied, and
 * nothing is preserved either — the patch is exactly what could not be computed.
 */
function unreadableStagedChange(reason: string, acceptance?: AcceptanceResult): PromotionRecord {
  return {
    status: "rejected",
    appliedPaths: [],
    rejectedPaths: [],
    driftedPaths: [],
    validations: acceptance?.validations ?? [],
    validatorOutputPath: acceptance?.validatorOutputPath,
    diagnostics: [
      `Orca could not compute the staged change for promotion (${reason}). ` +
        "Nothing was applied; your checkout is unchanged.",
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
 * somebody else's patch — one refused step fails the WHOLE promotion. Then the base
 * binding: the user's `HEAD` and their dirty overlay must both still be what staging
 * began from, or the patch's base is stale and the outcome is a `conflict`. Only
 * then is the patch offered to `git apply --check` and, if that passes, applied.
 *
 * The binding is verified TWICE, bracketing the acceptance gate (Phase 5). Once
 * before, so a stale base is discovered without first spending minutes of the user's
 * time running validators on work nothing can promote; once immediately before the
 * patch is applied, because the gate is arbitrary programs taking arbitrary time and
 * the user is editing their own files throughout. The second check is the one the
 * plan means by "immediately before promotion": it leaves no window wider than
 * `git apply --check` itself, which is the last thing that can catch a base moving
 * out from under the patch.
 *
 * The patch is the diff between the synthetic baseline and the LAST STAGED COMMIT,
 * not the worktree, so anything a session left uncommitted — including a change no
 * grant authorized, and anything the acceptance gate itself wrote — is structurally
 * excluded from what can be promoted.
 *
 * `acceptance` is the optional last word before the patch is applied (Phase 4): the
 * validators `.orca/runtime.yaml` declares, run in the checkout with the sequence's
 * complete work in place. It is consulted AFTER the base guard, because a stale base
 * makes any promotion impossible whatever the validators think, and it is consulted
 * even when the cumulative diff is empty, so a repository's declared checks report
 * honestly on a delegation that changed nothing. Without a gate this function
 * behaves exactly as it did before the phase.
 *
 * This never throws: a promotion failure must not destroy the delegation's
 * outcome, so an unexpected git error becomes a `rejected` record with the reason
 * in its diagnostics.
 */
export function promoteStagedCommits(
  workspace: StagedWorkspace,
  staged: readonly StagedCommitRecord[],
  acceptance?: AcceptanceGate,
): PromotionRecord {
  const refusedSteps = staged.filter((step) => step.status !== "committed");
  if (refusedSteps.length > 0) {
    return refused(
      workspace,
      tryStagedDiff(workspace),
      [...new Set(refusedSteps.flatMap((step) => step.rejectedPaths))].sort(),
      [
        "Orca refused to promote this delegation: not every step's change was authorized and " +
          "committed in staging.",
        ...refusedSteps.flatMap((step) => step.diagnostics),
      ],
    );
  }

  // The staged tip is PINNED here, before anything else runs, and every patch below
  // is the baseline→tip diff of that one commit. Both halves matter once an
  // acceptance gate exists: taking COMMITS excludes whatever the gate writes into
  // the working tree, and pinning the tip excludes a gate that commits in the
  // checkout itself — a validator is arbitrary code with the checkout as its `cwd`,
  // so "the current HEAD" would be something it could move.
  const tip = tryGit(workspace.dir, ["rev-parse", "HEAD"]);
  if (!tip.ok) return unreadableStagedChange(tip.reason);
  const stagedTip = tip.out.toString("utf8").trim();

  const beforeGate = tryCommitDiff(workspace.dir, workspace.baselineCommit, stagedTip);
  if (!beforeGate.ok) return unreadableStagedChange(beforeGate.reason);

  const staleBeforeGate = detectBaseDrift(workspace, beforeGate.diff.paths);
  if (staleBeforeGate) return conflicted(workspace, beforeGate.diff, staleBeforeGate);

  const gate = acceptance?.(workspace);

  // Re-diff AFTER the gate: what is offered to the user's files is computed once the
  // validators have finished doing whatever they do, and it is still only the pinned
  // committed work. A validator cannot smuggle a change into a promotion it cleared,
  // and the patch preserved from a refusal is the delegation's work rather than the
  // delegation's work plus a formatter's opinion of it.
  const afterGate = tryCommitDiff(workspace.dir, workspace.baselineCommit, stagedTip);
  if (!afterGate.ok) return unreadableStagedChange(afterGate.reason, gate);
  const diff = afterGate.diff;

  if (gate && !gate.ok) {
    return refused(
      workspace,
      diff,
      [],
      [
        "Orca refused to promote this delegation: a validator this repository declares in " +
          "`.orca/runtime.yaml` did not pass.",
        ...gate.diagnostics,
      ],
      gate,
    );
  }

  // The base binding again, now that the gate has finished and the next statement
  // would touch the user's files. Everything the acceptance gate did happened inside
  // this window: the programs it ran took real time, and they are arbitrary code that
  // could itself have written into the user's checkout.
  const staleNow = detectBaseDrift(workspace, diff.paths);
  if (staleNow) return conflicted(workspace, diff, staleNow, gate);

  if (diff.patch.length === 0) {
    return {
      status: "promoted",
      appliedPaths: [],
      rejectedPaths: [],
      driftedPaths: [],
      validations: gate?.validations ?? [],
      diagnostics: ["The delegation changed no files, so there was nothing to promote."],
    };
  }

  const check = tryGit(
    workspace.repoRoot,
    ["apply", "--check", "--whitespace=nowarn"],
    diff.patch,
  );
  if (!check.ok) {
    return refused(
      workspace,
      diff,
      [],
      [
        "Orca refused to promote this delegation: the staged patch does not apply cleanly to your " +
          `checkout (git apply --check failed: ${check.reason}).`,
      ],
      gate,
    );
  }

  const applied = tryGit(workspace.repoRoot, ["apply", "--whitespace=nowarn"], diff.patch);
  if (!applied.ok) {
    return refused(
      workspace,
      diff,
      [],
      [`Orca could not apply the staged patch to your checkout (${applied.reason}).`],
      gate,
    );
  }

  return {
    status: "promoted",
    appliedPaths: diff.paths,
    rejectedPaths: [],
    driftedPaths: [],
    validations: gate?.validations ?? [],
    diagnostics: [
      `Promoted ${diff.paths.length} authorized path(s) to your checkout as unstaged changes.`,
      ...(gate ? gate.diagnostics : []),
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
      driftedPaths: [],
      validations: [],
      diagnostics: [reason, `The staged change could not be read (${gitFailure(error)}).`],
    };
  }
  const patchPath = preservePatch(workspace, diff.patch);
  return {
    status: "not_attempted",
    appliedPaths: [],
    rejectedPaths: [],
    driftedPaths: [],
    patchPath,
    validations: [],
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
 *
 * The validator runs are carried through unnarrowed: the acceptance gate ran over
 * the whole sequence's work, so every owner's entry answers the same question with
 * the same evidence — which declared checks decided this promotion.
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
    driftedPaths: [],
    validations: sequence.validations,
    validatorOutputPath: sequence.validatorOutputPath,
    diagnostics: [
      `Promoted ${applied.length} path(s) from this owner to your checkout, as part of the ` +
        `sequence's single promotion of ${sequence.appliedPaths.length} path(s).`,
    ],
  };
}
