import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { loadSchema } from "orcaspec";
import type { Diagnostic } from "./diagnostics";

/**
 * Structural validation of a parsed OrcaSpec document against the OrcaSpec 0.1
 * JSON Schema (draft 2020-12) via Ajv (ADR 0045). Every schema failure is mapped
 * to a {@link Diagnostic} whose `reason` aligns with the stable
 * `structural.*` codes OrcaSpec uses in its invalid-fixture annotations, and
 * whose `pointer` is the Ajv `instancePath` (a JSON Pointer). Cross-field
 * semantic rules are validated separately, only after this phase passes.
 */

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    // `allErrors` so a single blocked spec reports every structural problem at
    // once; `strict: false` because the OrcaSpec schema carries descriptive
    // annotations alongside `$ref`s that Ajv's strict mode would warn about.
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    compiled = ajv.compile(loadSchema());
  }
  return compiled;
}

/** Validate structure; empty array means the document is structurally valid. */
export function validateStructural(document: unknown): Diagnostic[] {
  const validate = validator();
  if (validate(document)) return [];
  return (validate.errors ?? []).map(toDiagnostic);
}

/** Map an Ajv keyword failure to a stable OrcaSpec-aligned structural reason. */
function reasonFor(error: ErrorObject): string {
  switch (error.keyword) {
    case "required":
      return "structural.missing_required";
    case "additionalProperties":
      return "structural.unknown_field";
    case "enum":
      return "structural.invalid_enum";
    case "pattern": {
      // The schema reuses one `pattern` keyword across several node kinds;
      // disambiguate by location so the reason matches the offending field.
      if (error.instancePath === "/spec_version") {
        return "structural.invalid_spec_version_format";
      }
      if (/\/specialties\/\d+\/id$/.test(error.instancePath)) {
        return "structural.invalid_specialty_id";
      }
      return "structural.invalid_path_scope";
    }
    default:
      // OrcaSpec's stable structural set does not name every JSON Schema
      // keyword (e.g. `type`, `minItems`); report a clearly generic code.
      return "structural.schema_violation";
  }
}

function toDiagnostic(error: ErrorObject): Diagnostic {
  const reason = reasonFor(error);
  const pointer = error.instancePath;
  let path = pointerToPath(pointer);
  let message: string;

  switch (error.keyword) {
    case "required": {
      const missing = (error.params as { missingProperty: string }).missingProperty;
      path = path ? `${path}.${missing}` : missing;
      message = `Required field \`${missing}\` is missing at ${describeLoc(pointer)}.`;
      break;
    }
    case "additionalProperties": {
      const extra = (error.params as { additionalProperty: string }).additionalProperty;
      path = path ? `${path}.${extra}` : extra;
      message = `Unknown field \`${extra}\` at ${describeLoc(pointer)}; OrcaSpec 0.1 rejects fields outside its schema (ADR 0066, 0067).`;
      break;
    }
    case "enum": {
      const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      message = `Value at ${describeLoc(pointer)} must be one of: ${allowed.map(String).join(", ")}.`;
      break;
    }
    case "pattern":
      message = patternMessage(reason, pointer);
      break;
    default:
      message = `Schema violation (${error.keyword}) at ${describeLoc(pointer)}${error.message ? `: ${error.message}` : ""}.`;
  }

  return { phase: "structural", reason, message, pointer, path: path || undefined };
}

function patternMessage(reason: string, pointer: string): string {
  switch (reason) {
    case "structural.invalid_spec_version_format":
      return `spec_version at ${describeLoc(pointer)} must be a strict major.minor string such as "0.1" (ADR 0046).`;
    case "structural.invalid_specialty_id":
      return `Specialty identifier at ${describeLoc(pointer)} must be an exact namespaced string such as domain:billing (ADR 0020).`;
    default:
      return `Path scope at ${describeLoc(pointer)} must use the constrained MVP grammar: an exact path, a recursive \`/**\` prefix, or \`**\` (ADR 0011, 0031).`;
  }
}

function describeLoc(pointer: string): string {
  return pointer === "" ? "the document root" : pointer;
}

/** Convert a JSON Pointer (`/agents/0/id`) to a readable path (`agents[0].id`). */
function pointerToPath(pointer: string): string {
  if (pointer === "") return "";
  let out = "";
  for (const token of pointer.split("/").slice(1)) {
    const segment = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (/^\d+$/.test(segment)) out += `[${segment}]`;
    else out += out ? `.${segment}` : segment;
  }
  return out;
}
