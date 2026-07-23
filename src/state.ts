import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OrcaSpecDocument } from "orcaspec";
import type { Diagnostic } from "./diagnostics";
import { DEFAULT_MODE, stricterMode, type OperatingMode } from "./mode";
import { loadSpec, type DeclaredAgent, type SpecDigest } from "./load";

/** Directory, relative to the repository root, that holds the OrcaSpec document. */
export const ORCA_DIR = ".orca";

/** OrcaSpec document filename within {@link ORCA_DIR}. */
export const ORCA_SPEC_FILE = "orca.yaml";

/**
 * Governance state of a repository as seen by the extension.
 *
 * Exactly one of these holds after inspecting the working directory: absence
 * (`unmanaged`) is pass-through with no governance (ADR 0027); a present spec is
 * loaded and validated into `active`, `invalid_spec`, or
 * `unsupported_spec_version`. The two blocked states carry actionable
 * diagnostics and apply identically in advisory and enforce modes (ADR 0028).
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

/** A valid spec: governance is active with a computed effective mode. */
export interface ActiveState {
  kind: "active";
  cwd: string;
  specPath: string;
  document: OrcaSpecDocument;
  digest: SpecDigest;
  agents: DeclaredAgent[];
  /** `repository.minimum_mode` (defaulted to advisory when absent). */
  minimumMode: OperatingMode;
  /** The user-requested mode fed into this detection. */
  requestedMode: OperatingMode;
  /** The stricter of {@link minimumMode} and {@link requestedMode} (ADR 0063). */
  effectiveMode: OperatingMode;
}

/** The spec is present but fails restricted-YAML, structural, or semantic validation. */
export interface InvalidSpecState {
  kind: "invalid_spec";
  cwd: string;
  specPath: string;
  digest: SpecDigest;
  diagnostics: Diagnostic[];
}

/** The spec declares a well-formed but unsupported `spec_version`. */
export interface UnsupportedSpecVersionState {
  kind: "unsupported_spec_version";
  cwd: string;
  specPath: string;
  digest: SpecDigest;
  foundVersion: string;
  supportedVersion: string;
  diagnostics: Diagnostic[];
}

/** Absolute path to the OrcaSpec document for a repository root. */
export function specPathFor(cwd: string): string {
  return join(cwd, ORCA_DIR, ORCA_SPEC_FILE);
}

/**
 * Inspect a working directory and classify its Orca governance state.
 *
 * When no `.orca/orca.yaml` regular file is present the repository is
 * `unmanaged`. Otherwise the document is read and run through {@link loadSpec};
 * the resulting outcome, plus the caller's `requestedMode`, determines the
 * effective mode for an `active` repository. Blocked outcomes ignore the
 * requested mode: they block identically in both modes (ADR 0028).
 */
export function detectRepositoryState(
  cwd: string,
  requestedMode: OperatingMode = DEFAULT_MODE,
): RepositoryState {
  const specPath = specPathFor(cwd);
  if (!existsSync(specPath) || !statSync(specPath).isFile()) {
    return { kind: "unmanaged", cwd };
  }

  const outcome = loadSpec(readFileSync(specPath, "utf8"));
  switch (outcome.kind) {
    case "valid":
      return {
        kind: "active",
        cwd,
        specPath,
        document: outcome.document,
        digest: outcome.digest,
        agents: outcome.agents,
        minimumMode: outcome.minimumMode,
        requestedMode,
        effectiveMode: stricterMode(outcome.minimumMode, requestedMode),
      };
    case "invalid_spec":
      return {
        kind: "invalid_spec",
        cwd,
        specPath,
        digest: outcome.digest,
        diagnostics: outcome.diagnostics,
      };
    case "unsupported_spec_version":
      return {
        kind: "unsupported_spec_version",
        cwd,
        specPath,
        digest: outcome.digest,
        foundVersion: outcome.foundVersion,
        supportedVersion: outcome.supportedVersion,
        diagnostics: outcome.diagnostics,
      };
  }
}

/** Short, single-line status suitable for a footer / status key. */
export function shortStatus(state: RepositoryState): string {
  switch (state.kind) {
    case "unmanaged":
      return "orca: unmanaged";
    case "active":
      return `orca: ${state.effectiveMode}`;
    case "invalid_spec":
      return "orca: invalid_spec";
    case "unsupported_spec_version":
      return "orca: unsupported_spec_version";
  }
}

/** The notification severity that matches a state. */
export function statusLevel(state: RepositoryState): "info" | "warning" | "error" {
  switch (state.kind) {
    case "unmanaged":
    case "active":
      return "info";
    case "invalid_spec":
    case "unsupported_spec_version":
      return "error";
  }
}

/**
 * Human-readable status lines for `/orca` output and widgets. Presents
 * managed/unmanaged, the effective mode and its two inputs, the spec digest,
 * declared agents, and — for blocked states — the full diagnostics. The content
 * is identical whether surfaced via UI or plain text.
 */
export function formatStatusLines(state: RepositoryState): string[] {
  switch (state.kind) {
    case "unmanaged":
      return [
        "Orca: unmanaged",
        `No ${ORCA_DIR}/${ORCA_SPEC_FILE} in ${state.cwd}.`,
        "pi is running with no Orca governance and no tool interception.",
      ];
    case "active": {
      const lines = [
        "Orca: managed (active)",
        `Spec: ${state.specPath}`,
        `Digest: ${state.digest.short}`,
        `Effective mode: ${state.effectiveMode} (repository minimum_mode: ${state.minimumMode}, requested: ${state.requestedMode})`,
      ];
      if (state.agents.length === 0) {
        lines.push("Agents: none declared (every writable path is unowned).");
      } else {
        lines.push(`Agents (${state.agents.length}):`);
        for (const agent of state.agents) lines.push(`  - ${agent.id} — ${agent.name}`);
      }
      return lines;
    }
    case "invalid_spec":
      return [
        "Orca: blocked (invalid_spec)",
        `Spec: ${state.specPath}`,
        `Digest: ${state.digest.short}`,
        "The OrcaSpec document is present but failed validation. Orca-managed work is blocked in both advisory and enforce modes until it is fixed (ADR 0028).",
        ...formatDiagnostics(state.diagnostics),
      ];
    case "unsupported_spec_version":
      return [
        "Orca: blocked (unsupported_spec_version)",
        `Spec: ${state.specPath}`,
        `Digest: ${state.digest.short}`,
        `The document declares spec_version '${state.foundVersion}', but this runtime supports '${state.supportedVersion}'. Orca-managed work is blocked in both modes until the version is supported or the document is updated (ADR 0028, 0046).`,
        ...formatDiagnostics(state.diagnostics),
      ];
  }
}

function formatDiagnostics(diagnostics: Diagnostic[]): string[] {
  const lines = [`Diagnostics (${diagnostics.length}):`];
  for (const diagnostic of diagnostics) {
    const location =
      diagnostic.pointer !== undefined && diagnostic.pointer !== ""
        ? ` at ${diagnostic.pointer}`
        : diagnostic.path
          ? ` at ${diagnostic.path}`
          : "";
    lines.push(`  - [${diagnostic.reason}]${location}: ${diagnostic.message}`);
  }
  return lines;
}
