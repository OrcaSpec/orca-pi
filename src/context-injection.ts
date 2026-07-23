import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { SourceSet } from "orcaspec";

/**
 * Resolve a delegation's declared instruction and context sources into pinned
 * snapshots at delegation time (ADR 0017, 0018, 0054).
 *
 * Trust is preserved, not flattened: `instructions` are owner-reviewed operating
 * directives (they compose into the system prompt as trusted text); `context` is
 * untrusted reference material (it is injected as context files, clearly labeled,
 * and cannot issue commands or change policy). Each source is read once here and
 * content-digested, so a source that changes mid-run cannot alter a live
 * delegation (ADR 0018) and the snapshot is reproducible for audit.
 *
 * Missing-source policy (ADR 0017): a missing REQUIRED source blocks the
 * delegation before any session is spawned; a missing OPTIONAL source produces a
 * warning and the delegation proceeds. Symlinked sources whose real path escapes
 * the repository are treated as unavailable per ADR 0032. The oversized-bundle
 * check is applied by the config builder, which alone sees the whole bundle
 * (runner invariants + instructions + context + operator handoff) against
 * {@link CONTEXT_BUDGET_BYTES}.
 */

/**
 * Orca for pi's documented context budget in bytes. The glossary defines the
 * context budget as adapter-reported capacity (it is not spec surface), so this
 * is orca-pi's own MVP choice: 256 KiB for the entire injected bundle. An
 * over-budget bundle fails the delegation with diagnostics rather than being
 * silently truncated (PRD "Delegated sessions").
 */
export const CONTEXT_BUDGET_BYTES = 256 * 1024;

/** Whether a resolved source is trusted instructions or untrusted context. */
export type SourceTrust = "instructions" | "context";

/** One declared source layer to resolve, in root-first composition order. */
export interface SourceLayer {
  trust: SourceTrust;
  /** Provenance label for the snapshot header, e.g. "steward" or a domain-agent id. */
  origin: string;
  set?: SourceSet;
}

/** A pinned source snapshot (content + provenance digest). */
export interface ResolvedSource {
  path: string;
  trust: SourceTrust;
  origin: string;
  content: string;
  /** Short content digest (sha256, first 12 hex chars) for reproducibility. */
  digest: string;
  bytes: number;
}

/** A non-blocking source problem surfaced to the human and recorded. */
export interface InjectionWarning {
  path: string;
  reason: string;
}

/** The resolved bundle: pinned sources plus warnings and blocking diagnostics. */
export interface ResolvedSources {
  instructions: ResolvedSource[];
  context: ResolvedSource[];
  warnings: InjectionWarning[];
  /** Blocking diagnostics (missing required sources); non-empty means fail pre-spawn. */
  missingRequired: string[];
  /** Total bytes of all read source content (excludes the composed prompt). */
  sourceBytes: number;
}

function shortDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Read one declared source, or explain why it is unavailable. */
function readSource(cwd: string, path: string): { content: string } | { unavailable: string } {
  const absolute = resolvePath(cwd, path);

  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return { unavailable: "source file not found" };
  }

  // ADR 0032: a source whose real path escapes the repository is not authorized.
  try {
    const realRoot = realpathSync(cwd);
    const rel = relative(realRoot, realpathSync(absolute));
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      return { unavailable: "source resolves through a symlink outside the repository (ADR 0032)" };
    }
  } catch {
    return { unavailable: "source path could not be resolved" };
  }

  return { content: readFileSync(absolute, "utf8") };
}

function resolveSet(
  cwd: string,
  layer: SourceLayer,
  required: boolean,
  into: ResolvedSource[],
  result: ResolvedSources,
): void {
  const paths = (required ? layer.set?.required : layer.set?.optional) ?? [];
  for (const path of paths) {
    const read = readSource(cwd, path);
    if ("unavailable" in read) {
      if (required) {
        result.missingRequired.push(
          `Required ${layer.trust} source \`${path}\` (${layer.origin}) is unavailable: ${read.unavailable}. ` +
            "The delegation is blocked before spawning; add the source or fix the declaration (ADR 0017).",
        );
      } else {
        result.warnings.push({
          path,
          reason: `Optional ${layer.trust} source (${layer.origin}) is unavailable: ${read.unavailable}. Proceeding without it.`,
        });
      }
      continue;
    }
    const bytes = Buffer.byteLength(read.content, "utf8");
    into.push({
      path,
      trust: layer.trust,
      origin: layer.origin,
      content: read.content,
      digest: shortDigest(read.content),
      bytes,
    });
    result.sourceBytes += bytes;
  }
}

/**
 * Resolve every declared source across the given layers (in order), separating
 * trusted instructions from untrusted context and collecting warnings and
 * blocking diagnostics. Required sources are resolved before optional ones
 * within a layer; layer order is preserved so callers can compose root-first.
 */
export function resolveSources(cwd: string, layers: SourceLayer[]): ResolvedSources {
  const result: ResolvedSources = {
    instructions: [],
    context: [],
    warnings: [],
    missingRequired: [],
    sourceBytes: 0,
  };
  for (const layer of layers) {
    const into = layer.trust === "instructions" ? result.instructions : result.context;
    resolveSet(cwd, layer, true, into, result);
    resolveSet(cwd, layer, false, into, result);
  }
  return result;
}
