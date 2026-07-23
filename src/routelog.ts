/**
 * In-memory memory of the most recent route decisions, surfaced under `/orca`
 * status (PRD "last route decisions"). Session-scoped and deliberately not
 * persisted: a `/reload` builds a fresh extension instance and an empty log,
 * matching the Phase 3 treatment of the requested mode. Delegation-record
 * persistence as session entries is deferred to later phases.
 */
export class RouteLog {
  private readonly entries: string[] = [];

  constructor(private readonly capacity = 5) {}

  /** Record a one-line route summary, evicting the oldest beyond capacity. */
  record(summary: string): void {
    this.entries.push(summary);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /** Recent summaries, newest last (insertion order). */
  recent(): string[] {
    return [...this.entries];
  }

  /** `/orca` status lines, or an empty array when nothing has been resolved. */
  statusLines(): string[] {
    if (this.entries.length === 0) return [];
    const lines = [`Last route decisions (${this.entries.length}):`];
    for (const summary of this.entries) lines.push(`  - ${summary}`);
    return lines;
  }
}
