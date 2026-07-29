import { describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import {
  BASH_TOOL_NAME,
  capabilitySummaryFor,
  capabilitySummaryLine,
  ENFORCEMENT_PROFILE,
  ENFORCEMENT_PROFILE_1_1,
  formatEnforcementSummary,
} from "../src/enforcement";
import { compileGrant } from "../src/resolver";
import { createDelegationRecord } from "../src/checkpoint";
import { createDelegationTools } from "../src/delegation-tools";

/**
 * The honest, dimensioned enforcement profile (ADR 0023, 0079). Two guarantees
 * are pinned here: the profile matches the PRD "Enforcement Profile" table
 * row-for-row, and the capability-summary derivation can NEVER return `enforced`
 * for a tool set that includes `bash` — the property the whole honesty story
 * rests on.
 */

// The PRD "Enforcement Profile" table, transcribed (markdown backticks removed).
// The dimensioned profile must match this exactly, in order.
const PRD_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["Repository reads via file tools", "Enforced"],
  ["Repository writes via file tools", "Enforced"],
  ["Subprocess filesystem effects (bash)", "Advisory, disclosed"],
  ["Delegation creation", "Enforced (only the steward's orca_delegate creates delegations)"],
  ["Change verification", "Observed manifests for file-tool mutations"],
  ["Promotion gating", "Not applicable (in-place editing)"],
];

describe("enforcement profile", () => {
  it("mirrors the PRD Enforcement Profile table row-for-row", () => {
    expect(ENFORCEMENT_PROFILE.map((row) => [row.dimension, row.detail])).toEqual(
      PRD_TABLE.map((row) => [row[0], row[1]]),
    );
  });

  it("renders every dimension plus an explicit bash disclosure", () => {
    const summary = formatEnforcementSummary().join("\n");
    for (const [dimension, detail] of PRD_TABLE) {
      expect(summary).toContain(dimension);
      expect(summary).toContain(detail);
    }
    // The bash gap is disclosed and tied to the capped capability summary.
    expect(summary.toLowerCase()).toContain("advisory");
    expect(summary).toContain("partially_enforced");
    expect(summary).toContain("ADR 0079");
  });
});

describe("capability summary derivation (ADR 0023/0079)", () => {
  it("caps any bash-bearing tool set below enforced", () => {
    // Property-style: over every subset of a small tool universe that contains
    // bash, the derived summary is never `enforced`.
    const universe = ["read", "write", "edit", BASH_TOOL_NAME, "orca_checkpoint", "grep"];
    let checkedBashSets = 0;
    for (let mask = 0; mask < 1 << universe.length; mask++) {
      const set = universe.filter((_, i) => mask & (1 << i));
      if (!set.includes(BASH_TOOL_NAME)) continue;
      checkedBashSets++;
      expect(capabilitySummaryFor(set)).not.toBe("enforced");
    }
    expect(checkedBashSets).toBeGreaterThan(0);
  });

  it("is partially_enforced with bash + enforced file tools", () => {
    expect(capabilitySummaryFor(["read", "write", "edit", BASH_TOOL_NAME])).toBe("partially_enforced");
  });

  it("is advisory with bash and no enforced file tool", () => {
    expect(capabilitySummaryFor([BASH_TOOL_NAME])).toBe("advisory");
    expect(capabilitySummaryFor([BASH_TOOL_NAME, "orca_checkpoint"])).toBe("advisory");
  });

  it("allows enforced ONLY for a hypothetical no-bash grant", () => {
    expect(capabilitySummaryFor(["read", "write", "edit"])).toBe("enforced");
    expect(capabilitySummaryFor(["read", "edit", "orca_checkpoint"])).toBe("enforced");
  });

  it("labels the summary as a capability summary, never a mode", () => {
    const line = capabilitySummaryLine(["read", "write", "edit", BASH_TOOL_NAME]);
    expect(line).toContain("Capability summary");
    expect(line).toContain("not an operating mode");
    expect(line).toContain("partially_enforced");
  });

  it("the REAL MVP delegation tool set is partially_enforced and cannot be enforced", () => {
    const doc = orcaspec.loadFixture("multi-owner");
    const grant = compileGrant(doc.agents[0], doc.protected_denies ?? {});
    const toolNames = createDelegationTools("/tmp/whatever", grant, createDelegationRecord()).map(
      (tool) => tool.name,
    );
    // Every MVP delegation carries bash (ADR 0079).
    expect(toolNames).toContain(BASH_TOOL_NAME);
    expect(capabilitySummaryFor(toolNames)).toBe("partially_enforced");
    expect(capabilitySummaryFor(toolNames)).not.toBe("enforced");
  });
});

describe("mutation-accountability capability contract 1.1", () => {
  it("claims shell mutation acceptance only when post-command reconciliation is active", () => {
    const shell = ENFORCEMENT_PROFILE_1_1.find(
      (row) => row.dimension === "Subprocess filesystem effects (bash)",
    );
    expect(shell).toMatchObject({
      claim: "reconciled",
      detail: "Post-command and post-session reconciled against the effective grant",
    });
    expect(
      capabilitySummaryFor(["read", "write", "edit", BASH_TOOL_NAME], {
        shellMutationReconciliation: true,
      }),
    ).toBe("enforced");
    expect(capabilitySummaryFor(["read", "write", "edit", BASH_TOOL_NAME])).toBe(
      "partially_enforced",
    );
  });
});
