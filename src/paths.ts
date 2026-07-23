import { posix } from "node:path";

/**
 * Path-scope grammar and matching for the constrained MVP (ADR 0011, 0031).
 *
 * The resolver and grant compiler operate purely on repository-relative POSIX
 * paths and the three scope forms OrcaSpec 0.1 permits — `**`, a recursive
 * prefix `D/**`, and an exact path. This module is the single source of the
 * matching and specificity rules; it performs no I/O so it can be exercised in
 * isolation and reused by both the resolver and the tool layer.
 */

/**
 * Whether repository-relative path `path` falls under scope `scope`, per the
 * normative rule in `vectors/README.md`:
 *
 * - `**` — always matches.
 * - `D/**` — matches when `path === D` or `path` starts with `D + "/"`.
 * - exact `S` — matches when `path === S`.
 *
 * No other glob syntax exists in the MVP.
 */
export function matchScope(path: string, scope: string): boolean {
  if (scope === "**") return true;
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3);
    return path === prefix || path.startsWith(prefix + "/");
  }
  return path === scope;
}

/** Whether `path` matches any scope in `scopes`. */
export function matchesAny(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => matchScope(path, scope));
}

/**
 * A total specificity order over matching scopes, used to pick the most-specific
 * owner. Higher is more specific. Depth (concrete path-segment count) dominates;
 * at equal depth an exact path outranks a recursive prefix. Because the spec
 * grammar forbids equal or partially overlapping ownership scopes (rejected in
 * semantic validation), any two scopes that match the same path are strictly
 * nested and therefore receive distinct ranks — the winner is always unique.
 */
export function specificityRank(scope: string): number {
  if (scope === "**") return 0;
  if (scope.endsWith("/**")) return segmentCount(scope.slice(0, -3)) * 2;
  return segmentCount(scope) * 2 + 1;
}

function segmentCount(path: string): number {
  return path.split("/").filter((segment) => segment.length > 0).length;
}

/** Outcome of normalizing one raw tool-supplied target path. */
export type NormalizedTarget =
  | { ok: true; path: string }
  | { ok: false; input: string; reason: string };

/**
 * Normalize a raw target path (as a tool caller supplies it) to a clean
 * repository-relative POSIX path, or reject it. Absolute paths inside the
 * repository are accepted and rewritten to relative; anything that escapes the
 * repository root (`..`, an absolute path outside it) or the root itself is
 * rejected. Pure string/path math against `repoRoot`; touches no filesystem.
 */
export function normalizeTarget(input: string, repoRoot: string): NormalizedTarget {
  if (input.trim() === "") {
    return { ok: false, input, reason: "empty path" };
  }
  if (input.includes("\0")) {
    return { ok: false, input, reason: "path contains a NUL byte" };
  }

  const absolute = posix.resolve(repoRoot, input);
  const relative = posix.relative(repoRoot, absolute);

  if (relative === "") {
    return { ok: false, input, reason: "resolves to the repository root, not a file target" };
  }
  if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
    return { ok: false, input, reason: "escapes the repository root" };
  }
  return { ok: true, path: relative };
}
