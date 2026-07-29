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

/** The record schema version; bump on any breaking shape change. */
export const LEGACY_DELEGATION_ENTRY_VERSION = 1;
export const DELEGATION_ENTRY_VERSION = 2;
export const DELEGATION_EVIDENCE_SCHEMA_VERSION = "1.1" as const;

export interface PersistedShellActivity {
  commandDigest: string;
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

/** One compact history line summarising a whole sequence for `/orca`. */
export function recordSummaryLine(record: PersistedDelegationRecord): string {
  const statuses = record.steps.map((step) => `${step.owner}=${step.status}`).join(", ");
  const changed = record.steps.reduce((sum, step) => sum + step.changedPaths.length, 0);
  return `  - "${truncate(record.task)}" — ${statuses} (${changed} changed; ${formatUsage(record.usage)})`;
}

/**
 * The full, readable rendering of one delegation record: task, provenance, each
 * owner's status, assignment, manifest, validation, and reconciled shell
 * evidence, followed by the steward's consolidated integration audit and
 * sequence usage. Shared by the transcript entry renderer and the `/orca`
 * last-delegation detail so both read identically.
 */
export function renderRecordLines(record: PersistedDelegationRecord): string[] {
  const lines = [
    `Orca delegation — "${truncate(record.task, 100)}"`,
    `Owners (${record.owners.length}): ${record.owners.join(", ")}`,
    `Targets: ${record.targets.join(", ")}`,
    `Grant digest: ${record.grantDigest}`,
  ];
  if (record.sequenceId) lines.push(`Sequence identity: ${record.sequenceId}`);
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

  constructor(private readonly capacity = 50) {}

  /** Append a freshly-completed record, evicting the oldest beyond capacity. */
  add(record: PersistedDelegationRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
  }

  /**
   * Rebuild the history from session entries ALONE (session_start for every
   * reason). Clears first, then extracts every valid delegation entry in branch
   * order; unrelated and malformed entries are ignored. This is the only path a
   * resumed/forked session uses to recover its prior delegation history.
   */
  rebuildFrom(entries: readonly unknown[]): void {
    this.records = [];
    for (const entry of entries) {
      const record = parseDelegationEntry(entry);
      if (record) this.add(record);
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
    for (const record of this.records) lines.push(recordSummaryLine(record));
    return lines;
  }

  /** Full detail of the most recent delegation (incl. bash activity), or empty. */
  lastDetailLines(): string[] {
    const latest = this.latest();
    if (!latest) return [];
    return ["Last delegation:", ...renderRecordLines(latest)];
  }
}
