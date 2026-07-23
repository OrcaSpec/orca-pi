import { SPEC_VERSION } from "orcaspec";
import type { OrcaSpecDocument } from "orcaspec";
import type { Diagnostic } from "./diagnostics";

/**
 * Semantic validation: cross-field rules applied only after structural
 * validation passes (ADR 0045). A structurally valid document can still be
 * semantically invalid.
 *
 * This phase implements the three rules OrcaSpec's invalid fixtures encode:
 * - unsupported (but well-formed) spec version — a distinct blocking state,
 *   `unsupported_spec_version`, not `invalid_spec` (ADR 0046, 0028);
 * - duplicate agent id — `invalid_spec` (ADR 0029);
 * - ownership conflict — `invalid_spec` (ADR 0011).
 *
 * Reason codes and pointers align with `fixtures/invalid/*.expected.json`.
 */

/**
 * Return the `unsupported_spec_version` diagnostic when `spec_version` is
 * well-formed (structural validation guarantees the major.minor shape) but not
 * the version this runtime supports. A runtime rejects any version it does not
 * explicitly support, including a newer minor (ADR 0046).
 */
export function checkUnsupportedVersion(doc: OrcaSpecDocument): Diagnostic | undefined {
  const found = doc.spec_version;
  if (found === SPEC_VERSION) return undefined;
  return {
    phase: "semantic",
    reason: "semantic.unsupported_spec_version",
    message: `spec_version '${found}' is well-formed but not supported by this OrcaSpec ${SPEC_VERSION} runtime; a runtime rejects a version it does not explicitly support (ADR 0046).`,
    pointer: "/spec_version",
    path: "spec_version",
    detail: { found, supported: SPEC_VERSION },
  };
}

/** Every `invalid_spec` semantic rule, in document order. */
export function checkSemanticRules(doc: OrcaSpecDocument): Diagnostic[] {
  return [...duplicateAgentIds(doc), ...ownershipConflicts(doc)];
}

/**
 * `agent.id` must be unique within a repository because logical identity is
 * `repository.id` + `agent.id` (ADR 0029). The diagnostic is anchored on the
 * later of the two agents sharing an id.
 */
function duplicateAgentIds(doc: OrcaSpecDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const firstSeen = new Map<string, string>();
  doc.agents.forEach((agent, index) => {
    if (firstSeen.has(agent.id)) {
      diagnostics.push({
        phase: "semantic",
        reason: "semantic.duplicate_agent_id",
        message: `Two agents share id '${agent.id}'. agent.id must be unique within a repository because logical identity is repository.id + agent.id (ADR 0029).`,
        pointer: `/agents/${index}/id`,
        path: `agents[${index}].id`,
        detail: { id: agent.id },
      });
    } else {
      firstSeen.set(agent.id, agent.id);
    }
  });
  return diagnostics;
}

/**
 * Two agents declaring the identical ownership scope leave the target without a
 * structurally unique owner (ADR 0011). With the exact-path / recursive-prefix
 * grammar this is the only structurally expressible conflict: any two scopes are
 * otherwise equal, strictly nested (the most-specific owns; the Phase 4 resolver
 * relies on this), or disjoint. The diagnostic is anchored on the later agent's
 * repeated scope. Repeating a scope within one agent's own ownership is not a
 * conflict.
 */
function ownershipConflicts(doc: OrcaSpecDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const owner = new Map<string, string>();
  doc.agents.forEach((agent, agentIndex) => {
    agent.ownership.forEach((scope, scopeIndex) => {
      const first = owner.get(scope);
      if (first === undefined) {
        owner.set(scope, agent.id);
      } else if (first !== agent.id) {
        diagnostics.push({
          phase: "semantic",
          reason: "semantic.ownership_conflict",
          message: `Agents '${first}' and '${agent.id}' declare the identical ownership scope '${scope}'. Equal ownership scopes leave the target without a structurally unique owner and are invalid (ADR 0011).`,
          pointer: `/agents/${agentIndex}/ownership/${scopeIndex}`,
          path: `agents[${agentIndex}].ownership[${scopeIndex}]`,
          detail: { scope, agents: [first, agent.id] },
        });
      }
    });
  });
  return diagnostics;
}
