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
  perTarget: VectorPerTarget[];
  delegations: ResolvedDelegation[];
  unownedPaths: string[];
  reasoning: TargetReasoning[];
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
 * Compile an agent's effective authority: edit-expanded ownership ∩ declared
 * permissions, minus agent denies and repository protected denies (ADR 0005,
 * 0015, 0033). `edit` contributes to both read and write; read and write stay
 * independent; every list is sorted and de-duplicated. The grant reflects the
 * agent's full authority and does not depend on which targets a delegation
 * carries.
 */
export function compileGrant(
  agent: DomainAgent,
  protectedDenies: OrcaSpecDocument["protected_denies"],
): CompiledGrant {
  const permissions = agent.permissions;
  const editAllow = allow(permissions.edit);
  const editDeny = deny(permissions.edit);

  return {
    read: {
      allow: sortUnique([...allow(permissions.read), ...editAllow]),
      deny: sortUnique([...deny(permissions.read), ...editDeny, ...(protectedDenies.read ?? [])]),
    },
    write: {
      allow: sortUnique([...allow(permissions.write), ...editAllow]),
      deny: sortUnique([...deny(permissions.write), ...editDeny, ...(protectedDenies.write ?? [])]),
    },
  };
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
export function resolve(document: OrcaSpecDocument, targets: readonly string[]): Resolution {
  const protectedDenies = document.protected_denies ?? {};
  const protectedWrite = protectedDenies.write ?? [];

  const grants = new Map<string, CompiledGrant>();
  const grantFor = (owner: string): CompiledGrant => {
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
    .map((owner) => ({ owner, targets: ownedTargets.get(owner)!, grant: grantFor(owner) }));

  return { perTarget, delegations, unownedPaths, reasoning };
}
