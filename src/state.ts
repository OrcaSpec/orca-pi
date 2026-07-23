import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directory, relative to the repository root, that holds the OrcaSpec document. */
export const ORCA_DIR = ".orca";

/** OrcaSpec document filename within {@link ORCA_DIR}. */
export const ORCA_SPEC_FILE = "orca.yaml";

/**
 * Governance state of a repository as seen by the extension.
 *
 * This discriminated union is the durable contract. Phase 2 constructs only
 * `unmanaged` and a placeholder `active`; Phase 3 replaces the spec-present
 * branch of {@link detectRepositoryState} with real load + structural/semantic
 * validation that resolves to `active`, `invalid_spec`, or
 * `unsupported_spec_version` and enriches the payloads below.
 */
export type RepositoryState =
  | UnmanagedState
  | ActiveState
  | InvalidSpecState
  | UnsupportedSpecVersionState;

/** No `.orca/orca.yaml`: pi behaves exactly as unmanaged pi. */
export interface UnmanagedState {
  kind: "unmanaged";
  cwd: string;
}

/** A spec is present and (from Phase 3) valid; governance is active. */
export interface ActiveState {
  kind: "active";
  cwd: string;
  specPath: string;
  // Phase 3 adds: parsed document, effective mode, spec digest, declared agents.
}

/** The spec is present but fails structural or semantic validation (Phase 3). */
export interface InvalidSpecState {
  kind: "invalid_spec";
  cwd: string;
  specPath: string;
  // Phase 3 adds: actionable structural/semantic diagnostics.
}

/** The spec declares a `spec_version` this build does not support (Phase 3). */
export interface UnsupportedSpecVersionState {
  kind: "unsupported_spec_version";
  cwd: string;
  specPath: string;
  // Phase 3 adds: the found version vs the supported OrcaSpec SPEC_VERSION.
}

/** Absolute path to the OrcaSpec document for a repository root. */
export function specPathFor(cwd: string): string {
  return join(cwd, ORCA_DIR, ORCA_SPEC_FILE);
}

/**
 * Inspect a working directory and classify its Orca governance state.
 *
 * Phase 2 scope: distinguish `unmanaged` (no `.orca/orca.yaml`) from a detected
 * spec file. When a spec file is present we return `active` as a placeholder
 * that carries only its path — no governance and no tool interception are
 * activated anywhere in Phase 2. Phase 3 replaces the spec-present branch with
 * parsing and validation.
 */
export function detectRepositoryState(cwd: string): RepositoryState {
  const specPath = specPathFor(cwd);
  if (!existsSync(specPath) || !statSync(specPath).isFile()) {
    return { kind: "unmanaged", cwd };
  }
  return { kind: "active", cwd, specPath };
}

/** Short, single-line status suitable for a footer / status key. */
export function shortStatus(state: RepositoryState): string {
  return `orca: ${state.kind}`;
}

/** Human-readable status lines for `/orca` output and widgets. */
export function formatStatusLines(state: RepositoryState): string[] {
  switch (state.kind) {
    case "unmanaged":
      return [
        "Orca: unmanaged",
        `No ${ORCA_DIR}/${ORCA_SPEC_FILE} in ${state.cwd}.`,
        "pi is running with no Orca governance and no tool interception.",
      ];
    case "active":
      return [
        "Orca: spec detected",
        `Found ${state.specPath}.`,
        "Spec loading and steward governance arrive in Phase 3; no governance is active yet.",
      ];
    case "invalid_spec":
      return [
        "Orca: invalid spec",
        `See diagnostics for ${state.specPath}.`,
      ];
    case "unsupported_spec_version":
      return [
        "Orca: unsupported spec version",
        `See ${state.specPath}.`,
      ];
  }
}
