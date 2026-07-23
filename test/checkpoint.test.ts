import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  CHECKPOINT_STATUSES,
  checkpointSchema,
  createDelegationRecord,
  fromInput,
  synthesizeFailed,
  type CheckpointResult,
} from "../src/checkpoint";
import { createCheckpointTool } from "../src/delegation-tools";

/**
 * Checkpoint mechanics (ADR 0083): the exact four-status vocabulary, terminating
 * behavior, the observed-only manifest, and the synthesized failure for a
 * session that ends statusless. No model involved.
 */

describe("checkpoint schema and vocabulary", () => {
  it("defines exactly the four OrcaSpec statuses", () => {
    expect([...CHECKPOINT_STATUSES]).toEqual(["completed", "needs_scope", "blocked", "failed"]);
  });

  it("accepts each of the four statuses and rejects anything else", () => {
    for (const status of CHECKPOINT_STATUSES) {
      expect(Value.Check(checkpointSchema, { status, summary: "done" })).toBe(true);
    }
    expect(Value.Check(checkpointSchema, { status: "success", summary: "x" })).toBe(false);
    expect(Value.Check(checkpointSchema, { status: "completed" })).toBe(false); // summary required
  });

  it("has no changed-paths field — the model cannot report the manifest", () => {
    const keys = Object.keys(checkpointSchema.properties);
    expect(keys).toEqual(["status", "summary", "scope_request", "remaining_risks"]);
  });

  it("maps validated input to the agent-supplied result fields", () => {
    const result = fromInput({
      status: "needs_scope",
      summary: "need more",
      scope_request: ["pkg/other/x.ts"],
      remaining_risks: ["untested"],
    });
    expect(result).toEqual({
      status: "needs_scope",
      summary: "need more",
      scopeRequest: ["pkg/other/x.ts"],
      remainingRisks: ["untested"],
    });
  });
});

describe("orca_checkpoint tool", () => {
  it("terminates the session and attaches the observed manifest, not agent claims", async () => {
    const record = createDelegationRecord();
    record.changedPaths.add("src/b.ts");
    record.changedPaths.add("src/a.ts");
    const tool = createCheckpointTool(record);

    const result = await tool.execute(
      "c1",
      // The agent's summary claims other files; the schema has no path channel,
      // and the manifest must come only from the observed record.
      { status: "completed", summary: "changed src/a.ts, src/z.ts, and docs/everything.md" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.terminate).toBe(true);
    const details = result.details as CheckpointResult;
    expect(details.status).toBe("completed");
    expect(details.synthesized).toBe(false);
    // Observed, sorted, and independent of the summary text.
    expect(details.changedPaths).toEqual(["src/a.ts", "src/b.ts"]);
    // The tool wrote the checkpoint back onto the shared record.
    expect(record.checkpoint).toBe(details);
  });

  it("carries scope_request through for needs_scope", async () => {
    const record = createDelegationRecord();
    const tool = createCheckpointTool(record);
    const result = await tool.execute(
      "c1",
      { status: "needs_scope", summary: "blocked", scope_request: ["other/dir/x.ts"] },
      undefined,
      undefined,
      {} as never,
    );
    const details = result.details as CheckpointResult;
    expect(details.status).toBe("needs_scope");
    expect(details.scopeRequest).toEqual(["other/dir/x.ts"]);
  });
});

describe("synthesized failed checkpoint", () => {
  it("is 'failed', flagged synthesized, and keeps the observed manifest", () => {
    const result = synthesizeFailed(["src/x.ts"], "The session errored.");
    expect(result.status).toBe("failed");
    expect(result.synthesized).toBe(true);
    expect(result.changedPaths).toEqual(["src/x.ts"]);
    expect(result.summary).toContain("without calling orca_checkpoint");
  });
});
