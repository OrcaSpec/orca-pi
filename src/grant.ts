import type { CompiledGrant } from "./resolver";
import { matchScope, matchesAny } from "./paths";

/**
 * Pure grant checks for delegated-session file tools (ADR 0078, 0005, 0015).
 *
 * A delegation's {@link CompiledGrant} is edit-expanded ownership ∩ declared
 * permissions, minus agent denies and protected denies — the resolver has
 * already merged protected denies into the deny lists, so a grant check here is
 * the complete authorization decision for one path. `read` uses the read scope,
 * `write`/`edit` use the write scope; both are `allow` minus `deny`, deny taking
 * precedence (glossary "Deny precedence").
 *
 * These functions are the single decision point the grant-wrapped tools consult
 * (`delegation-tools.ts`): they perform no I/O and import nothing from pi, so the
 * allow/deny matrix is exercised directly. A denied check carries a
 * model-visible {@link GrantDecision.reason} naming the boundary; the tool turns
 * it into an explanatory throw so the agent cannot call authority it lacks.
 */

/** Which side of the grant a path-bearing tool call is checked against. */
export type GrantOperation = "read" | "write";

/** The outcome of one grant check. `reason` is present only when denied. */
export interface GrantDecision {
  allowed: boolean;
  /** Model- and human-visible boundary explanation; empty when allowed. */
  reason: string;
}

function scopeFor(grant: CompiledGrant, operation: GrantOperation) {
  return operation === "read" ? grant.read : grant.write;
}

function list(scopes: readonly string[]): string {
  return scopes.length > 0 ? scopes.join(", ") : "(none)";
}

/**
 * Decide whether a delegated session may {@link operation} the
 * repository-relative `path` under `grant`. Allowed only when an allow scope
 * covers the path and no deny scope matches; deny wins. The denial reason names
 * the effective boundary (the operation's allow set, and the matching deny scope
 * when a deny is what removed access) so the throw the tool raises is
 * self-explanatory and cannot be mistaken for a transient failure.
 */
export function checkGrant(
  grant: CompiledGrant,
  operation: GrantOperation,
  path: string,
): GrantDecision {
  const scope = scopeFor(grant, operation);

  if (!matchesAny(path, scope.allow)) {
    return {
      allowed: false,
      reason:
        `Orca grant boundary: \`${path}\` is outside this delegation's ${operation} authority. ` +
        `The grant permits ${operation} only under: ${list(scope.allow)}. This file tool cannot ` +
        "act on a path the grant does not allow (ADR 0078); delegate the work to that path's owner instead.",
    };
  }

  const deny = scope.deny.find((candidate) => matchScope(path, candidate));
  if (deny !== undefined) {
    return {
      allowed: false,
      reason:
        `Orca grant boundary: \`${path}\` is under a ${operation} deny (\`${deny}\`) that overrides the ` +
        "grant's allow set. Denies — including non-overridable protected denies — take precedence over " +
        "edit-expanded ownership (ADR 0015), so this file tool cannot act on the path.",
    };
  }

  return { allowed: true, reason: "" };
}
