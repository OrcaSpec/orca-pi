import { Type, type Static } from "typebox";

/**
 * The structured terminal checkpoint that ends every delegated session (ADR
 * 0083, 0057). This module owns the vocabulary, the schema, and the result
 * shape; the terminating tool that writes one lives in `delegation-tools.ts` and
 * the orchestration that attaches the observed manifest lives in `delegation.ts`.
 *
 * Two invariants are structural here, not merely enforced by convention:
 *
 * - The four statuses are exactly the OrcaSpec vocabulary — no more, no fewer.
 *   {@link CHECKPOINT_STATUSES} is the single source and the schema is built from
 *   it, so the tool the model sees cannot drift from the contract.
 * - The changed-path manifest is **observed**, never agent-reported. The schema
 *   deliberately has no changed-paths field, so the model has no channel to claim
 *   changes; the extension attaches {@link CheckpointResult.changedPaths} from the
 *   grant-wrapped tool calls it recorded. This makes "observed only" impossible to
 *   violate rather than a rule that must be remembered.
 *
 * Phase 6 exercises only `completed` end-to-end; the full schema is defined now
 * because the vocabulary is contract surface and the tool must present all four
 * from the start. The scope-expansion and multi-status lifecycle land in Phase 7.
 */

/** The four terminal statuses, exactly the OrcaSpec vocabulary (ADR 0083). */
export const CHECKPOINT_STATUSES = ["completed", "needs_scope", "blocked", "failed"] as const;

/** One of the four terminal checkpoint statuses. */
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

/**
 * The `orca_checkpoint` parameter schema. Note the absence of any changed-path
 * field: the manifest is observed by the extension, so the model cannot report
 * it (ADR 0083). `scope_request` carries requested paths for `needs_scope`;
 * `remaining_risks` is free-text, consistent with ADR 0058.
 */
export const checkpointSchema = Type.Object(
  {
    // Explicit literals (not a mapped array) so the Static type is the precise
    // four-member union; the "accepts each status" test guards it against drift
    // from CHECKPOINT_STATUSES.
    status: Type.Union(
      [
        Type.Literal("completed"),
        Type.Literal("needs_scope"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ],
      {
        description:
          "The terminal status of this delegation: 'completed' (work finished within grant), " +
          "'needs_scope' (blocked needing paths outside the grant — include scope_request), " +
          "'blocked' (cannot proceed for another reason), or 'failed' (an error prevented completion).",
      },
    ),
    summary: Type.String({
      minLength: 1,
      description:
        "A plain-language summary of what was done or why the delegation ended. Include free-text " +
        "validation results here; do not list changed files — Orca records those from your tool calls.",
    }),
    scope_request: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description:
          "For 'needs_scope' only: concrete repository-relative paths this task needs but the grant " +
          "does not authorize. The steward reruns resolution and issues a fresh delegation; the live " +
          "grant is never broadened.",
      }),
    ),
    remaining_risks: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Optional free-text notes on risks, caveats, or follow-ups the steward should know.",
      }),
    ),
  },
  {
    description:
      "End this delegated session with a structured checkpoint. Calling this tool terminates the " +
      "session, so call it exactly once as your final action.",
  },
);

/** The validated checkpoint input the model supplies. */
export type CheckpointInput = Static<typeof checkpointSchema>;

/**
 * A finalized checkpoint: the agent-supplied fields plus the extension-attached
 * observed manifest. {@link changedPaths} comes only from grant-wrapped tool
 * calls; {@link synthesized} is true when the session ended without calling the
 * tool and the extension manufactured a `failed` checkpoint (ADR 0083).
 */
export interface CheckpointResult {
  status: CheckpointStatus;
  summary: string;
  scopeRequest?: string[];
  remainingRisks?: string[];
  /** Observed changed paths (repository-relative, sorted), never agent-reported. */
  changedPaths: string[];
  /** True when the extension synthesized this checkpoint for a statusless session. */
  synthesized: boolean;
}

/**
 * One `bash` invocation observed by the spawn hook: the command and cwd only.
 * This is VISIBILITY, never enforcement (ADR 0079) — see `delegation-tools.ts`.
 */
export interface BashActivity {
  command: string;
  cwd: string;
}

/**
 * The per-delegation observed record (ADR 0083). The grant-wrapped write/edit
 * tools add each successful mutation's repository-relative path to
 * {@link changedPaths}; the checkpoint tool sets {@link checkpoint} when the
 * agent ends the session. This mutable object is the seam between the tool layer
 * (which observes) and the orchestration layer (which reports): the manifest is
 * whatever the tools recorded, nothing the agent asserts.
 *
 * {@link bashActivity} is a parallel, purely-informational log of the shell
 * commands the delegation ran, captured by the bash `spawnHook` for visibility
 * (ADR 0079). It is NEVER consulted in any allow/deny decision and its contents
 * are outside {@link changedPaths}: bash filesystem effects remain advisory.
 */
export interface DelegationRecord {
  /** Repository-relative paths of successful file-tool mutations, observed. */
  changedPaths: Set<string>;
  /** Observed bash commands (visibility only, never enforcement — ADR 0079). */
  bashActivity: BashActivity[];
  /** The checkpoint once the session ends (agent-called or synthesized). */
  checkpoint?: CheckpointResult;
}

/** A fresh, empty observed record for one delegation. */
export function createDelegationRecord(): DelegationRecord {
  return { changedPaths: new Set(), bashActivity: [] };
}

/** Normalize a validated checkpoint input into the agent-supplied part of a result. */
export function fromInput(input: CheckpointInput): Omit<CheckpointResult, "changedPaths" | "synthesized"> {
  return {
    status: input.status,
    summary: input.summary,
    scopeRequest: input.scope_request,
    remainingRisks: input.remaining_risks,
  };
}

/**
 * The `failed` checkpoint synthesized for a session that ended without calling
 * `orca_checkpoint` (ADR 0083 — no delegation ends statusless). The observed
 * manifest is still attached so recorded mutations are never lost.
 */
export function synthesizeFailed(changedPaths: string[], reason: string): CheckpointResult {
  return {
    status: "failed",
    summary:
      "The delegated session ended without calling orca_checkpoint. Orca synthesized a 'failed' " +
      `checkpoint so the delegation does not end statusless (ADR 0083). ${reason}`.trim(),
    changedPaths,
    synthesized: true,
  };
}
