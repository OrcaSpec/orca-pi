import type { OperatingMode } from "./mode";
import type { GovernedTool } from "./governance";

/**
 * In-memory memory of the most recent governance events, surfaced under `/orca`
 * status (PRD "violations"). Session-scoped and deliberately not persisted, like
 * {@link RouteLog}: a `/reload` builds a fresh extension instance with an empty
 * log. Phase 8 polishes the notification/status UX; this keeps the minimum
 * record — what was blocked or flagged, on which tool and path, whose scope, and
 * under which mode — so Goal 8 (explain to model AND human) has a durable
 * human-facing trail alongside the per-call notifications.
 */

/** One recorded governance event. `blocked` withheld the call; `flagged` let it proceed. */
export interface ViolationRecord {
  verdict: "blocked" | "flagged";
  tool: GovernedTool;
  /** Display path (the raw call target, `(cwd)` for a pathless discovery call). */
  path: string;
  /** Owning agent for an owned-scope write, else null. */
  owner: string | null;
  mode: OperatingMode;
  reason: string;
  timestamp: number;
}

export class ViolationLog {
  private readonly entries: ViolationRecord[] = [];

  constructor(private readonly capacity = 5) {}

  /** Record a governance event, evicting the oldest beyond capacity. */
  record(entry: ViolationRecord): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /** Recorded events, newest last (insertion order). */
  recent(): ViolationRecord[] {
    return [...this.entries];
  }

  /** `/orca` status lines, or an empty array when nothing has been governed. */
  statusLines(): string[] {
    if (this.entries.length === 0) return [];
    const lines = [`Governance events (${this.entries.length}):`];
    for (const entry of this.entries) {
      const owner = entry.owner ? ` [owner: ${entry.owner}]` : "";
      lines.push(`  - ${entry.verdict} ${entry.tool} ${entry.path} (${entry.mode})${owner}`);
    }
    return lines;
  }
}
