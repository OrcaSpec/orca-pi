import { parseAllDocuments, visit, isScalar } from "yaml";
import type { Diagnostic } from "./diagnostics";

/**
 * Restricted-YAML loader for `.orca/orca.yaml` (ADR 0025).
 *
 * OrcaSpec is authored in YAML 1.2 but interpreted through a JSON-compatible
 * data model. General YAML features whose meaning varies across parsers are
 * rejected here, before structural validation, so a document either produces a
 * plain JSON value or a set of actionable `yaml.*` diagnostics:
 *
 * - aliases (`*name`) and anchors (`&name`) — write values explicitly;
 * - custom / local tags (`!tag`);
 * - merge keys (`<<`);
 * - duplicate mapping keys;
 * - multiple documents in one file (`---` separators).
 *
 * A violation is never a crash: malformed or restricted YAML surfaces as an
 * `invalid_spec` diagnostic (ADR 0028).
 *
 * The restricted profile is a property of Orca's configuration format, not of
 * OrcaSpec alone, so every Orca-owned YAML file is read through this one loader —
 * `.orca/runtime.yaml` included (see `runtime-overlay.ts`). Only how the document
 * is NAMED in a diagnostic varies, which is what {@link YamlSubject} carries: a
 * user told their runtime overlay is malformed must not be sent to fix their spec.
 */

export type YamlResult =
  | { ok: true; value: unknown }
  | { ok: false; diagnostics: Diagnostic[] };

/** How one Orca-owned YAML document is described in its own diagnostics. */
export interface YamlSubject {
  /** Sentence-initial name of the document, e.g. `The OrcaSpec document`. */
  subject: string;
  /** What a valid document contains; appended to the empty-document diagnostic. */
  emptyAdvice: string;
}

const ORCA_SPEC_SUBJECT: YamlSubject = {
  subject: "The OrcaSpec document",
  emptyAdvice: "a valid `.orca/orca.yaml` declares the six required top-level sections",
};

function yamlDiag(reason: string, message: string): Diagnostic {
  // A restricted-YAML violation is a property of the whole document, not of a
  // single parsed node (some, like multiple-documents, have no single node at
  // all), so it is anchored at the document root (`""`). This matches the
  // `pointer: ""` OrcaSpec's yaml-phase fixtures carry (orcaspec >= 0.1.1).
  return { phase: "yaml", reason, message, pointer: "" };
}

/** Read `anchor`/`tag` off any node without depending on the exact node union. */
interface TaggedNode {
  anchor?: string;
  tag?: string;
}

export function parseRestrictedYaml(
  source: string,
  named: YamlSubject = ORCA_SPEC_SUBJECT,
): YamlResult {
  const diagnostics: Diagnostic[] = [];

  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(source, {
      version: "1.2",
      // Merge keys are not honored; their *use* is rejected explicitly below so
      // `<<` never silently becomes an ordinary key either.
      merge: false,
      // Duplicate keys are collected as document errors rather than merged.
      uniqueKeys: true,
    });
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        yamlDiag(
          "yaml.parse_error",
          `${named.subject} is not valid YAML: ${(err as Error).message}`,
        ),
      ],
    };
  }

  if (docs.length > 1) {
    return {
      ok: false,
      diagnostics: [
        yamlDiag(
          "yaml.multiple_documents",
          `${named.subject} must contain exactly one YAML document; multiple documents separated by \`---\` are not allowed (ADR 0025).`,
        ),
      ],
    };
  }

  const doc = docs[0];
  if (!doc || doc.contents == null) {
    return {
      ok: false,
      diagnostics: [
        yamlDiag(
          "yaml.empty",
          `${named.subject} is empty; ${named.emptyAdvice}.`,
        ),
      ],
    };
  }

  // Parser-collected errors: syntax problems and duplicate keys.
  for (const error of doc.errors) {
    if (error.code === "DUPLICATE_KEY") {
      diagnostics.push(
        yamlDiag(
          "yaml.duplicate_key",
          `Duplicate mapping key: ${error.message} Duplicate keys are not allowed in restricted YAML (ADR 0025).`,
        ),
      );
    } else {
      diagnostics.push(
        yamlDiag(
          "yaml.parse_error",
          `${named.subject} is not valid YAML: ${error.message}`,
        ),
      );
    }
  }

  // Restricted-profile violations: aliases, anchors, custom tags, merge keys.
  const flagged = { alias: false, anchor: false, tag: false, merge: false };
  visit(doc, {
    Alias() {
      if (!flagged.alias) {
        flagged.alias = true;
        diagnostics.push(
          yamlDiag(
            "yaml.alias",
            "YAML aliases (`*name`) are not allowed in restricted YAML; write the referenced value explicitly (ADR 0025).",
          ),
        );
      }
    },
    Node(_key, node) {
      const tagged = node as TaggedNode;
      if (tagged.anchor && !flagged.anchor) {
        flagged.anchor = true;
        diagnostics.push(
          yamlDiag(
            "yaml.anchor",
            "YAML anchors (`&name`) are not allowed in restricted YAML (ADR 0025).",
          ),
        );
      }
      if (typeof tagged.tag === "string" && tagged.tag.startsWith("!") && !flagged.tag) {
        flagged.tag = true;
        diagnostics.push(
          yamlDiag(
            "yaml.custom_tag",
            `Custom YAML tags (\`${tagged.tag}\`) are not allowed in restricted YAML (ADR 0025).`,
          ),
        );
      }
    },
    Pair(_index, pair) {
      const key = pair.key;
      if (isScalar(key) && key.value === "<<" && !flagged.merge) {
        flagged.merge = true;
        diagnostics.push(
          yamlDiag(
            "yaml.merge_key",
            "YAML merge keys (`<<`) are not allowed in restricted YAML (ADR 0025).",
          ),
        );
      }
    },
  });

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: doc.toJS() };
}
