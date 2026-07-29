/**
 * The honest, dimensioned enforcement profile and the per-delegation capability
 * summary derived from it (ADR 0023, 0079; PRD "Enforcement Profile").
 *
 * Two things live here and nothing else:
 *
 * - {@link ENFORCEMENT_PROFILE} — the fixed dimensioned profile that MUST mirror
 *   the PRD "Enforcement Profile" table row-for-row. It is the authoritative
 *   result; the capability summary below is ADR 0023's explanatory shorthand.
 * - {@link capabilitySummaryFor} — a PURE derivation of the ADR 0023 summary
 *   (`enforced` / `partially_enforced` / `advisory`) from a delegation's tool-set
 *   names and the versioned shell-accountability capability. Historical callers
 *   retain the 1.0 rule that bash caps the result below enforced. Contract 1.1
 *   callers may claim enforced only when post-command/post-session mutation
 *   reconciliation is explicitly active.
 *
 * The summary is explicitly a CAPABILITY SUMMARY, never an operating mode: modes
 * are `advisory`/`enforce` (see `mode.ts`); `partially_enforced` describes what a
 * grant's tool set can constructively enforce, orthogonal to the mode.
 */

/** How a single enforcement dimension is treated in the MVP. */
export type DimensionClaim =
  | "enforced"
  | "advisory_disclosed"
  | "observed"
  | "reconciled"
  | "not_applicable";

/** One row of the dimensioned enforcement profile (mirrors the PRD table). */
export interface EnforcementDimension {
  /** The PRD table's dimension label. */
  dimension: string;
  /** The machine-readable claim for the dimension. */
  claim: DimensionClaim;
  /** The PRD table's "MVP claim" cell, rendered verbatim in the summary. */
  detail: string;
}

/**
 * The dimensioned enforcement profile, row-for-row from the PRD "Enforcement
 * Profile" table. This is contract-facing honesty surface: the labels and claim
 * text are asserted against the PRD in tests so the summary cannot silently drift
 * from what the product promises.
 */
export const ENFORCEMENT_PROFILE: readonly EnforcementDimension[] = [
  { dimension: "Repository reads via file tools", claim: "enforced", detail: "Enforced" },
  { dimension: "Repository writes via file tools", claim: "enforced", detail: "Enforced" },
  {
    dimension: "Subprocess filesystem effects (bash)",
    claim: "advisory_disclosed",
    detail: "Advisory, disclosed",
  },
  {
    dimension: "Delegation creation",
    claim: "enforced",
    detail: "Enforced (only the steward's orca_delegate creates delegations)",
  },
  {
    dimension: "Change verification",
    claim: "observed",
    detail: "Observed manifests for file-tool mutations",
  },
  { dimension: "Promotion gating", claim: "not_applicable", detail: "Not applicable (in-place editing)" },
] as const;

/**
 * Contract 1.1 profile. The 1.0 profile above remains readable for historical
 * evidence; new delegations may claim this profile only when their bash tool is
 * wrapped by post-command and checkpoint reconciliation.
 */
export const ENFORCEMENT_PROFILE_1_1: readonly EnforcementDimension[] = [
  { dimension: "Repository reads via file tools", claim: "enforced", detail: "Enforced" },
  { dimension: "Repository writes via file tools", claim: "enforced", detail: "Enforced" },
  {
    dimension: "Subprocess filesystem effects (bash)",
    claim: "reconciled",
    detail: "Post-command and post-session reconciled against the effective grant",
  },
  {
    dimension: "Delegation creation",
    claim: "enforced",
    detail: "Enforced (only the steward's orca_delegate creates delegations)",
  },
  {
    dimension: "Change verification",
    claim: "reconciled",
    detail: "Observed manifests plus sanitized mutation-disposition evidence",
  },
  { dimension: "Promotion gating", claim: "enforced", detail: "Unauthorized mutations excluded" },
] as const;

/** The ADR 0023 explanatory summary for a delegation's tool set. */
export type CapabilitySummary = "enforced" | "partially_enforced" | "advisory";

/** The `bash` tool name — the only tool that opens the (advisory) subprocess dimension. */
export const BASH_TOOL_NAME = "bash";

/** The file tools whose read/write authority Orca constructively enforces (ADR 0078). */
export const ENFORCED_FILE_TOOLS: readonly string[] = ["read", "write", "edit"];

/**
 * Derive the ADR 0023 capability summary for a delegation's tool set. PURE and
 * total.
 *
 * Without the 1.1 capability flag, bash continues to cap the result below
 * `enforced`, preserving historical evidence semantics. With the flag, a
 * bash-bearing set is enforced only when it also carries constructively-enforced
 * file tools. Bash alone remains advisory.
 */
export interface CapabilityOptions {
  /** True only when bash effects are diffed and unauthorized changes restored. */
  shellMutationReconciliation?: boolean;
}

export function capabilitySummaryFor(
  toolNames: readonly string[],
  options: CapabilityOptions = {},
): CapabilitySummary {
  const hasBash = toolNames.includes(BASH_TOOL_NAME);
  const hasEnforcedFileTool = toolNames.some((name) => ENFORCED_FILE_TOOLS.includes(name));
  if (hasBash && options.shellMutationReconciliation && hasEnforcedFileTool) return "enforced";
  if (hasBash) return hasEnforcedFileTool ? "partially_enforced" : "advisory";
  return "enforced";
}

/** One-line explanation of what a capability summary means (never a mode). */
export function describeCapabilitySummary(summary: CapabilitySummary): string {
  switch (summary) {
    case "enforced":
      return "every relevant retained filesystem mutation boundary is constructively enforced or reconciled";
    case "partially_enforced":
      return "file reads/writes are constructively enforced; bash subprocess filesystem effects are advisory and disclosed (ADR 0079)";
    case "advisory":
      return "no file boundary is constructively enforced for this grant";
  }
}

/**
 * The capability-summary line for a delegation, always labelled as a summary and
 * never as an operating mode, so the reader cannot mistake `partially_enforced`
 * for a third mode.
 */
export function capabilitySummaryLine(
  toolNames: readonly string[],
  options: CapabilityOptions = {},
): string {
  const summary = capabilitySummaryFor(toolNames, options);
  return `Capability summary (not an operating mode): ${summary} — ${describeCapabilitySummary(summary)}.`;
}

/**
 * The dimensioned enforcement summary for `/orca`: the PRD table rendered
 * row-for-row, then the bash disclosure. No mode or per-delegation claim here —
 * this is the repository-wide profile; the capability summary is per delegation.
 */
export function formatEnforcementSummary(version: "1.0" | "1.1" = "1.0"): string[] {
  const profile = version === "1.1" ? ENFORCEMENT_PROFILE_1_1 : ENFORCEMENT_PROFILE;
  const lines = [
    version === "1.1"
      ? "Enforcement profile 1.1 (dimensioned — ADR 0023, authoritative):"
      : "Enforcement profile (dimensioned — ADR 0023, authoritative):",
  ];
  for (const dimension of profile) {
    lines.push(`  - ${dimension.dimension}: ${dimension.detail}`);
  }
  lines.push(
    version === "1.1"
      ? "Bash accountability: Orca does not inspect command text. It reconciles retained filesystem effects " +
          "against the effective grant after every command and at session finalization, reverting unauthorized " +
          "paths before they can enter the accepted patch."
      : "Bash disclosure: every delegation includes the `bash` tool (ADR 0079). Its filesystem effects are " +
          "advisory, not enforced — Orca applies no heuristic command inspection, cannot block shell-mediated " +
          "writes, and leaves them outside the observed manifest. Any delegation carrying bash reports at most " +
          "the `partially_enforced` capability summary and is never claimed fully enforced.",
  );
  return lines;
}
