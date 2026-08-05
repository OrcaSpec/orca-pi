import { createHash } from "node:crypto";
import type { CompiledGrant } from "./resolver";
import type {
  BashActivity,
  CheckpointStatus,
  ValidationEvidence,
} from "./checkpoint";
import type { MutationViolation } from "./mutation-accountability";
import {
  emptyUsage,
  sumUsage,
  type DelegationUsage,
  type SequenceOutcome,
  type SequenceStep,
  type AssignmentGraph,
  type IntegrationRecord,
  type OwnerAssignment,
  type UpstreamHandoff,
} from "./delegation";
import type { CapabilitySummary } from "./enforcement";
import type {
  AcceptedWork,
  HeldGovernance,
  PromotionRecord,
  PromotionStatus,
  ValidatorStatus,
} from "./staging";
import { promotionDetailLines, promotionHeadline } from "./render";
import { governanceHoldLine, isSettled, type GovernanceApproval, type GovernanceHold } from "./approval";

/**
 * The persistent, versioned delegation record and the in-memory history rebuilt
 * from it (PRD "User Surface" — "Delegation records persist as session entries so
 * a resumed session can display its history. There is no separate audit store").
 *
 * The MVP has NO audit store beyond pi session entries, so this record is the
 * whole durable trail of a delegation sequence. It is appended once per completed
 * sequence via `pi.appendEntry(DELEGATION_ENTRY_TYPE, record)` and re-read on
 * every `session_start` (startup / reload / resume / fork) by scanning
 * `ctx.sessionManager.getBranch()`. The rebuild path
 * ({@link DelegationHistory.rebuildFrom}) depends on entries ALONE, so a resumed
 * or forked session reconstructs its history with no other state — the invariant
 * the resumed-session display test pins.
 *
 * The record is deliberately plain-JSON: primitives, arrays, and flat objects
 * only, so it round-trips through the session store unchanged. {@link v} guards
 * the shape; a mismatched or malformed entry is ignored on rebuild rather than
 * trusted (an old or foreign entry never corrupts the history).
 */

/** The custom-entry `customType` for a persisted delegation sequence. */
export const DELEGATION_ENTRY_TYPE = "orca-delegation";

/**
 * The custom-entry `customType` for one governance approval attempt (hardening plan,
 * Phase 3).
 *
 * A SECOND entry type rather than a rewrite of the delegation entry, because entries are
 * append-only and the decision happens after the delegation is already written down —
 * possibly in a later session, possibly more than once. The rebuild replays both kinds in
 * branch order, so the history a resumed session shows is the delegation as it happened
 * plus whatever the user has since decided about its hold, and the last word wins.
 */
export const APPROVAL_ENTRY_TYPE = "orca-governance-approval";

/** The approval-entry schema version; bump on any breaking shape change. */
export const APPROVAL_ENTRY_VERSION = 1;

/** One approval attempt, flattened for the durable record ({@link GovernanceApproval}). */
export interface PersistedGovernanceApproval extends GovernanceApproval {
  v: number;
}

/** Stamp an approval with its schema version for `appendEntry`. */
export function toPersistedApproval(approval: GovernanceApproval): PersistedGovernanceApproval {
  return {
    v: APPROVAL_ENTRY_VERSION,
    patchPath: approval.patchPath,
    paths: [...approval.paths],
    outcome: approval.outcome,
    at: approval.at,
    detail: approval.detail,
  };
}

/**
 * Parse a session entry into an approval, or null when it is not one of ours. As
 * defensive as {@link parseDelegationEntry}, and for the same reason: rebuild runs over an
 * arbitrary branch, and an entry from another extension, another version, or a corrupted
 * write must be ignored rather than trusted.
 */
export function parseApprovalEntry(entry: unknown): PersistedGovernanceApproval | null {
  if (!entry || typeof entry !== "object") return null;
  const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (candidate.type !== "custom" || candidate.customType !== APPROVAL_ENTRY_TYPE) return null;

  const data = candidate.data;
  if (!data || typeof data !== "object") return null;
  const approval = data as Partial<PersistedGovernanceApproval>;
  if (approval.v !== APPROVAL_ENTRY_VERSION) return null;
  if (typeof approval.patchPath !== "string" || typeof approval.at !== "number") return null;
  if (typeof approval.outcome !== "string" || !Array.isArray(approval.paths)) return null;
  return approval as PersistedGovernanceApproval;
}

/** The record schema version; bump on any breaking shape change. */
export const LEGACY_DELEGATION_ENTRY_VERSION = 1;
export const DELEGATION_ENTRY_VERSION = 2;
export const DELEGATION_EVIDENCE_SCHEMA_VERSION = "1.1" as const;

export interface PersistedShellActivity {
  commandDigest: string;
}

/**
 * One declared validator's run, flattened for the durable record (staged-promotion
 * plan, Phase 4, persisted in Phase 5). Identity and verdict only: the captured
 * stdout/stderr are deliberately left out — they are unbounded and can contain
 * anything the program printed — and {@link PersistedPromotion.validatorOutputPath}
 * points at the preserved output instead.
 */
export interface PersistedValidatorRun {
  agent: string;
  program: string;
  args: string[];
  status: ValidatorStatus;
  exitCode?: number;
}

/**
 * The sequence's single promotion, flattened to plain JSON.
 *
 * This is what makes the durable record answer the question a steward actually has
 * when they come back to a session: not "what did the agent do" but "what happened
 * to MY files, and where is the work if it did not land". A `conflict` therefore
 * persists both halves of its recovery — {@link driftedPaths} names what moved, and
 * {@link diagnostics} carries the gate's own wording including the `git apply` hint
 * pointing at {@link patchPath} — because the preserved patch outlives the session
 * that produced it while nothing else remembers where it is.
 *
 * Only the SEQUENCE promotion is persisted, not each owner's view of it: a sequence
 * promotes once, and a per-step copy would be the same record narrowed, which is
 * derivable from the applied paths already on the steps.
 */
export interface PersistedPromotion {
  status: PromotionStatus;
  appliedPaths: string[];
  rejectedPaths: string[];
  driftedPaths: string[];
  /** Where the patch was preserved when nothing was applied; absolute. */
  patchPath?: string;
  /**
   * The governance change held for approval (hardening plan, Phase 2), carried
   * through verbatim because {@link HeldGovernance} is already plain JSON. This is the
   * one part of a promotion the steward may still have to ACT on, and the record is
   * the only thing that remembers where the patch is once the session ends.
   */
  heldGovernance?: HeldGovernance;
  /**
   * The reusable accepted work a `needs_scope` stop preserved (hardening plan, Phase
   * 5), carried through verbatim like the hold above it and for the same reason: the
   * patch outlives the session, this record is the only thing that remembers where it
   * is, and the steward's next delegation may well happen in a later session.
   */
  acceptedWork?: AcceptedWork;
  validations: PersistedValidatorRun[];
  /** Where preserved validator output was written; absolute. */
  validatorOutputPath?: string;
  diagnostics: string[];
}

/** One owner's slot in a persisted sequence, flattened to plain JSON. */
export interface PersistedStep {
  owner: string;
  /** Direct evaluator-facing target projection; v1 records may omit it. */
  targets?: string[];
  /** A checkpoint status, or a lifecycle state for owners that never checkpointed. */
  status: CheckpointStatus | "build_failed" | "not_run";
  summary: string;
  /** Reconciled changed paths accepted under this owner's effective grant. */
  changedPaths: string[];
  /** True when Orca synthesized the checkpoint for a statusless session (ADR 0083). */
  synthesized?: boolean;
  /** The ADR 0023 capability summary for this owner's grant (never a mode). */
  capabilitySummary?: CapabilitySummary;
  /** Legacy v1 raw bash evidence retained solely for backward readability. */
  bashActivity?: BashActivity[];
  /** Contract 2 shell evidence retains identity, never raw command text. */
  shellActivities?: PersistedShellActivity[];
  assignment?: OwnerAssignment;
  sequenceId?: string;
  stepId?: string;
  delegationId?: string;
  childSessionId?: string;
  grantId?: string;
  validation?: ValidationEvidence;
  mutationViolations?: MutationViolation[];
  upstreamHandoffs?: UpstreamHandoff[];
  notRunReason?: string;
  blockedBy?: string[];
}

/** The persisted record for one completed delegation SEQUENCE. */
export interface PersistedDelegationRecord {
  /** Schema version ({@link DELEGATION_ENTRY_VERSION}). */
  v: number;
  /** Cross-package evidence contract identity; absent on legacy v1 records. */
  evidenceSchemaVersion?: typeof DELEGATION_EVIDENCE_SCHEMA_VERSION;
  /** The delegated task (scoped assignment). */
  task: string;
  /** Every owner the sequence resolved, in execution order. */
  owners: string[];
  /** The combined concrete target paths the delegation carried. */
  targets: string[];
  /** Short digest over the compiled grants, for provenance (ADR 0018). */
  grantDigest: string;
  /** Per-owner statuses and observed manifests. */
  steps: PersistedStep[];
  /** Sequence-total usage summed across delegated steps. */
  usage: DelegationUsage;
  /** Wall-clock start/end (Date.now at runtime). */
  startedAt: number;
  endedAt: number;
  /** Stable sequence identity for evaluator child reconciliation. */
  sequenceId?: string;
  assignmentGraph?: AssignmentGraph;
  integration?: IntegrationRecord;
  /**
   * What the sequence's one promotion did to the user's files. Optional because
   * records written before promotions were persisted have none, and a record that
   * never carried a promotion must render as silent rather than as some invented
   * status ({@link renderRecordLines}).
   */
  promotion?: PersistedPromotion;
}

/**
 * A short digest over the compiled grants of a delegation, so the record pins the
 * exact authority a sequence ran under (ADR 0018). Order-stable: the caller
 * passes grants in the resolver's owner order.
 */
export function digestGrants(grants: readonly CompiledGrant[]): string {
  const canonical = grants.map((grant) => ({
    grantId: grant.grantId,
    read: { allow: grant.read.allow, deny: grant.read.deny },
    write: { allow: grant.write.allow, deny: grant.write.deny },
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

/** Project one sequence step onto its persisted form. */
function toPersistedStep(step: SequenceStep): PersistedStep {
  switch (step.kind) {
    case "delegated": {
      const { outcome } = step;
      return {
        owner: outcome.owner,
        targets: [...outcome.assignment.targets],
        status: outcome.checkpoint.status,
        summary: outcome.checkpoint.summary,
        changedPaths: outcome.checkpoint.changedPaths,
        synthesized: outcome.checkpoint.synthesized,
        capabilitySummary: outcome.appendEntry.capabilitySummary,
        shellActivities: outcome.appendEntry.bashActivity.map((activity) => ({
          commandDigest: `sha256:${createHash("sha256").update(activity.command).digest("hex")}`,
        })),
        assignment: outcome.assignment,
        sequenceId: outcome.appendEntry.sequenceId,
        stepId: outcome.appendEntry.stepId,
        delegationId: outcome.appendEntry.delegationId,
        childSessionId: outcome.appendEntry.childSessionId,
        grantId: outcome.appendEntry.grantId,
        validation: outcome.checkpoint.validation,
        mutationViolations: outcome.checkpoint.mutationViolations ?? [],
        upstreamHandoffs: outcome.upstreamHandoffs,
      };
    }
    case "build_failed":
      return {
        owner: step.owner,
        targets: [...step.assignment.targets],
        status: "build_failed",
        summary: `Build failed (${step.failureKind}): ${step.diagnostics.join(" ")}`,
        changedPaths: [],
        assignment: step.assignment,
      };
    case "not_run":
      return {
        owner: step.owner,
        targets: [...step.assignment.targets],
        status: "not_run",
        summary:
          step.reason === "cancelled"
            ? "Not run — parent cancellation."
            : "Not run — the sequence stopped before this owner.",
        changedPaths: [],
        assignment: step.assignment,
        notRunReason: step.reason,
        blockedBy: step.blockedBy,
      };
  }
}

/** Flatten the sequence's promotion for the durable record. */
function toPersistedPromotion(promotion: PromotionRecord): PersistedPromotion {
  return {
    status: promotion.status,
    appliedPaths: [...promotion.appliedPaths],
    rejectedPaths: [...promotion.rejectedPaths],
    driftedPaths: [...promotion.driftedPaths],
    patchPath: promotion.patchPath,
    heldGovernance: promotion.heldGovernance && {
      patchPath: promotion.heldGovernance.patchPath,
      paths: [...promotion.heldGovernance.paths],
      baseCommit: promotion.heldGovernance.baseCommit,
    },
    acceptedWork: promotion.acceptedWork && {
      patchPath: promotion.acceptedWork.patchPath,
      paths: [...promotion.acceptedWork.paths],
      owners: [...promotion.acceptedWork.owners],
      baseCommit: promotion.acceptedWork.baseCommit,
      excludedGovernancePaths: [...promotion.acceptedWork.excludedGovernancePaths],
    },
    validations: promotion.validations.map((run) => ({
      agent: run.agent,
      program: run.program,
      args: [...run.args],
      status: run.status,
      exitCode: run.exitCode,
    })),
    validatorOutputPath: promotion.validatorOutputPath,
    diagnostics: [...promotion.diagnostics],
  };
}

/** Inputs needed to persist one completed delegation sequence. */
export interface BuildRecordInput {
  task: string;
  targets: string[];
  grantDigest: string;
  sequence: SequenceOutcome;
  startedAt: number;
  endedAt: number;
  sequenceId?: string;
  integration?: IntegrationRecord;
}

/**
 * Build a persisted record from a completed sequence. Pure and JSON-safe; the
 * sequence-total usage is the sum over delegated steps (build-failed / not-run
 * owners contribute nothing).
 */
export function buildDelegationRecord(input: BuildRecordInput): PersistedDelegationRecord {
  const steps = input.sequence.steps.map(toPersistedStep);
  const usage = sumUsage(
    input.sequence.steps
      .filter((step): step is Extract<SequenceStep, { kind: "delegated" }> => step.kind === "delegated")
      .map((step) => step.outcome.usage),
  );
  return {
    v: DELEGATION_ENTRY_VERSION,
    evidenceSchemaVersion: DELEGATION_EVIDENCE_SCHEMA_VERSION,
    task: input.task,
    owners: steps.map((step) => step.owner),
    targets: input.targets,
    grantDigest: input.grantDigest,
    steps,
    usage,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    sequenceId: input.sequenceId,
    assignmentGraph: input.sequence.assignmentGraph,
    integration: input.integration,
    promotion: toPersistedPromotion(input.sequence.promotion),
  };
}

/**
 * Parse a session entry into a {@link PersistedDelegationRecord}, or null when it
 * is not one of ours. Defensive by construction: it accepts only a custom entry
 * of {@link DELEGATION_ENTRY_TYPE} whose data is a plain object at the current
 * {@link DELEGATION_ENTRY_VERSION} with the expected array fields, so an
 * unrelated, foreign, or stale-version entry is ignored on rebuild rather than
 * trusted. This is what lets the history be rebuilt safely from an arbitrary
 * branch with interleaved entries.
 */
export function parseDelegationEntry(entry: unknown): PersistedDelegationRecord | null {
  if (!entry || typeof entry !== "object") return null;
  const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (candidate.type !== "custom" || candidate.customType !== DELEGATION_ENTRY_TYPE) return null;

  const data = candidate.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Partial<PersistedDelegationRecord>;
  if (
    record.v !== LEGACY_DELEGATION_ENTRY_VERSION &&
    record.v !== DELEGATION_ENTRY_VERSION
  ) {
    return null;
  }
  if (typeof record.task !== "string") return null;
  if (!Array.isArray(record.owners) || !Array.isArray(record.targets) || !Array.isArray(record.steps)) {
    return null;
  }
  return record as PersistedDelegationRecord;
}

function truncate(text: string, max = 60): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** A usage phrase, honest about "unavailable" when no usage was reported. */
export function formatUsage(usage: DelegationUsage): string {
  if (!usage.available) return "usage unavailable";
  return `${usage.totalTokens} tokens, $${usage.costUsd.toFixed(4)}`;
}

/**
 * One compact history line summarising a whole sequence for `/orca`. `approval` is what
 * the user has since decided about the sequence's held governance change, when anything.
 */
export function recordSummaryLine(
  record: PersistedDelegationRecord,
  approval?: GovernanceApproval,
): string {
  const statuses = record.steps.map((step) => `${step.owner}=${step.status}`).join(", ");
  const changed = record.steps.reduce((sum, step) => sum + step.changedPaths.length, 0);
  // The promotion belongs on the compact line too: every owner can read `completed`
  // while nothing at all reached the user's files, and a one-line history that omits
  // that reads as a success it was not. A `held` line that has since been approved says
  // so for the same reason — the status alone would keep it looking outstanding.
  const settled = isSettled(approval) ? " (governance approved)" : "";
  const promotion = record.promotion ? `promotion: ${record.promotion.status}${settled}; ` : "";
  return (
    `  - "${truncate(record.task)}" — ${statuses} ` +
    `(${changed} changed; ${promotion}${formatUsage(record.usage)})`
  );
}

/**
 * The full, readable rendering of one delegation record: task, provenance, each
 * owner's status, assignment, manifest, validation, and reconciled shell
 * evidence, followed by the steward's consolidated integration audit and
 * sequence usage. Shared by the transcript entry renderer and the `/orca`
 * last-delegation detail so both read identically.
 */
export function renderRecordLines(
  record: PersistedDelegationRecord,
  approval?: GovernanceApproval,
): string[] {
  const lines = [
    `Orca delegation — "${truncate(record.task, 100)}"`,
    `Owners (${record.owners.length}): ${record.owners.join(", ")}`,
    `Targets: ${record.targets.join(", ")}`,
    `Grant digest: ${record.grantDigest}`,
  ];
  if (record.sequenceId) lines.push(`Sequence identity: ${record.sequenceId}`);
  // What happened to the user's own files comes before the per-owner detail: it is
  // the sequence-level answer, and on a conflict it is also the only place the route
  // back to the preserved work is written down. Rendered through the same helpers as
  // the delegate tool's own output (`render.ts`), so the live report a steward reads
  // when a delegation ends and the history they read afterwards cannot disagree.
  if (record.promotion) {
    // The approval is layered onto the persisted promotion here rather than stored in it:
    // the record is append-only and was written before the user decided.
    const promotion = { ...record.promotion, governanceApproval: approval };
    lines.push(promotionHeadline(promotion));
    lines.push(...promotionDetailLines(promotion));
    for (const run of record.promotion.validations) {
      lines.push(
        `  Validator (${run.agent}): ${[run.program, ...run.args].join(" ")} — ${run.status}` +
          `${run.exitCode === undefined ? "" : ` (exit ${run.exitCode})`}`,
      );
    }
    if (record.promotion.validatorOutputPath) {
      lines.push(`  Preserved validator output: ${record.promotion.validatorOutputPath}`);
    }
  }
  for (const step of record.steps) {
    const synth = step.synthesized ? " (synthesized checkpoint)" : "";
    lines.push(`  ${step.owner}: ${step.status}${synth}`);
    lines.push(`    Summary: ${truncate(step.summary, 200)}`);
    lines.push(
      step.changedPaths.length > 0
        ? `    Observed changed paths (${step.changedPaths.length}): ${step.changedPaths.join(", ")}`
        : "    Observed changed paths: (none)",
    );
    if (step.capabilitySummary) {
      lines.push(`    Capability summary (not a mode): ${step.capabilitySummary}`);
    }
    if (step.assignment) {
      lines.push(`    Assignment: ${step.assignment.assignmentId} — ${step.assignment.task}`);
      lines.push(
        `    Dependencies: ${step.assignment.dependencies.join(", ") || "(none)"}`,
      );
    }
    if (step.notRunReason) {
      lines.push(`    Not-run reason: ${step.notRunReason}`);
      if ((step.blockedBy?.length ?? 0) > 0) {
        lines.push(`    Blocked by: ${step.blockedBy!.join(", ")}`);
      }
    }
    if (step.validation) {
      lines.push(`    Validation: ${step.validation.status}`);
      for (const activity of step.validation.activities) {
        lines.push(`      - ${activity.name} (${activity.kind}): ${activity.status}`);
      }
      if (step.validation.unavailablePrerequisites.length > 0) {
        lines.push(
          `    Unavailable prerequisites: ${step.validation.unavailablePrerequisites.join(", ")}`,
        );
      }
      if (step.validation.assumptions.length > 0) {
        lines.push(`    Assumptions: ${step.validation.assumptions.join("; ")}`);
      }
      if (step.validation.assertionChanges.length > 0) {
        lines.push("    Assertion/expected-output changes:");
        for (const change of step.validation.assertionChanges) {
          lines.push(`      - ${change.path} (${change.kind}): ${change.description}`);
        }
      }
    }
    const shell = step.shellActivities ?? [];
    if (shell.length > 0) {
      lines.push(`    Shell activities (sanitized digests) (${shell.length}):`);
      for (const activity of shell) lines.push(`      - ${activity.commandDigest}`);
    }
  }
  if (record.integration) {
    lines.push(`Combined diff identity: ${record.integration.diffIdentity}`);
    lines.push(
      `Integration decision: ${record.integration.decision.status} — ${record.integration.decision.reason}`,
    );
    lines.push(
      `Ownership audit: ${record.integration.ownershipAudit.compliant ? "compliant" : "failed"}`,
    );
    lines.push(
      `Dependency audit: ${record.integration.dependencyAudit.complete ? "complete" : "incomplete"}`,
    );
    lines.push(
      `Validation audit: ${record.integration.validationAudit.verified ? "verified" : "not verified"}`,
    );
    if (record.integration.validationAudit.failed.length > 0) {
      lines.push(`Failed validation owners: ${record.integration.validationAudit.failed.join(", ")}`);
    }
    if (record.integration.validationAudit.gaps.length > 0) {
      lines.push(`Validation gaps: ${record.integration.validationAudit.gaps.join(", ")}`);
    }
    for (const violation of record.integration.ownershipAudit.violations) {
      lines.push(
        `Mutation violation: ${violation.owner} ${violation.operation} ${violation.path} ` +
          `(${violation.source}, ${violation.disposition})`,
      );
    }
    for (const risk of record.integration.risks) {
      lines.push(`Remaining risk (${risk.owner}): ${risk.risk}`);
    }
    if (record.integration.signals.declaredTargetOverlaps.length > 0) {
      lines.push(
        `Overlapping assignments: ${record.integration.signals.declaredTargetOverlaps
          .map((entry) => `${entry.path} [${entry.owners.join(", ")}]`)
          .join("; ")}`,
      );
    }
    if (record.integration.signals.changedPathOverlaps.length > 0) {
      lines.push(
        `Observed changed-path overlap: ${record.integration.signals.changedPathOverlaps
          .map((entry) => `${entry.path} [${entry.owners.join(", ")}]`)
          .join("; ")}`,
      );
    }
    if (record.integration.signals.zeroChangeAssignments.length > 0) {
      lines.push(
        `Zero-change assignments: ${record.integration.signals.zeroChangeAssignments.join(", ")}`,
      );
    }
    if (record.integration.signals.repeatedValidationActivities.length > 0) {
      lines.push(
        `Repeated validation/investigation: ${record.integration.signals.repeatedValidationActivities
          .map((entry) => `${entry.name} [${entry.owners.join(", ")}]`)
          .join("; ")}`,
      );
    }
  }
  lines.push(`Usage: ${formatUsage(record.usage)}`);
  return lines;
}

/**
 * The in-memory delegation history surfaced under `/orca` and in notifications.
 * Unlike {@link RouteLog}/{@link ViolationLog} (session-scoped, lost on reload),
 * this history is DURABLE: it is rebuilt on every `session_start` from the
 * persisted session entries via {@link rebuildFrom}, and appended to live via
 * {@link add} as delegations complete. Both paths store the identical record
 * shape, so a live session and a resumed one display the same history.
 */
export class DelegationHistory {
  private records: PersistedDelegationRecord[] = [];

  /**
   * The last approval attempt per held patch, keyed by the patch's absolute path — the
   * one identity a hold and its approval share, and the one both sides of a resumed
   * session can still agree on. A `Map` because the key is a filesystem path.
   */
  private approvals = new Map<string, GovernanceApproval>();

  constructor(private readonly capacity = 50) {}

  /** Append a freshly-completed record, evicting the oldest beyond capacity. */
  add(record: PersistedDelegationRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
  }

  /** Remember one approval attempt; a later attempt on the same patch supersedes it. */
  recordApproval(approval: GovernanceApproval): void {
    this.approvals.set(approval.patchPath, approval);
  }

  /** What the user last decided about a record's held governance change, if anything. */
  approvalFor(record: PersistedDelegationRecord): GovernanceApproval | undefined {
    const patchPath = record.promotion?.heldGovernance?.patchPath;
    return patchPath === undefined ? undefined : this.approvals.get(patchPath);
  }

  /**
   * Every preserved artifact this history can still point a user at (hardening plan,
   * Phase 6): the absolute paths retention must not sweep however old the files are.
   *
   * This is the operative definition of a RETAINED reference, and it is deliberately
   * "whatever the visible history can print" rather than "whatever a session entry ever
   * said". The two differ at {@link capacity}: the records beyond it are evicted, so no
   * `/orca` surface — the summary list, the last-delegation detail, the pending-hold
   * list — can name their artifacts any more, and those files are precisely the orphans
   * age is meant to reclaim. Everything the surfaces CAN name is here, which is what
   * makes "sweeping never leaves a dangling pointer in visible history" checkable rather
   * than hoped for.
   *
   * Approvals count as references too, and not only for tidiness: an approved hold's
   * patch is the record of what was landed in the user's `.orca/**`, which is the one
   * thing they may need to read back long after the delegation scrolled away.
   *
   * Paths are compared by the sweeper as EXACT strings, so what is collected here is
   * what the promotion record stored — absolute by construction, since `stagingPaths`
   * builds every one of them from an absolute state root.
   */
  referencedArtifacts(): string[] {
    const paths = new Set<string>();
    for (const record of this.records) {
      const promotion = record.promotion;
      if (!promotion) continue;
      for (const path of [
        promotion.patchPath,
        promotion.validatorOutputPath,
        promotion.heldGovernance?.patchPath,
        promotion.acceptedWork?.patchPath,
      ]) {
        if (path) paths.add(path);
      }
    }
    for (const patchPath of this.approvals.keys()) paths.add(patchPath);
    return [...paths].sort();
  }

  /**
   * Every governance change a delegation in this history proposed, NEWEST FIRST, each
   * carrying whatever the user has decided about it. This is the list `/orca approve`
   * selects from, so the ordering is part of the command's contract: position 1 is the
   * newest, which is the hold a user almost always means.
   */
  holds(): GovernanceHold[] {
    const holds: GovernanceHold[] = [];
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      const held = record.promotion?.heldGovernance;
      if (!held) continue;
      holds.push({
        held,
        task: record.task,
        sequenceId: record.sequenceId,
        approval: this.approvals.get(held.patchPath),
      });
    }
    return holds;
  }

  /** The holds still awaiting a decision, in the order the selector counts them. */
  pendingHolds(): GovernanceHold[] {
    return this.holds().filter((hold) => !isSettled(hold.approval));
  }

  /**
   * The `/orca` pending-approval section, or empty when nothing is held. It leads the
   * numbered list with the command that acts on it, because a hold is the one thing in
   * the status surface that is waiting on the user.
   */
  pendingHoldLines(): string[] {
    const pending = this.pendingHolds();
    if (pending.length === 0) return [];
    return [
      `Governance changes awaiting your approval (${pending.length}) — \`/orca approve [n]\`:`,
      ...pending.map((hold, index) => governanceHoldLine(hold, index + 1)),
    ];
  }

  /**
   * Rebuild the history from session entries ALONE (session_start for every
   * reason). Clears first, then extracts every valid delegation entry in branch
   * order; unrelated and malformed entries are ignored. This is the only path a
   * resumed/forked session uses to recover its prior delegation history.
   */
  rebuildFrom(entries: readonly unknown[]): void {
    this.records = [];
    this.approvals = new Map();
    for (const entry of entries) {
      const record = parseDelegationEntry(entry);
      if (record) {
        this.add(record);
        continue;
      }
      // Approvals replay in branch order too, so the last decision about a patch is the
      // one a resumed session shows — including a refused attempt after an earlier one.
      const approval = parseApprovalEntry(entry);
      if (approval) this.recordApproval(approval);
    }
  }

  all(): readonly PersistedDelegationRecord[] {
    return this.records;
  }

  latest(): PersistedDelegationRecord | undefined {
    return this.records[this.records.length - 1];
  }

  count(): number {
    return this.records.length;
  }

  /** Compact `/orca` history summary, or empty when nothing has been delegated. */
  statusLines(): string[] {
    if (this.records.length === 0) return [];
    const lines = [`Delegation history (${this.records.length}):`];
    for (const record of this.records) {
      lines.push(recordSummaryLine(record, this.approvalFor(record)));
    }
    return lines;
  }

  /** Full detail of the most recent delegation (incl. bash activity), or empty. */
  lastDetailLines(): string[] {
    const latest = this.latest();
    if (!latest) return [];
    return ["Last delegation:", ...renderRecordLines(latest, this.approvalFor(latest))];
  }
}
