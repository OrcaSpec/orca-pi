/**
 * Validation diagnostics produced while loading `.orca/orca.yaml`.
 *
 * A {@link Diagnostic} is the single, actionable unit reported to the user for
 * every blocked repository state (`invalid_spec`, `unsupported_spec_version`).
 * Diagnostics are never partial policy: a blocked spec produces diagnostics and
 * activates no governance (ADR 0028).
 */

/** Which validation stage produced a diagnostic. */
export type DiagnosticPhase = "yaml" | "structural" | "semantic";

/**
 * A single actionable validation problem.
 *
 * `reason` is a stable, namespaced code:
 * - `structural.*` and `semantic.*` align with OrcaSpec's fixture annotations
 *   (see the `orcaspec` package README and `fixtures/invalid/*.expected.json`).
 *   Aligned structural codes: `missing_required`, `unknown_field`,
 *   `invalid_enum`, `invalid_path_scope`, `invalid_spec_version_format`,
 *   `invalid_specialty_id`. Aligned semantic codes: `unsupported_spec_version`,
 *   `duplicate_agent_id`, `ownership_conflict`.
 * - `yaml.*` codes are the restricted-YAML profile this loader enforces per
 *   ADR 0025 (aliases, anchors, custom tags, merge keys, duplicate keys, and
 *   multiple documents). OrcaSpec ships no fixtures for YAML-profile violations,
 *   so these codes are orca-pi-local (recorded as a non-blocking spec-gap).
 */
export interface Diagnostic {
  phase: DiagnosticPhase;
  /** Stable, namespaced reason code (e.g. `structural.unknown_field`). */
  reason: string;
  /** Human-readable, actionable explanation. */
  message: string;
  /**
   * JSON Pointer to the offending node. `""` is the document root. Absent when
   * the problem cannot be anchored to a node (e.g. a whole-document YAML error).
   */
  pointer?: string;
  /** Human-readable dotted/indexed path, when available (e.g. `agents[0].id`). */
  path?: string;
  /** Extra structured detail (e.g. the duplicated id or conflicting scope). */
  detail?: Record<string, unknown>;
}
