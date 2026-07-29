import { createHash } from "node:crypto";
import type {
  DomainAgent,
  EffectiveScope,
  OrcaSpecDocument,
  VectorDelegation,
  VectorPerTarget,
} from "orcaspec";
import { matchScope, matchesAny, specificityRank } from "./paths";

/**
 * The pure OrcaSpec resolver (ADR 0002, 0005, 0011, 0081).
 *
 * Given a parsed, already-validated spec document and a set of concrete
 * repository-relative target paths, it deterministically produces the same
 * route decision the normative resolution vectors encode: the most-specific
 * structural owner per target, one delegation per owner (ordered by owner id
 * ascending) carrying a compiled grant, and the set of unowned targets flagged
 * distinctly. It performs no model inference, no I/O, and imports nothing from
 * pi — its output must reproduce `vectors/*.vector.json` `expected` blocks
 * exactly (`matchesVector` in the tests projects a {@link Resolution} onto that
 * shape).
 *
 * {@link Resolution.perTarget}, {@link Resolution.delegations}, and
 * {@link Resolution.unownedPaths} are the canonical, vector-shaped decision.
 * {@link Resolution.reasoning} is parallel metadata (aligned by index with
 * `perTarget`) that the human-facing `orca_explain` rendering consumes; it never
 * alters the decision, so both tools render from one shared object.
 */

/** A compiled, edit-expanded grant for one owner. Read and write are independent. */
export interface CompiledGrant {
  read: EffectiveScope;
  write: EffectiveScope;
  /** Present only on target-scoped contract 1.1 grants. */
  schemaVersion?: typeof EFFECTIVE_GRANT_SCHEMA_VERSION;
  /** Stable checksum binding every authority input for this delegation. */
  grantId?: string;
  /** Resolved structural owner of the assigned targets. */
  owner?: string;
  /** Concrete assigned targets; never an ownership-wide wildcard. */
  targets?: readonly string[];
  /** Operations for which at least one assigned target is allowed. */
  allowedOperations?: readonly GrantOperation[];
  /** Identity of the governance document used for this resolution. */
  governanceIdentity?: string;
  /** Identity of the resolution cycle; scope expansion must use a fresh one. */
  resolutionCycleId?: string;
  /** Protected denies are bound explicitly, independently of agent denies. */
  protectedDenies?: Readonly<{
    read: readonly string[];
    write: readonly string[];
  }>;
}

/** Explicit next-version identity for target-scoped effective grants. */
export const EFFECTIVE_GRANT_SCHEMA_VERSION = "1.1" as const;

/** Grant operations bound into a 1.1 effective-grant identity. */
export type GrantOperation = "read" | "write";

/** A compiled grant carrying every required 1.1 identity field. */
export interface EffectiveGrant extends CompiledGrant {
  schemaVersion: typeof EFFECTIVE_GRANT_SCHEMA_VERSION;
  grantId: string;
  owner: string;
  targets: readonly string[];
  allowedOperations: readonly GrantOperation[];
  governanceIdentity: string;
  resolutionCycleId: string;
  protectedDenies: Readonly<{
    read: readonly string[];
    write: readonly string[];
  }>;
}

/** One delegation: an owner, its owned targets (input order), and its grant. */
export type ResolvedDelegation = VectorDelegation & { grant: CompiledGrant };

/** A less-specific ownership match that lost the most-specific-owner contest. */
export interface TrimmedOwnerMatch {
  owner: string;
  scope: string;
}

/** Why an owned target is not writable, for human-facing explanation. */
export interface WriteDenyReason {
  scope: string;
  source: "protected" | "agent";
}

/** Per-target reasoning, aligned by index with {@link Resolution.perTarget}. */
export interface TargetReasoning {
  path: string;
  owner: string | null;
  unowned: boolean;
  writable: boolean;
  /** The winning ownership scope, or null when unowned. */
  matchedScope: string | null;
  /** Other agents whose ownership also matched but were less specific. */
  otherMatches: TrimmedOwnerMatch[];
  /**
   * Set when an owned target is not writable: the write-deny scope that removed
   * write access and whether it came from the agent or a protected deny. Absent
   * when writable, or when the owner simply has no write authority for the path.
   */
  writeDeny?: WriteDenyReason;
  /** True when owned but no write-allow scope covers the path (read-only owner). */
  noWriteAuthority?: boolean;
}

/** The full resolver output. */
export interface Resolution {
  /** `0.1` is the legacy ownership-wide vector contract; `1.1` is target-scoped. */
  contractVersion: "0.1" | typeof EFFECTIVE_GRANT_SCHEMA_VERSION;
  perTarget: VectorPerTarget[];
  delegations: ResolvedDelegation[];
  unownedPaths: string[];
  reasoning: TargetReasoning[];
}

/** Resolution whose delegations are guaranteed to carry complete 1.1 grants. */
export interface EffectiveResolution extends Resolution {
  contractVersion: typeof EFFECTIVE_GRANT_SCHEMA_VERSION;
  delegations: Array<Omit<ResolvedDelegation, "grant"> & { grant: EffectiveGrant }>;
}

/** Sort ascending and de-duplicate a scope list. */
function sortUnique(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort();
}

function allow(scope: { allow?: string[] } | undefined): string[] {
  return scope?.allow ?? [];
}

function deny(scope: { deny?: string[] } | undefined): string[] {
  return scope?.deny ?? [];
}

/**
 * Deep-freeze a compiled grant and its scope arrays so it is a true immutable
 * record (ADR 0008: a live delegation grant is never broadened *or* mutated).
 * Freezing is structural, not conventional: a delegation record holds a frozen
 * grant, so no code path — not the resolver, the run loop, or the scope-expansion
 * loop — can widen an existing grant in place. Scope expansion must compile a
 * FRESH grant via a new {@link resolve} call; it cannot edit this one.
 */
export function freezeGrant(grant: CompiledGrant): CompiledGrant {
  Object.freeze(grant.read.allow);
  Object.freeze(grant.read.deny);
  Object.freeze(grant.read);
  Object.freeze(grant.write.allow);
  Object.freeze(grant.write.deny);
  Object.freeze(grant.write);
  if (grant.targets) Object.freeze(grant.targets);
  if (grant.allowedOperations) Object.freeze(grant.allowedOperations);
  if (grant.protectedDenies) {
    Object.freeze(grant.protectedDenies.read);
    Object.freeze(grant.protectedDenies.write);
    Object.freeze(grant.protectedDenies);
  }
  return Object.freeze(grant);
}

/**
 * Compile an agent's effective authority: edit-expanded ownership ∩ declared
 * permissions, minus agent denies and repository protected denies (ADR 0005,
 * 0015, 0033). `edit` contributes to both read and write; read and write stay
 * independent; every list is sorted and de-duplicated. The grant reflects the
 * agent's full authority and does not depend on which targets a delegation
 * carries. The returned grant is deep-frozen (ADR 0008): it is an immutable
 * authority record, never widened after compilation.
 */
export function compileGrant(
  agent: DomainAgent,
  protectedDenies: OrcaSpecDocument["protected_denies"],
): CompiledGrant {
  const permissions = agent.permissions;
  const editAllow = allow(permissions.edit);
  const editDeny = deny(permissions.edit);

  return freezeGrant({
    read: {
      allow: sortUnique([...allow(permissions.read), ...editAllow]),
      deny: sortUnique([...deny(permissions.read), ...editDeny, ...(protectedDenies.read ?? [])]),
    },
    write: {
      allow: sortUnique([...allow(permissions.write), ...editAllow]),
      deny: sortUnique([...deny(permissions.write), ...editDeny, ...(protectedDenies.write ?? [])]),
    },
  });
}

/** Resolution contract selection. The default remains the readable 0.1 vector shape. */
export interface ResolveOptions {
  contractVersion?: "0.1" | typeof EFFECTIVE_GRANT_SCHEMA_VERSION;
  /**
   * Prefer the raw governance-document checksum supplied by the repository
   * loader. A deterministic canonical-document checksum is used when omitted.
   */
  governanceIdentity?: string;
  /**
   * Stable identity for this resolution attempt. A scope request must be
   * followed by a new resolve call carrying a different cycle identity.
   */
  resolutionCycleId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function checksum(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

/** True when a grant is the explicit target-scoped 1.1 contract. */
export function isEffectiveGrant(grant: CompiledGrant): grant is EffectiveGrant {
  return (
    grant.schemaVersion === EFFECTIVE_GRANT_SCHEMA_VERSION &&
    typeof grant.grantId === "string" &&
    typeof grant.owner === "string" &&
    Array.isArray(grant.targets)
  );
}

/**
 * Restrict an owner's compiled authority to the concrete targets assigned by
 * the most-specific resolver. Denies remain complete and at least as
 * restrictive as the legacy grant.
 */
export function compileEffectiveGrant(
  agent: DomainAgent,
  targets: readonly string[],
  protectedDenies: OrcaSpecDocument["protected_denies"],
  governanceIdentity: string,
  resolutionCycleId: string,
): EffectiveGrant {
  const base = compileGrant(agent, protectedDenies);
  const concreteTargets = sortUnique(targets);
  const scoped = (operation: GrantOperation): string[] =>
    concreteTargets.filter((path) => checkScope(base, operation, path));
  const readAllow = scoped("read");
  const writeAllow = scoped("write");
  const allowedOperations: GrantOperation[] = [];
  if (readAllow.length > 0) allowedOperations.push("read");
  if (writeAllow.length > 0) allowedOperations.push("write");
  const protectedRead = sortUnique(protectedDenies?.read ?? []);
  const protectedWrite = sortUnique(protectedDenies?.write ?? []);

  const identityPayload = {
    schemaVersion: EFFECTIVE_GRANT_SCHEMA_VERSION,
    owner: agent.id,
    targets: concreteTargets,
    allowedOperations,
    read: { allow: readAllow, deny: base.read.deny },
    write: { allow: writeAllow, deny: base.write.deny },
    protectedDenies: { read: protectedRead, write: protectedWrite },
    governanceIdentity,
    resolutionCycleId,
  };
  return freezeGrant({
    ...identityPayload,
    grantId: checksum(identityPayload),
  }) as EffectiveGrant;
}

function checkScope(grant: CompiledGrant, operation: GrantOperation, path: string): boolean {
  const scope = operation === "read" ? grant.read : grant.write;
  return matchesAny(path, scope.allow) && !scope.deny.some((candidate) => matchScope(path, candidate));
}

interface OwnerSelection {
  owner: string;
  scope: string;
  others: TrimmedOwnerMatch[];
}

/**
 * Select the most-specific structural owner of `path`. Every agent contributes
 * its own most-specific matching ownership scope; the agent with the highest
 * specificity rank wins. Returns null when no ownership scope matches. The id
 * tie-break is defensive only — the grammar guarantees a unique winner, so it is
 * unreachable for a semantically valid spec.
 */
function selectOwner(agents: readonly DomainAgent[], path: string): OwnerSelection | null {
  const matches: { owner: string; scope: string; rank: number }[] = [];
  for (const agent of agents) {
    let best: { scope: string; rank: number } | undefined;
    for (const scope of agent.ownership) {
      if (!matchScope(path, scope)) continue;
      const rank = specificityRank(scope);
      if (!best || rank > best.rank) best = { scope, rank };
    }
    if (best) matches.push({ owner: agent.id, scope: best.scope, rank: best.rank });
  }
  if (matches.length === 0) return null;

  matches.sort((a, b) => (b.rank - a.rank) || (a.owner < b.owner ? -1 : 1));
  const [winner, ...rest] = matches;
  return {
    owner: winner.owner,
    scope: winner.scope,
    others: rest.map(({ owner, scope }) => ({ owner, scope })),
  };
}

/**
 * Determine writability and, when denied, why. `writable` is true only when the
 * grant's write-allow covers the path and no write-deny matches; deny takes
 * precedence. A matching protected deny is reported in preference to an agent
 * deny so the explanation names the strongest constraint.
 */
function writability(
  path: string,
  grant: CompiledGrant,
  protectedWrite: readonly string[],
): { writable: boolean; writeDeny?: WriteDenyReason; noWriteAuthority?: boolean } {
  if (!matchesAny(path, grant.write.allow)) {
    return { writable: false, noWriteAuthority: true };
  }
  const matchingDenies = grant.write.deny.filter((scope) => matchScope(path, scope));
  if (matchingDenies.length === 0) {
    return { writable: true };
  }
  const protectedSet = new Set(protectedWrite);
  const protectedHit = matchingDenies.find((scope) => protectedSet.has(scope));
  const scope = protectedHit ?? matchingDenies[0];
  return {
    writable: false,
    writeDeny: { scope, source: protectedHit ? "protected" : "agent" },
  };
}

/**
 * Resolve a set of concrete repository-relative target paths against a validated
 * OrcaSpec document. See {@link Resolution}. `targets` must already be
 * normalized (the tool layer does that); the resolver treats them verbatim so it
 * matches the vectors, which supply repository-relative paths directly.
 */
export function resolve(
  document: OrcaSpecDocument,
  targets: readonly string[],
  options: ResolveOptions = {},
): Resolution {
  const contractVersion = options.contractVersion ?? "0.1";
  const protectedDenies = document.protected_denies ?? {};
  const protectedWrite = protectedDenies.write ?? [];
  const governanceIdentity = options.governanceIdentity ?? checksum(document);
  const resolutionCycleId =
    options.resolutionCycleId ?? checksum({ governanceIdentity, targets: sortUnique(targets) });

  const grants = new Map<string, CompiledGrant>();
  const grantFor = (owner: string, assignedTargets?: readonly string[]): CompiledGrant => {
    if (contractVersion === EFFECTIVE_GRANT_SCHEMA_VERSION && assignedTargets) {
      const agent = document.agents.find((candidate) => candidate.id === owner)!;
      return compileEffectiveGrant(
        agent,
        assignedTargets,
        protectedDenies,
        governanceIdentity,
        resolutionCycleId,
      );
    }
    let grant = grants.get(owner);
    if (!grant) {
      const agent = document.agents.find((candidate) => candidate.id === owner)!;
      grant = compileGrant(agent, protectedDenies);
      grants.set(owner, grant);
    }
    return grant;
  };

  const perTarget: VectorPerTarget[] = [];
  const reasoning: TargetReasoning[] = [];
  const unownedPaths: string[] = [];
  const ownedTargets = new Map<string, string[]>();

  for (const path of targets) {
    const selection = selectOwner(document.agents, path);
    if (!selection) {
      perTarget.push({ path, owner: null, unowned: true, writable: false });
      reasoning.push({
        path,
        owner: null,
        unowned: true,
        writable: false,
        matchedScope: null,
        otherMatches: [],
      });
      unownedPaths.push(path);
      continue;
    }

    const grant = grantFor(selection.owner);
    const write = writability(path, grant, protectedWrite);
    perTarget.push({ path, owner: selection.owner, unowned: false, writable: write.writable });
    reasoning.push({
      path,
      owner: selection.owner,
      unowned: false,
      writable: write.writable,
      matchedScope: selection.scope,
      otherMatches: selection.others,
      writeDeny: write.writeDeny,
      noWriteAuthority: write.noWriteAuthority,
    });

    const bucket = ownedTargets.get(selection.owner);
    if (bucket) bucket.push(path);
    else ownedTargets.set(selection.owner, [path]);
  }

  const delegations: ResolvedDelegation[] = [...ownedTargets.keys()]
    .sort()
    .map((owner) => {
      const ownerTargets = ownedTargets.get(owner)!;
      return { owner, targets: ownerTargets, grant: grantFor(owner, ownerTargets) };
    });

  return { contractVersion, perTarget, delegations, unownedPaths, reasoning };
}

/**
 * Deliberate runtime opt-in to the 1.1 authority contract. Both identities are
 * required so orchestration cannot accidentally issue a grant detached from its
 * loaded governance bytes or reuse a live grant during scope expansion.
 */
export function resolveEffective(
  document: OrcaSpecDocument,
  targets: readonly string[],
  identities: {
    governanceIdentity: string;
    resolutionCycleId: string;
  },
): EffectiveResolution {
  return resolve(document, targets, {
    contractVersion: EFFECTIVE_GRANT_SCHEMA_VERSION,
    ...identities,
  }) as EffectiveResolution;
}
