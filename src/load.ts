import { createHash } from "node:crypto";
import { SPEC_VERSION } from "orcaspec";
import type { OrcaSpecDocument } from "orcaspec";
import type { Diagnostic } from "./diagnostics";
import { DEFAULT_MODE, type OperatingMode } from "./mode";
import { salvageProtectedDenies, type ProtectionSalvage } from "./salvage";
import { parseRestrictedYaml } from "./yaml";
import { validateStructural } from "./schema";
import { checkSemanticRules, checkUnsupportedVersion } from "./semantic";

/**
 * Load and validate a `.orca/orca.yaml` source into exactly one outcome:
 * `valid`, `invalid_spec`, or `unsupported_spec_version`. The pipeline is
 * restricted-YAML parse (ADR 0025) → structural validation (ADR 0045) → version
 * support check (ADR 0046) → semantic validation, short-circuiting at the first
 * failing phase. A present but unusable spec is always blocking and never
 * activates partial governance (ADR 0028).
 *
 * The one thing carried out of an unusable document is its protected read denies,
 * best-effort (see `salvage.ts`). That is not partial governance: salvaged
 * protections grant nothing and can only ADD read refusals to the fail-closed
 * broken-spec regime.
 */

export interface SpecDigest {
  /** Full lowercase hex sha256 of the raw (UTF-8) file contents. */
  sha256: string;
  /** Short display form: `sha256:` + the first 12 hex characters. */
  short: string;
}

/** Minimal identity of a declared domain agent, for status display. */
export interface DeclaredAgent {
  id: string;
  name: string;
}

export type LoadOutcome =
  | {
      kind: "valid";
      document: OrcaSpecDocument;
      digest: SpecDigest;
      agents: DeclaredAgent[];
      /** `repository.minimum_mode`, defaulted to advisory when absent (ADR 0063). */
      minimumMode: OperatingMode;
    }
  | {
      kind: "invalid_spec";
      digest: SpecDigest;
      diagnostics: Diagnostic[];
      /** Protected read denies recovered from the unusable document (ADR 0015, 0068). */
      protections: ProtectionSalvage;
    }
  | {
      kind: "unsupported_spec_version";
      digest: SpecDigest;
      foundVersion: string;
      supportedVersion: string;
      diagnostics: Diagnostic[];
      /** Protected read denies recovered from the unusable document (ADR 0015, 0068). */
      protections: ProtectionSalvage;
    };

/** Compute the spec digest from the raw document source. */
export function digestOf(source: string): SpecDigest {
  const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
  return { sha256, short: `sha256:${sha256.slice(0, 12)}` };
}

export function loadSpec(source: string): LoadOutcome {
  const digest = digestOf(source);
  // Every broken outcome carries the same salvage attempt, computed from the same
  // source, so `invalid_spec` and `unsupported_spec_version` protect reads alike.
  const invalid = (diagnostics: Diagnostic[]): LoadOutcome => ({
    kind: "invalid_spec",
    digest,
    diagnostics,
    protections: salvageProtectedDenies(source),
  });

  const yaml = parseRestrictedYaml(source);
  if (!yaml.ok) {
    return invalid(yaml.diagnostics);
  }

  const structural = validateStructural(yaml.value);
  if (structural.length > 0) {
    return invalid(structural);
  }

  // Structural validation guarantees the six-section shape and field types.
  const document = yaml.value as OrcaSpecDocument;

  const unsupported = checkUnsupportedVersion(document);
  if (unsupported) {
    return {
      kind: "unsupported_spec_version",
      digest,
      foundVersion: document.spec_version,
      supportedVersion: SPEC_VERSION,
      diagnostics: [unsupported],
      protections: salvageProtectedDenies(source),
    };
  }

  const semantic = checkSemanticRules(document);
  if (semantic.length > 0) {
    return invalid(semantic);
  }

  return {
    kind: "valid",
    document,
    digest,
    agents: document.agents.map((agent) => ({ id: agent.id, name: agent.name })),
    minimumMode: document.repository.minimum_mode ?? DEFAULT_MODE,
  };
}
