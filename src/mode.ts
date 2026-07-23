import type { OperatingMode } from "orcaspec";

/**
 * Operating-mode ordering and the effective-mode rule (ADR 0063).
 *
 * The MVP modes are `advisory` and `enforce`, ordered `advisory < enforce`. The
 * effective mode is always the stricter of the repository's `minimum_mode` and
 * the user-requested mode; a repository can therefore require enforcement, and
 * a user can voluntarily elevate an advisory-minimum repository, but ordinary
 * session configuration can never downgrade an `enforce` minimum.
 */
export type { OperatingMode };

/** Rank of each mode; higher is stricter. */
const RANK: Record<OperatingMode, number> = { advisory: 0, enforce: 1 };

/**
 * The default mode used both for an absent `repository.minimum_mode` and for the
 * user-requested mode before the user chooses one (ADR 0063: pre-1.0, an omitted
 * `minimum_mode` defaults to advisory).
 */
export const DEFAULT_MODE: OperatingMode = "advisory";

/** Type guard for a well-formed operating mode string. */
export function isOperatingMode(value: unknown): value is OperatingMode {
  return value === "advisory" || value === "enforce";
}

/**
 * Return the stricter of two modes. This is the sole effective-mode rule: the
 * effective operating mode is `stricterMode(repository.minimum_mode, requested)`.
 */
export function stricterMode(a: OperatingMode, b: OperatingMode): OperatingMode {
  return RANK[a] >= RANK[b] ? a : b;
}
