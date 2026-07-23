import type { ResolvedDelegation, Resolution, TargetReasoning } from "./resolver";

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

/**
 * The delegation plan `orca_delegate` would execute, rendered as a preview. In
 * Phase 5 the tool is a stub: it runs the pure resolver and shows the per-owner
 * delegations and grants it *would* issue, but spawns no session and touches no
 * file. The Phase 6 label is prominent so neither the model nor the human
 * mistakes the plan for executed work.
 */
export function renderDelegatePlan(task: string, resolution: Resolution): string {
  const lines: string[] = [
    "Orca delegation plan (PREVIEW ONLY — delegation execution lands in Phase 6).",
    "No session was spawned and no file was changed.",
    "",
    `Task: ${task}`,
    "",
    `Planned delegations (${resolution.delegations.length}) — one per owner, sequential, by owner id:`,
  ];
  if (resolution.delegations.length === 0) {
    lines.push("  (none — no target routes to an owner)");
  }
  for (const delegation of resolution.delegations) {
    lines.push(`  ${delegationHeader(delegation)}`);
    lines.push(...formatGrant(delegation));
  }

  if (resolution.unownedPaths.length > 0) {
    lines.push("", `Unowned targets (${resolution.unownedPaths.length}) — not delegated:`);
    for (const path of resolution.unownedPaths) lines.push(`  - ${path}`);
    lines.push(
      "Unowned writable targets would block delegation in enforce mode and warn in advisory mode (ADR 0012).",
    );
  }

  lines.push(
    "",
    "When Phase 6 lands, orca_delegate will run each delegation as a scoped in-process session " +
      "whose read/write/edit tools enforce the grant above.",
  );
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
