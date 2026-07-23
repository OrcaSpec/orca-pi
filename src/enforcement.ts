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
 *   names. Its single load-bearing invariant: a tool set containing `bash` can
 *   NEVER derive `enforced` (ADR 0079 — the subprocess dimension is not
 *   technically passable). This is a property, not a convention: the function has
 *   no branch that returns `enforced` while `bash` is present, so the code cannot
 *   emit a dishonest claim. Since every MVP delegation includes `bash`
 *   (`createDelegationTools`), the summary for a real delegation is always at most
 *   `partially_enforced`; the `enforced` branch is reachable only by a
 *   hypothetical future no-bash grant.
 *
 * The summary is explicitly a CAPABILITY SUMMARY, never an operating mode: modes
 * are `advisory`/`enforce` (see `mode.ts`); `partially_enforced` describes what a
 * grant's tool set can constructively enforce, orthogonal to the mode.
 */

/** How a single enforcement dimension is treated in the MVP. */
export type DimensionClaim = "enforced" | "advisory_disclosed" | "observed" | "not_applicable";

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
 * The rule is deliberately simple so the honesty invariant is obvious by
 * inspection: the presence of `bash` alone caps the summary below `enforced`,
 * because the subprocess filesystem dimension is not technically passable (ADR
 * 0079). With `bash` present, the summary is `partially_enforced` when at least
 * one constructively-enforced file tool is also present, else `advisory` (a shell
 * with no enforceable file boundary). Only a tool set WITHOUT `bash` can be
 * `enforced` — a case the MVP never produces (every delegation carries `bash`),
 * kept reachable so a future no-bash grant can honestly claim full enforcement.
 */
export function capabilitySummaryFor(toolNames: readonly string[]): CapabilitySummary {
  const hasBash = toolNames.includes(BASH_TOOL_NAME);
  const hasEnforcedFileTool = toolNames.some((name) => ENFORCED_FILE_TOOLS.includes(name));
  if (hasBash) return hasEnforcedFileTool ? "partially_enforced" : "advisory";
  return "enforced";
}

/** One-line explanation of what a capability summary means (never a mode). */
export function describeCapabilitySummary(summary: CapabilitySummary): string {
  switch (summary) {
    case "enforced":
      return "every relevant file boundary is constructively enforced and this grant carries no bash";
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
export function capabilitySummaryLine(toolNames: readonly string[]): string {
  const summary = capabilitySummaryFor(toolNames);
  return `Capability summary (not an operating mode): ${summary} — ${describeCapabilitySummary(summary)}.`;
}

/**
 * The dimensioned enforcement summary for `/orca`: the PRD table rendered
 * row-for-row, then the bash disclosure. No mode or per-delegation claim here —
 * this is the repository-wide profile; the capability summary is per delegation.
 */
export function formatEnforcementSummary(): string[] {
  const lines = ["Enforcement profile (dimensioned — ADR 0023, authoritative):"];
  for (const dimension of ENFORCEMENT_PROFILE) {
    lines.push(`  - ${dimension.dimension}: ${dimension.detail}`);
  }
  lines.push(
    "Bash disclosure: every delegation includes the `bash` tool (ADR 0079). Its filesystem effects are " +
      "advisory, not enforced — Orca applies no heuristic command inspection, cannot block shell-mediated " +
      "writes, and leaves them outside the observed manifest. Any delegation carrying bash reports at most " +
      "the `partially_enforced` capability summary and is never claimed fully enforced.",
  );
  return lines;
}
