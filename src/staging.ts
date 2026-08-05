import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CompiledGrant } from "./resolver";
import { checkGrant } from "./grant";
import { COMMIT_CONFIG, gitFailure, gitRaw, gitText, tryGit } from "./git";

/**
 * The staging seam and the promotion gate (staged-promotion plan, Phase 2; PRD
 * item 2 and the minimal part of item 5).
 *
 * A delegated session never edits the user's checkout. It runs instead in an
 * ISOLATED CHECKOUT that a {@link StagingProvider} prepares: the user's `HEAD`
 * plus their materialized dirty overlay, capped by a synthetic baseline commit.
 * Mutation accountability gates writes inside that checkout, and when the
 * delegation completes, {@link promoteStagedWork} authorizes every changed path
 * against the compiled grant before anything reaches the user's files.
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
 * Commit the isolated checkout's current content as its synthetic baseline and
 * report the commit id. Shared by every provider: whatever mechanism produced the
 * checkout, the baseline it will be diffed against is made the same way, so
 * clause 2 of the {@link StagedWorkspace} contract cannot drift between providers.
 */
export function commitStagedBaseline(dir: string): string {
  gitRaw(dir, ["add", "-A"]);
  // The pinned identity and disabled signing keep the baseline from depending on
  // (or being broken by) the user's global git configuration: an unset user.email
  // or `commit.gpgsign = true` would otherwise fail an otherwise valid delegation.
  gitRaw(dir, [
    ...COMMIT_CONFIG,
    "commit",
    "-q",
    "--no-verify",
    "--allow-empty",
    "-m",
    BASELINE_MESSAGE,
  ]);
  return gitText(dir, ["rev-parse", "HEAD"]).trim();
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

/** The cumulative change of an isolated checkout against its synthetic baseline. */
export interface StagedDiff {
  /** A binary-safe patch, empty when the delegation changed nothing. */
  patch: Buffer;
  /** Every changed repository-relative path, sorted. */
  paths: string[];
}

/**
 * The cumulative diff of the isolated checkout against its synthetic baseline.
 * Staging everything first (`git add -A`) makes newly created files part of the
 * diff while still honoring `.gitignore` — an ignored file is not repository
 * content and is never promoted. Renames are not detected, so every change is an
 * add, delete, or modify of a single path and can be authorized on its own.
 */
export function stagedDiff(workspace: StagedWorkspace): StagedDiff {
  gitRaw(workspace.dir, ["add", "-A"]);
  const names = gitText(workspace.dir, [
    "diff",
    "--cached",
    "--no-renames",
    "--name-only",
    "-z",
    workspace.baselineCommit,
  ]);
  const patch = gitRaw(workspace.dir, [
    "diff",
    "--cached",
    "--binary",
    "--no-renames",
    workspace.baselineCommit,
  ]);
  return { patch, paths: names.split("\0").filter(Boolean).sort() };
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

/**
 * The promotion gate: authorize the cumulative staged change and apply it to the
 * user's checkout, or refuse and preserve it.
 *
 * The order is deliberate. Authorization comes first, because an unauthorized
 * path must never reach the checkout even if everything else would succeed; a
 * single unauthorized path fails the WHOLE promotion rather than being filtered
 * out, so a partial patch is never invented from a change the grant did not
 * cover. Then the minimal base guard: `HEAD` must still be the commit staging
 * started from, or the patch's base is stale and the outcome is a `conflict`.
 * Only then is the patch offered to `git apply --check` and, if that passes,
 * applied.
 *
 * This never throws: a promotion failure must not destroy the delegation's
 * outcome, so an unexpected git error becomes a `rejected` record with the
 * reason in its diagnostics.
 */
export function promoteStagedWork(
  workspace: StagedWorkspace,
  grant: CompiledGrant,
): PromotionRecord {
  let diff: StagedDiff;
  try {
    diff = stagedDiff(workspace);
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

  const unauthorized = diff.paths.filter((path) => !checkGrant(grant, "write", path).allowed);
  if (unauthorized.length > 0) {
    return refused(workspace, "rejected", diff, unauthorized, [
      "Orca refused to promote this delegation: the staged change touches path(s) outside the " +
        `delegation's write grant: ${unauthorized.join(", ")}.`,
    ]);
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
 * Like {@link promoteStagedWork} this never throws.
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
