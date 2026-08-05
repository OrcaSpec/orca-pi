import { approvalStateOf, isSettled, type GovernanceApproval } from "./approval";
import type { ResolvedDelegation, Resolution, TargetReasoning } from "./resolver";
import { GOVERNANCE_SCOPE, type HeldGovernance, type PromotionStatus } from "./staging";

/**
 * Shared rendering for the two routing-preview tools. `orca_resolve` (model
 * facing) and `orca_explain` (human facing) render the *same* {@link Resolution}
 * object produced by one resolver call, and both derive every owner assignment,
 * writability flag, and grant from these helpers. In particular both call
 * {@link formatGrant} for the per-owner grant block, so the compiled authority a
 * human reads in `orca_explain` is byte-identical to what the model reads in
 * `orca_resolve` — they cannot drift because neither recomputes it.
 */

/** Render one owner's compiled grant as indented allow/deny lines. */
export function formatGrant(delegation: ResolvedDelegation, indent = "    "): string[] {
  const list = (scopes: string[]): string => (scopes.length ? scopes.join(", ") : "(none)");
  const { read, write } = delegation.grant;
  return [
    `${indent}read.allow:  ${list(read.allow)}`,
    `${indent}read.deny:   ${list(read.deny)}`,
    `${indent}write.allow: ${list(write.allow)}`,
    `${indent}write.deny:  ${list(write.deny)}`,
  ];
}

/**
 * The promotion facts every surface renders: the live {@link PromotionRecord} from
 * a just-finished delegation and the flattened one a `/orca` history entry was
 * rebuilt from both satisfy this shape, so both render through the two functions
 * below and cannot disagree about what happened to the user's files.
 */
export interface PromotionView {
  status: PromotionStatus;
  appliedPaths: string[];
  rejectedPaths: string[];
  driftedPaths: string[];
  patchPath?: string;
  heldGovernance?: HeldGovernance;
  /**
   * What the user decided about {@link heldGovernance} afterwards (hardening plan,
   * Phase 3), when they have decided anything. It is not part of the promotion — the
   * promotion ended before the decision existed — which is exactly why it is a separate
   * field the caller supplies: the live report a delegation prints has none, and a
   * history entry has whatever the approval action last recorded.
   */
  governanceApproval?: GovernanceApproval;
  diagnostics: string[];
}

/**
 * The one-line answer to "what reached my files". Every refusal says the same two
 * things — nothing applied, checkout unchanged — because that is the fact a steward
 * needs before any explanation of why.
 *
 * A hold is named in the headline as well as in the detail (hardening plan, Phase 2),
 * including on a `promoted` that applied other paths: "promoted" alone would let a
 * steward close the report believing the whole delegation landed.
 */
export function promotionHeadline(promotion: PromotionView, label = "Promotion"): string {
  const held = promotion.heldGovernance?.paths.length ?? 0;
  // An approved hold must change the HEADLINE too, not only the detail: "await your
  // approval" is an instruction, and repeating it after the user has approved sends them
  // to do a thing they already did.
  const approved = isSettled(promotion.governanceApproval);
  const headline: Record<PromotionStatus, string> = {
    promoted:
      `${label}: promoted — ${promotion.appliedPaths.length} path(s) applied to your checkout` +
      (held > 0
        ? approved
          ? `, ${held} governance path(s) APPROVED and applied.`
          : `, ${held} governance path(s) HELD for your approval.`
        : "."),
    held: approved
      ? `${label}: HELD, then APPROVED — the delegation applied nothing; its ${held} governance ` +
        "path(s) were approved and applied."
      : `${label}: HELD — nothing was applied; ${held} governance path(s) await your approval.`,
    rejected: `${label}: REJECTED — nothing was applied; your checkout is unchanged.`,
    conflict: `${label}: CONFLICT — your checkout moved; nothing was applied.`,
    not_attempted: `${label}: not attempted — nothing was applied; your checkout is unchanged.`,
  };
  return headline[promotion.status];
}

/**
 * The pending governance patch, in the words both surfaces use (hardening plan,
 * Phase 2). Derived from the structured {@link HeldGovernance} rather than written
 * into the gate's diagnostics, because this is the one piece of a promotion report
 * that is also an INSTRUCTION: the patch is the only copy of an authorized change
 * that was deliberately not applied, and the hint has to name the base it expects so
 * a user applying it days later knows what it was computed against.
 */
function heldGovernanceLines(
  held: HeldGovernance,
  approval: GovernanceApproval | undefined,
  indent: string,
): string[] {
  // An approved hold is no longer an instruction, so it stops reading like one: the paths
  // and the patch stay on the record (the patch is what was approved), and the pending
  // sentence and the apply hint go away. A refused ATTEMPT keeps the instruction and adds
  // what happened, because the change still has not landed and the reason is what the
  // steward needs before they try again.
  if (approval && isSettled(approval)) {
    return [
      `${indent}APPROVED — ${held.paths.length} governance path(s) under \`${GOVERNANCE_SCOPE}\` were ` +
        `${approvalStateOf(approval)}: ${held.paths.join(", ")}.`,
      `${indent}The approved patch is preserved at ${held.patchPath}.`,
    ];
  }
  return [
    `${indent}HELD FOR YOUR APPROVAL — ${held.paths.length} governance path(s) under ` +
      `\`${GOVERNANCE_SCOPE}\` were NOT applied: ${held.paths.join(", ")}.`,
    `${indent}A delegated agent may not change the documents that govern the agents, so the change ` +
      `is waiting as a patch at ${held.patchPath}.`,
    ...(approval ? [`${indent}Last attempt: ${approvalStateOf(approval)}.`] : []),
    `${indent}To approve it: \`/orca approve\`. To apply it yourself: \`git apply ${held.patchPath}\` ` +
      `— it was generated against ${held.baseCommit}, the base captured when the delegation was staged.`,
  ];
}

/**
 * Why the promotion ended that way, in the gate's own words, LED by anything held
 * for approval — a pending decision outranks an explanation of what already
 * happened. The drifted paths and the preserved patch are not repeated as separate
 * lines: the gate's diagnostics already name both, and a conflict's recovery hint is
 * one of them.
 */
export function promotionDetailLines(promotion: PromotionView, indent = "  "): string[] {
  const lines = promotion.heldGovernance
    ? heldGovernanceLines(promotion.heldGovernance, promotion.governanceApproval, indent)
    : [];
  for (const diagnostic of promotion.diagnostics) lines.push(`${indent}${diagnostic}`);
  if (promotion.rejectedPaths.length > 0) {
    lines.push(`${indent}Unauthorized paths in the staged change: ${promotion.rejectedPaths.join(", ")}`);
  }
  return lines;
}

function delegationHeader(delegation: ResolvedDelegation): string {
  return `${delegation.owner} — targets: ${delegation.targets.join(", ")}`;
}

/** A compact one-line route summary for the `/orca` last-decisions log. */
export function summarizeResolution(resolution: Resolution): string {
  const owners = resolution.delegations.map((delegation) => delegation.owner);
  const targets = resolution.perTarget.map((target) => target.path).join(", ");
  const ownerPart =
    owners.length === 0
      ? "no owners"
      : `${owners.length} owner${owners.length === 1 ? "" : "s"} (${owners.join(", ")})`;
  const unownedPart =
    resolution.unownedPaths.length > 0 ? `, ${resolution.unownedPaths.length} unowned` : "";
  return `${targets} -> ${ownerPart}${unownedPart}`;
}

/**
 * Model-facing preview: the canonical facts (owner/unowned/writable per target,
 * one grant block per owner, unowned callout) with no reasoning prose. No side
 * effects and no delegation are implied.
 */
export function renderResolvePreview(resolution: Resolution): string {
  const lines: string[] = ["Orca routing preview (no delegation, no writes performed)."];

  lines.push("", `Targets (${resolution.perTarget.length}):`);
  for (const target of resolution.perTarget) {
    if (target.unowned) {
      lines.push(`  - ${target.path}: unowned (no agent owns this path)`);
    } else {
      lines.push(
        `  - ${target.path}: owner=${target.owner}, writable=${target.writable ? "yes" : "no"}`,
      );
    }
  }

  lines.push("", `Delegations (${resolution.delegations.length}) — one per owner, by owner id:`);
  if (resolution.delegations.length === 0) {
    lines.push("  (none — no target routes to an owner)");
  }
  for (const delegation of resolution.delegations) {
    lines.push(`  ${delegationHeader(delegation)}`);
    lines.push(...formatGrant(delegation));
  }

  if (resolution.unownedPaths.length > 0) {
    lines.push("", `Unowned targets (${resolution.unownedPaths.length}):`);
    for (const path of resolution.unownedPaths) lines.push(`  - ${path}`);
    lines.push(
      "Unowned writable targets block delegation in enforce mode and warn in advisory mode (ADR 0012).",
    );
  }

  return lines.join("\n");
}

function explainTarget(reasoning: TargetReasoning): string[] {
  if (reasoning.unowned) {
    return [
      `${reasoning.path}: unowned — no ownership scope matches. A write here is blocked in ` +
        `enforce mode and warned (work reported unmanaged) in advisory mode (ADR 0012).`,
    ];
  }

  const lines: string[] = [];
  const others =
    reasoning.otherMatches.length > 0
      ? ` More general scopes also matched (${reasoning.otherMatches
          .map((match) => `${match.owner} \`${match.scope}\``)
          .join(", ")}); the most-specific owner wins (ADR 0011).`
      : "";
  lines.push(
    `${reasoning.path}: routes to ${reasoning.owner}. Its ownership scope ` +
      `\`${reasoning.matchedScope}\` is the most specific match.${others}`,
  );

  if (reasoning.writable) {
    lines.push("  Writable: yes — the compiled grant permits writing here and no deny matches.");
  } else if (reasoning.noWriteAuthority) {
    lines.push(
      "  Writable: no — the owner has read-only authority here; no write-allow scope covers the path.",
    );
  } else if (reasoning.writeDeny) {
    const kind =
      reasoning.writeDeny.source === "protected"
        ? "a protected deny (cannot be overridden, ADR 0015)"
        : "an agent write-deny (ADR 0031)";
    lines.push(
      `  Writable: no — \`${reasoning.writeDeny.scope}\` is ${kind}; deny takes precedence over ` +
        `edit-expanded ownership.`,
    );
  }
  return lines;
}

/**
 * Human-facing rendering of the same decision: per-target owner reasoning (which
 * scope matched, why it is most specific, what deny trimmed write access, unowned
 * callouts) followed by the identical per-owner grant blocks used by the preview.
 */
export function renderExplain(resolution: Resolution): string {
  const lines: string[] = [
    "Orca routing explanation",
    "",
    `Targets (${resolution.reasoning.length}):`,
  ];
  for (const reasoning of resolution.reasoning) {
    for (const line of explainTarget(reasoning)) lines.push(`  ${line}`);
  }

  lines.push(
    "",
    "Compiled grants (edit-expanded ownership ∩ permissions, minus agent and protected denies):",
  );
  if (resolution.delegations.length === 0) {
    lines.push("  (none — no target routes to an owner)");
  }
  for (const delegation of resolution.delegations) {
    lines.push(`  ${delegationHeader(delegation)}`);
    lines.push(...formatGrant(delegation));
  }

  if (resolution.unownedPaths.length > 0) {
    lines.push(
      "",
      `${resolution.unownedPaths.length} target(s) are unowned: ${resolution.unownedPaths.join(", ")}.`,
    );
  }

  return lines.join("\n");
}
