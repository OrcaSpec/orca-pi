import type { OrcaSpecDocument } from "orcaspec";
import type { OperatingMode } from "./mode";
import { matchesAny } from "./paths";
import { resolve } from "./resolver";

/**
 * Pure steward-governance decisions (ADR 0080, 0022, 0012, 0015, 0032).
 *
 * The parent pi session is the repository steward: it holds no implicit write
 * authority and reads only within its declared discovery scope. These functions
 * turn a governed tool call (already reduced to a repository-relative path, or a
 * boundary/symlink marker by the impure caller in `index.ts`) into one
 * {@link GovernanceDecision}. They perform no I/O and import nothing from pi, so
 * the enforce/advisory matrix is exercised directly in `governance.test.ts`.
 *
 * The verdict is mode-shaped for ordinary violations — `block` in enforce,
 * `flag` (proceed, record an advisory policy violation) in advisory — with two
 * documented exceptions that hold in *both* modes:
 *
 * - **Protected denies** (ADR 0015, glossary "Non-overridable constraint"): a
 *   protected-denied read is blocked in advisory as well as enforce. Advisory
 *   mode reports rather than blocks *ordinary* policy (ADR 0080), but a protected
 *   deny is non-overridable and excludes sensitive assets everywhere (ADR 0015,
 *   0068 "Protected denies override discovery permission"). The PRD's blanket
 *   "advisory blocks nothing" does not carve this out; see the report's
 *   spec-gaps.
 *
 * Symlink traversal follows the mode split explicitly per ADR 0032 (enforce
 * blocks, advisory reports).
 */

/** File-writing tools the steward may not use directly. */
export type GovernedWriteTool = "write" | "edit";
/** Discovery tools scoped to the steward's read surface. */
export type GovernedReadTool = "read" | "grep" | "find" | "ls";
export type GovernedTool = GovernedWriteTool | GovernedReadTool;

/**
 * The outcome for one governed call. `allow` passes through untouched; `block`
 * returns `{ block: true, reason }` to pi; `flag` proceeds but records an
 * advisory policy violation and surfaces the reason to the model and human.
 */
export interface GovernanceDecision {
  verdict: "allow" | "block" | "flag";
  /** Model- and human-visible explanation. Empty only when `allow`. */
  reason: string;
  /** The owning domain agent for an owned write; null otherwise. */
  owner: string | null;
}

/** The impure caller's reduction of a discovery target to a scope-checkable form. */
export interface DiscoveryTarget {
  /**
   * The real (symlink-resolved) repository-relative path, or null when the
   * resolved target escapes the repository root (outside the read surface).
   * The empty string denotes the repository root itself (e.g. `ls` with no path).
   */
  path: string | null;
  /** True when resolving the target traversed a symbolic link (ADR 0032). */
  symlink: boolean;
}

const enforceBlocks = (mode: OperatingMode): "block" | "flag" =>
  mode === "enforce" ? "block" : "flag";

/**
 * Decide a parent `write`/`edit` call. The steward has no implicit write
 * authority: an owned target must be delegated (naming the owner and directing
 * `orca_delegate`), an unowned target fails closed in enforce and is an advisory
 * policy violation otherwise (ADR 0012), and a target outside the repository
 * crosses the stewardship boundary (ADR 0015). Every parent write is therefore
 * governed — in enforce mode the steward can hand-edit nothing.
 *
 * `path` is the normalized repository-relative target, or null when it escaped
 * the repository root.
 */
export function classifyWrite(
  document: OrcaSpecDocument,
  mode: OperatingMode,
  path: string | null,
): GovernanceDecision {
  if (path === null) {
    return {
      verdict: enforceBlocks(mode),
      owner: null,
      reason:
        "This write targets a path outside the repository — the stewardship boundary. " +
        "Orca cannot establish authorization across it, so the write is blocked in enforce mode " +
        "and recorded as an advisory policy violation otherwise (ADR 0015, 0080).",
    };
  }

  const target = resolve(document, [path]).perTarget[0];
  if (target && !target.unowned && target.owner) {
    return {
      verdict: enforceBlocks(mode),
      owner: target.owner,
      reason:
        `\`${path}\` is owned by the '${target.owner}' domain agent. The steward holds no implicit ` +
        `write authority and must not hand-edit owned scopes — delegate this work with orca_delegate ` +
        `(task + target paths) so '${target.owner}' performs the write under its own grant. ` +
        "Blocked in enforce mode, flagged in advisory mode (ADR 0080).",
    };
  }

  return {
    verdict: enforceBlocks(mode),
    owner: null,
    reason:
      `\`${path}\` is not owned by any domain agent. Unowned writes fail closed in enforce mode; ` +
      "in advisory mode the write proceeds under your existing authority and is recorded as an " +
      "advisory policy violation (ADR 0012). Add an ownership scope to .orca/orca.yaml to route it.",
  };
}

/**
 * Decide a parent discovery call (`read`/`grep`/`find`/`ls`). The steward's
 * effective read surface is `steward.discovery.read.allow` minus its own denies
 * minus protected read denies (ADR 0022, 0068). Precedence, strongest first:
 *
 * 1. a protected-denied target is blocked in **both** modes (non-overridable);
 * 2. a symlink-traversing read is blocked in enforce, flagged in advisory (ADR 0032);
 * 3. an out-of-scope target is blocked in enforce, flagged in advisory (ADR 0022, 0080);
 * 4. otherwise the read is allowed.
 */
export function classifyDiscovery(
  document: OrcaSpecDocument,
  mode: OperatingMode,
  target: DiscoveryTarget,
): GovernanceDecision {
  const discovery = document.steward.discovery.read;
  const allow = discovery.allow ?? [];
  const ownDeny = discovery.deny ?? [];
  const protectedRead = document.protected_denies?.read ?? [];
  const { path, symlink } = target;

  if (path !== null && matchesAny(path, protectedRead)) {
    return {
      verdict: "block",
      owner: null,
      reason:
        `\`${path}\` is under a protected deny (read). Protected denies are non-overridable and ` +
        "keep sensitive assets out of all discovery, in advisory as well as enforce mode " +
        "(ADR 0015, 0068).",
    };
  }

  if (symlink) {
    const where = path !== null ? ` (resolved target \`${path}\`)` : "";
    return {
      verdict: enforceBlocks(mode),
      owner: null,
      reason:
        `This read traverses a symbolic link${where}. Symlink access is unsupported in the MVP: ` +
        "blocked in enforce mode, reported as a policy violation in advisory mode (ADR 0032).",
    };
  }

  const inScope = path !== null && matchesAny(path, allow) && !matchesAny(path, ownDeny);
  if (inScope) {
    return { verdict: "allow", reason: "", owner: null };
  }

  const where = path === null ? "outside the repository" : `\`${path}\``;
  return {
    verdict: enforceBlocks(mode),
    owner: null,
    reason:
      `${where} is outside the steward's discovery read scope ` +
      "(steward.discovery.read minus denies and protected denies). Out-of-scope reads are blocked " +
      "in enforce mode and recorded as advisory policy violations in advisory mode (ADR 0022, 0080).",
  };
}
