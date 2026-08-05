import { readFileSync } from "node:fs";
import { canonicalPath, tryGit } from "./git";
import { GOVERNANCE_SCOPE, type HeldGovernance } from "./staging";
import type { NotifyLevel } from "./surface";

/**
 * The explicit approval action (hardening plan, Phase 3) and everything a surface says
 * about a held governance change.
 *
 * Phase 2 made a governance change something no delegation can land. This module is the
 * one place that lands one, and it lands it only when the user asks: {@link applyHeldPatch}
 * is private here and {@link runApprovalAction} is its only caller, so "approval is the
 * only runtime path that applies a held patch" is a fact about the module graph rather
 * than a convention to remember.
 *
 * It owns the WORDING as well as the decision, and `render.ts` reads it from here rather
 * than the other way around. Presentation depending on the domain keeps the dependency
 * one-way, and it keeps one implementation of "how a hold is described" that the promotion
 * detail, the `/orca` pending list, and this action's own report all share — which is the
 * same reason promotion rendering lives in one renderer.
 */

/**
 * How one approval attempt ended.
 *
 * `does_not_apply` is the drift answer: a held patch outlives the session that made
 * it, the user owns `.orca/**` meanwhile, and the only honest test of whether the
 * proposal still fits their files is git's own — so the base is checked by OFFERING
 * the patch (`git apply --check`) rather than by comparing the recorded base commit
 * against `HEAD`. Content is what the patch depends on; a `HEAD` that moved for
 * unrelated reasons would refuse an approval that would have applied perfectly.
 */
export type ApprovalOutcome =
  | "applied"
  | "already_applied"
  | "does_not_apply"
  | "missing_patch"
  | "empty_patch"
  | "patch_mismatch"
  | "unreadable_repository";

/**
 * The outcomes that SETTLE a hold: the change the patch proposes is in the user's
 * checkout, whether this action put it there or found it there. Everything else leaves
 * the hold pending, because the proposal still has not landed and the user may fix
 * their state and approve again.
 */
export function isSettled(approval: GovernanceApproval | undefined): boolean {
  return approval?.outcome === "applied" || approval?.outcome === "already_applied";
}

/** The durable record of one approval attempt. */
export interface GovernanceApproval {
  patchPath: string;
  paths: string[];
  outcome: ApprovalOutcome;
  at: number;
  /** Git's own words when the attempt did not land, for the report. */
  detail?: string;
}

/** One held governance change as the delegation history offers it for approval. */
export interface GovernanceHold {
  held: HeldGovernance;
  task: string;
  sequenceId?: string;
  approval?: GovernanceApproval;
}

/** What one invocation of `/orca approve` is asked to do. */
export interface ApprovalActionInput {
  /** Any directory inside the user's repository; the patch is applied at its root. */
  cwd: string;
  /** The raw argument the user typed, if any (see {@link runApprovalAction}). */
  selector?: string;
  /** Every hold the delegation history knows about, NEWEST FIRST. */
  holds: readonly GovernanceHold[];
  /** The wall clock, passed in so an approval's recorded time is the caller's fact. */
  now: number;
}

/** What one invocation of `/orca approve` did. */
export interface ApprovalActionResult {
  /**
   * The attempt to persist, present exactly when a patch was OFFERED to git — so a
   * refused attempt is recorded too, and a selector that matched nothing is not.
   */
  approval?: GovernanceApproval;
  /** What the human is told. */
  lines: string[];
  /** `info` when the change is in the checkout, `warning` when nothing was approved. */
  level: NotifyLevel;
}

/** When an approval happened, in a form that reads the same in every timezone. */
export function approvalTimestamp(approval: GovernanceApproval): string {
  return new Date(approval.at).toISOString();
}

/**
 * One held governance change as every surface lists it: the `/orca` pending-approval
 * section and this action's own listing when it needs the user to say which hold they
 * meant.
 *
 * `position` is the selector `/orca approve <n>` takes, so the list a user reads and the
 * list the selector counts through are the same list. A settled hold has no position
 * because there is nothing left to approve about it.
 */
export function governanceHoldLine(hold: GovernanceHold, position?: number): string {
  const marker = position === undefined ? "  -" : `  ${position}.`;
  const state = hold.approval ? ` — ${approvalStateOf(hold.approval)}` : "";
  return `${marker} ${hold.held.paths.join(", ")} — "${hold.task}"${state} — patch: ${hold.held.patchPath}`;
}

/**
 * One approval attempt as a transcript entry: the durable, visible trace of the user's
 * decision, in the same words the action reported it in.
 */
export function approvalRecordLines(approval: GovernanceApproval): string[] {
  return [
    `Orca governance approval — ${approvalStateOf(approval)}: ${approval.paths.join(", ")}.`,
    `Patch: ${approval.patchPath}`,
    ...(approval.detail ? [`Git said: ${approval.detail}`] : []),
  ];
}

/** One approval attempt in a few words: what it did, and when. */
export function approvalStateOf(approval: GovernanceApproval): string {
  const verb = isSettled(approval)
    ? approval.outcome === "applied"
      ? "APPROVED and applied"
      : "APPROVED — already in your checkout"
    : `an approval attempt did not land (${approval.outcome})`;
  return `${verb} at ${approvalTimestamp(approval)}`;
}

/**
 * The user's repository root, from any directory inside it, or nothing when this is not a
 * repository. There is deliberately no fallback to `cwd`: `git apply` outside a repository
 * patches files relative to the current directory, so a guess here would mean landing a
 * governance change somewhere that is not the user's checkout.
 */
function repoRootOf(cwd: string): string | undefined {
  const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) return undefined;
  const root = toplevel.out.toString("utf8").trim();
  return root === "" ? undefined : canonicalPath(root);
}

/**
 * The paths a patch actually touches, as git reads them, or nothing when git cannot read
 * it as a patch at all. `--numstat` parses the patch without applying anything; with `-z`
 * each record is `added<TAB>deleted<TAB>path`, NUL-terminated, and a binary file reports
 * `-` for both counts.
 */
function patchPathsOf(root: string, patch: Buffer): string[] | undefined {
  const numstat = tryGit(root, ["apply", "--numstat", "-z", "--whitespace=nowarn"], patch);
  if (!numstat.ok) return undefined;
  return numstat.out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => record.split("\t").slice(2).join("\t"))
    .filter(Boolean)
    .sort();
}

/**
 * Apply one held governance patch to the user's checkout. THE only applier of a held
 * patch in the runtime, reachable only from {@link runApprovalAction}.
 *
 * `--check` first and the apply only if it passes, so a refusal cannot leave the
 * checkout half-changed: git's check is a dry run of the same code that would write,
 * and a patch it will not take is reported rather than attempted. The apply's own
 * failure is still handled — between the two calls the user is still editing their
 * files — and it means the same thing.
 */
function applyHeldPatch(cwd: string, held: HeldGovernance, now: number): GovernanceApproval {
  const record = (outcome: ApprovalOutcome, detail?: string): GovernanceApproval => ({
    patchPath: held.patchPath,
    paths: [...held.paths],
    outcome,
    at: now,
    detail,
  });

  let patch: Buffer;
  try {
    patch = readFileSync(held.patchPath);
  } catch (error) {
    return record("missing_patch", error instanceof Error ? error.message : String(error));
  }
  // An empty file is decided rather than offered to git: `git apply` has no reason to
  // object to an empty patch, and an approval that reported success over a truncated
  // artifact would retire a proposal that never landed.
  if (patch.length === 0) return record("empty_patch");

  const root = repoRootOf(cwd);
  if (root === undefined) return record("unreadable_repository");

  // What the user is agreeing to is the hold the record describes, and the patch file is
  // the one artifact in this story that lives OUTSIDE the repository and outside
  // everything that governs a delegation's writes. So the file is checked against the
  // record before it is offered to git: a patch that no longer touches exactly the
  // governance paths the gate recorded is refused, which keeps an approval from becoming
  // a way to land content the gate never authorized or held.
  const actual = patchPathsOf(root, patch);
  if (actual === undefined) return record("patch_mismatch", "git can no longer read it as a patch");
  if (actual.join("\n") !== [...held.paths].sort().join("\n")) {
    return record("patch_mismatch", `it now touches ${actual.join(", ")}`);
  }

  const check = tryGit(root, ["apply", "--check", "--whitespace=nowarn"], patch);
  if (!check.ok) {
    // A patch git will not take FORWARD but takes in REVERSE is one whose result is
    // already in the checkout — the user applied it by hand, or approved it before.
    // That is the honest test for "already applied": comparing paths or timestamps
    // would guess, while offering git the reverse patch asks the only question that
    // matters. It is asked only after the forward check fails, so a patch that still
    // applies is never mistaken for one that already did.
    const reverse = tryGit(root, ["apply", "--check", "--reverse", "--whitespace=nowarn"], patch);
    if (reverse.ok) return record("already_applied");
    return record("does_not_apply", check.reason);
  }

  const applied = tryGit(root, ["apply", "--whitespace=nowarn"], patch);
  if (!applied.ok) return record("does_not_apply", applied.reason);

  return record("applied");
}

/** What the steward is told about one approval attempt. */
function approvalLines(hold: GovernanceHold, approval: GovernanceApproval): string[] {
  switch (approval.outcome) {
    case "applied":
      return [
        `Orca applied the governance change you approved — ${approval.paths.length} path(s) now in ` +
          `your checkout as unstaged changes: ${approval.paths.join(", ")}.`,
        `Proposed by the delegation "${hold.task}"; the approved patch is preserved at ` +
          `${approval.patchPath}.`,
      ];
    case "already_applied":
      return [
        "That governance change is already in your checkout — its patch applies only in reverse, so " +
          `Orca changed nothing: ${approval.paths.join(", ")}.`,
        `Proposed by the delegation "${hold.task}"; the hold is settled and needs no further ` +
          "approval.",
      ];
    case "missing_patch":
      return [
        "Orca could not approve that governance change: the held patch is no longer at " +
          `${approval.patchPath} (${approval.detail}).`,
        `Your checkout is unchanged. The change it proposed to ${approval.paths.join(", ")} is ` +
          "gone with the patch; delegate it again if it is still wanted.",
      ];
    case "empty_patch":
      return [
        `Orca could not approve that governance change: the held patch at ${approval.patchPath} is ` +
          "empty, so there is nothing in it to apply.",
        "Your checkout is unchanged. An empty patch is a damaged artifact, not an approved " +
          "no-op — delegate the change again rather than treating it as landed.",
      ];
    case "patch_mismatch":
      return [
        "Orca refused to approve that governance change: the held patch at " +
          `${approval.patchPath} no longer contains what was held.`,
        `The hold covers ${approval.paths.join(", ")}; ${approval.detail}. Orca applies what the ` +
          "delegation's record says was held and nothing else, so nothing was applied and your " +
          "checkout is unchanged.",
      ];
    case "unreadable_repository":
      return [
        "Orca could not approve that governance change: it could not find the git repository to " +
          "apply it to.",
        "Nothing was applied. A held patch lands in your checkout or nowhere — run this from " +
          "inside the repository the delegation ran in.",
      ];
    case "does_not_apply":
      return [
        "Orca did NOT approve that governance change: its patch does not apply to your checkout " +
          `any more (git apply --check failed: ${approval.detail}).`,
        `Your checkout is unchanged and the patch is still held at ${approval.patchPath}. It was ` +
          `generated against ${hold.held.baseCommit}; \`git apply --3way ${approval.patchPath}\` can ` +
          "merge it into your current state, or delegate the change again so it is re-staged.",
      ];
  }
}

/** Every string a user may address one hold by. */
function identifiersOf(hold: GovernanceHold): string[] {
  return [hold.held.patchPath, hold.sequenceId].filter((id): id is string => !!id);
}

/** The holds, listed as the selector counts them: pending ones numbered from 1. */
function listing(holds: readonly GovernanceHold[], numbered = true): string[] {
  return holds.map((hold, index) => governanceHoldLine(hold, numbered ? index + 1 : undefined));
}

/** Nothing to approve: two different situations, and they must not read the same. */
function nothingHeldLines(all: readonly GovernanceHold[]): string[] {
  if (all.length === 0) {
    return [
      "Nothing is held for your approval: no delegation in this session's history proposed a change " +
        `under \`${GOVERNANCE_SCOPE}\`.`,
    ];
  }
  return [
    `Nothing is awaiting your approval — every governance change proposed under \`${GOVERNANCE_SCOPE}\` ` +
      "is already settled:",
    ...listing(all, false),
  ];
}

/** Which hold an approval means, or why the action cannot tell. */
type Selection =
  | { ok: true; hold: GovernanceHold; others: readonly GovernanceHold[] }
  | { ok: false; lines: string[] };

/**
 * Resolve the selector to exactly one hold.
 *
 * Three deliberate shapes, in the order a user reaches for them:
 *
 * - NO selector approves the newest pending hold. A hold is nearly always approved right
 *   after the delegation that proposed it, so making the common case say nothing is the
 *   ergonomic default; the caller names what it took and what else is waiting, because
 *   applying the wrong proposal is not undone by asking.
 * - A POSITION (`1`, `2`, …) counts through the pending holds as `/orca` lists them,
 *   newest first. It addresses only pending holds — a position into a list that includes
 *   settled ones would shift under the user as they approve.
 * - Anything else is matched as a SUBSTRING of a hold's patch path or sequence id, over
 *   ALL holds including settled ones. The patch path is what every surface already
 *   prints, so pasting it back always works, and matching settled holds too is what lets
 *   a second approval of the same change say "already approved" instead of "no such hold".
 *
 * Ambiguity is never guessed: a selector matching two holds refuses and shows both.
 */
function selectHold(
  selector: string | undefined,
  all: readonly GovernanceHold[],
  pending: readonly GovernanceHold[],
): Selection {
  if (selector === undefined || selector === "") {
    if (pending.length === 0) return { ok: false, lines: nothingHeldLines(all) };
    return { ok: true, hold: pending[0], others: pending.slice(1) };
  }

  if (/^\d+$/.test(selector)) {
    const hold = pending[Number(selector) - 1];
    if (!hold) {
      return {
        ok: false,
        lines:
          pending.length === 0
            ? nothingHeldLines(all)
            : [
                `Orca has no held governance change at position ${selector}. ` +
                  `${pending.length} awaiting your approval:`,
                ...listing(pending),
              ],
      };
    }
    return { ok: true, hold, others: [] };
  }

  const matches = all.filter((hold) => identifiersOf(hold).some((id) => id.includes(selector)));
  if (matches.length === 0) {
    return {
      ok: false,
      lines: [
        `No held governance change matches '${selector}'.`,
        ...(pending.length === 0
          ? nothingHeldLines(all)
          : [`${pending.length} awaiting your approval:`, ...listing(pending)]),
      ],
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      lines: [
        `'${selector}' matches more than one held governance change, so Orca approved none of them. ` +
          "Use a position or a patch path that names exactly one:",
        ...listing(matches),
      ],
    };
  }

  const [match] = matches;
  if (match.approval && isSettled(match.approval)) {
    return {
      ok: false,
      lines: [
        `That governance change was already approved at ${approvalTimestamp(match.approval)} ` +
          `(${match.approval.outcome}), so Orca did nothing: ${match.held.paths.join(", ")}.`,
        `Its patch remains at ${match.held.patchPath} as the record of what was approved.`,
      ],
    };
  }
  return { ok: true, hold: match, others: [] };
}

/**
 * The `/orca approve` action: land one held governance patch because the user said so.
 *
 * This is the ONLY runtime path from a held patch to the user's checkout. Nothing else
 * reads {@link HeldGovernance.patchPath} to apply it, and the applier above is private to
 * this module, so a held patch cannot become a side effect of promotion, of rendering, or
 * of a delegation completing — only of this call, made from a command the user typed.
 *
 * It is deliberately NOT a tool: giving the model an approval tool would let the very
 * agent whose change was held approve it, which is the whole thing the hold exists to
 * prevent.
 */
export function runApprovalAction(input: ApprovalActionInput): ApprovalActionResult {
  const pending = input.holds.filter((hold) => !isSettled(hold.approval));
  const selection = selectHold(input.selector, input.holds, pending);
  if (!selection.ok) return { lines: selection.lines, level: "warning" };

  const approval = applyHeldPatch(input.cwd, selection.hold.held, input.now);
  const lines = approvalLines(selection.hold, approval);
  if (selection.others.length > 0) {
    lines.push(
      `${selection.others.length} older governance change(s) are still awaiting your approval:`,
      ...listing(selection.others, false),
    );
  }
  return { approval, lines, level: isSettled(approval) ? "info" : "warning" };
}
