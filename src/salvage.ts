import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Pair,
  type YAMLMap,
} from "yaml";
import type { Diagnostic } from "./diagnostics";

/**
 * Best-effort salvage of `protected_denies.read` from an UNUSABLE OrcaSpec
 * document (ADR 0028 states, ADR 0015/0068 protections).
 *
 * While the repository state is `invalid_spec` or `unsupported_spec_version`
 * there is no validated document, so governance fails closed on writes and
 * leaves discovery open for diagnosis. Protected read denies are the one thing
 * that must survive that gap: they exist to keep sensitive assets out of *all*
 * discovery, and a broken spec is exactly when a session is reading around
 * freely. So orca reads the unusable document once more, tolerantly, and
 * enforces whatever protected read denies it can still make out.
 *
 * ## The salvage boundary
 *
 * ONLY `protected_denies` is ever honored from an invalid document — never
 * grants, ownership, modes, or validators. Salvage is therefore a pure
 * NARROWING: it can only add read refusals to the broken-spec regime, never
 * widen authority. Nothing here returns anything a caller could authorize a
 * write with.
 *
 * ## What "best-effort" means concretely
 *
 * Tolerant, structural, and per-entry:
 *
 * - The document is re-read with the plain `yaml` parser, NOT the restricted
 *   profile in `yaml.ts`. Restricted-YAML violations (aliases, anchors, tags,
 *   merge keys, duplicate keys, multiple documents) reject the whole document
 *   there; here they are ignored, because a document that is *illegal* is still
 *   often *readable*, and a deny we can read is a deny we can enforce. Parser
 *   errors elsewhere in the file are likewise ignored — only the protections
 *   node is consulted.
 * - Every `protected_denies.read` entry found anywhere at the top level of the
 *   file is UNIONED. Duplicate keys and multiple `---` documents are both
 *   ambiguous by construction; since salvage only ever adds refusals, honoring
 *   every occurrence is the fail-closed reading of an ambiguous document.
 * - Entries are salvaged individually. A non-string (or blank) entry is dropped
 *   on its own with a diagnostic naming the count; it does not poison the
 *   sibling entries that are perfectly readable.
 * - The protections section itself being the wrong shape is NOT recoverable:
 *   `protected_denies: 3` or `read: "secrets/**"` (a scalar where a list
 *   belongs) is a lapse, not something to coerce. Coercion would invent a
 *   protection the document never declared.
 *
 * Salvaged patterns are matched by `paths.matchesAny` — the exact matching the
 * healthy path uses in `classifyDiscovery` — so a pattern means the same thing
 * whether the spec is broken or healthy. They are deliberately NOT validated
 * against the path-scope grammar: an ungrammatical pattern simply matches only
 * itself, which narrows nothing and refuses nothing extra.
 *
 * ## Lapse is stated, never silent
 *
 * When nothing can be salvaged the read protections have LAPSED: discovery stays
 * open (the broken-spec regime is unchanged) and {@link ProtectionSalvage}
 * carries a diagnostic saying so. Every surface that describes a broken spec —
 * `/orca` status, the steward note, the block reason — renders the same record
 * through {@link describeProtectionSalvage}, so status and enforcement cannot
 * disagree about which regime is in effect.
 */

/**
 * What could be recovered from an unusable document, and what to say about it.
 *
 * `read` is non-empty only when `kind` is `enforcing`; `none_declared` and
 * `lapsed` both leave discovery open and differ only in what the user is told —
 * a document that declares no protections has not lost any.
 */
export interface ProtectionSalvage {
  /**
   * `enforcing` — at least one protected read deny was recovered and is being
   * enforced; `none_declared` — the document declares none to enforce;
   * `lapsed` — protections could not be salvaged and read refusals are absent.
   */
  kind: "enforcing" | "none_declared" | "lapsed";
  /** The salvaged protected read scopes, in document order. */
  read: readonly string[];
  /** Salvage-phase notes: a lapse, and any dropped entries. */
  diagnostics: Diagnostic[];
}

/** How many salvaged scopes a one-line description names before summarizing. */
const MAX_NAMED_SCOPES = 5;

function salvageDiag(reason: string, message: string, pointer: string): Diagnostic {
  return { phase: "salvage", reason, message, pointer };
}

const READS_STAY_OPEN =
  "Discovery reads stay open for diagnosis, so protected paths are readable until the document " +
  "is fixed.";

function lapsed(why: string): ProtectionSalvage {
  return {
    kind: "lapsed",
    read: [],
    diagnostics: [
      salvageDiag(
        "salvage.protections_lapsed",
        `Read protections could not be salvaged from the unusable document: ${why}. ${READS_STAY_OPEN}`,
        "/protected_denies",
      ),
    ],
  };
}

/** All pairs in `map` whose key is exactly `name` — plural, because duplicate keys survive here. */
function pairsNamed(map: YAMLMap, name: string): Pair[] {
  return map.items.filter((pair) => isScalar(pair.key) && pair.key.value === name);
}

/**
 * An explicitly empty value (`protected_denies:` with nothing after it) declares
 * nothing rather than being malformed — the same reading the healthy path gives
 * an absent section with `?? []`.
 */
function isEmptyValue(node: unknown): boolean {
  return node === null || node === undefined || (isScalar(node) && node.value == null);
}

/**
 * Follow ONE level of alias, so protections written as `protected_denies: *base`
 * are still readable. Aliases are illegal in the restricted profile, but resolving
 * one can only add refusals. One level, never recursive: a self-referential anchor
 * therefore cannot loop.
 */
function deref(node: unknown, document: Document): unknown {
  return isAlias(node) ? node.resolve(document) : node;
}

export function salvageProtectedDenies(source: string): ProtectionSalvage {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    // Tolerant on purpose: `merge: false` keeps `<<` an ordinary key rather than
    // expanding it, and duplicate keys are kept as separate pairs (unioned below)
    // instead of being collapsed by the parser.
    documents = parseAllDocuments(source, { version: "1.2", merge: false, uniqueKeys: false });
  } catch {
    return lapsed("it could not be parsed as YAML at all");
  }

  const read: string[] = [];
  let mappingRoot = false;
  let malformed: string | undefined;
  let dropped = 0;
  let parseErrors = 0;

  for (const document of documents) {
    parseErrors += document.errors.length;
    const root = document.contents;
    if (!isMap(root)) continue;
    mappingRoot = true;

    for (const protections of pairsNamed(root, "protected_denies")) {
      const node = deref(protections.value, document);
      if (isEmptyValue(node)) continue;
      if (!isMap(node)) {
        malformed ??= "`protected_denies` is not a mapping";
        continue;
      }
      // Protections pulled in by a merge key are not readable structurally; say so
      // rather than reporting a document that declares them as declaring none.
      if (pairsNamed(node, "read").length === 0 && pairsNamed(node, "<<").length > 0) {
        malformed ??= "`protected_denies` declares its entries through a YAML merge key (`<<`)";
      }

      for (const readPair of pairsNamed(node, "read")) {
        const list = deref(readPair.value, document);
        if (isEmptyValue(list)) continue;
        if (!isSeq(list)) {
          malformed ??= "`protected_denies.read` is not a list of path scopes";
          continue;
        }
        for (const item of list.items) {
          const entry = deref(item, document);
          if (isScalar(entry) && typeof entry.value === "string" && entry.value.trim() !== "") {
            read.push(entry.value);
          } else {
            dropped += 1;
          }
        }
      }
    }
  }

  if (!mappingRoot) {
    return lapsed("no document in the file has a mapping at its root");
  }
  if (read.length === 0) {
    if (malformed !== undefined) return lapsed(malformed);
    if (dropped > 0) {
      return lapsed(
        `no entry under \`protected_denies.read\` could be read as a path scope ` +
          `(${dropped} unreadable ${dropped === 1 ? "entry" : "entries"})`,
      );
    }
    if (parseErrors > 0) {
      // Nothing was salvaged out of a document the parser could not read cleanly.
      // "The document declares no protections" would be a false reassurance here:
      // the protections may be exactly what the parser could not read.
      return lapsed(
        `the document has ${parseErrors} YAML ${parseErrors === 1 ? "error" : "errors"}, so ` +
          "whether it declares protections cannot be established",
      );
    }
    // The section is absent, empty, or explicitly null: nothing was lost.
    return { kind: "none_declared", read: [], diagnostics: [] };
  }

  const diagnostics: Diagnostic[] = [];
  if (dropped > 0) {
    diagnostics.push(
      salvageDiag(
        "salvage.entries_dropped",
        `${dropped} \`protected_denies.read\` ${dropped === 1 ? "entry was" : "entries were"} ` +
          "not a path scope and could not be salvaged; the remaining " +
          `${read.length} ${read.length === 1 ? "scope is" : "scopes are"} enforced. ` +
          "A path only that entry covered is readable until the document is fixed.",
        "/protected_denies/read",
      ),
    );
  }
  if (malformed !== undefined) {
    diagnostics.push(
      salvageDiag(
        "salvage.entries_dropped",
        `Part of the protections section could not be salvaged (${malformed}); the ` +
          `${read.length} readable ${read.length === 1 ? "scope is" : "scopes are"} enforced.`,
        "/protected_denies",
      ),
    );
  }
  return { kind: "enforcing", read, diagnostics };
}

/**
 * The one-line statement of which read-protection regime a broken spec is under.
 * Shared by `/orca` status, the steward note, and every broken-spec block reason
 * so all three agree by construction.
 */
export function describeProtectionSalvage(salvage: ProtectionSalvage): string {
  switch (salvage.kind) {
    case "enforcing": {
      const named = salvage.read.slice(0, MAX_NAMED_SCOPES).join(", ");
      const hidden = salvage.read.length - Math.min(salvage.read.length, MAX_NAMED_SCOPES);
      const scopes = hidden > 0 ? `${named}, … and ${hidden} more` : named;
      return (
        `Read protections: ENFORCING ${salvage.read.length} protected read ` +
        `${salvage.read.length === 1 ? "deny" : "denies"} salvaged from the unusable document ` +
        `(${scopes}). Reads of those paths are refused in advisory and enforce modes alike. ` +
        "Only protected_denies is honored from an unusable document — no grants, modes, or " +
        "validators take effect."
      );
    }
    case "none_declared":
      return (
        "Read protections: none are declared in the document, so discovery reads are unrestricted."
      );
    case "lapsed":
      return (
        "Read protections: LAPSED — protected_denies could not be salvaged from the unusable " +
        "document, so discovery reads are unrestricted. Fix the document to restore them."
      );
  }
}
