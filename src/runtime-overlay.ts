import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import type { OrcaSpecDocument } from "orcaspec";
import { formatDiagnostic, type Diagnostic } from "./diagnostics";
import { ORCA_DIR } from "./state";
import { parseRestrictedYaml, type YamlSubject } from "./yaml";

/**
 * The runtime overlay: `.orca/runtime.yaml` (staged-promotion plan, Phase 4; PRD
 * item 4).
 *
 * The overlay is where a repository declares the VALIDATORS that gate a
 * delegation's promotion — the test command, the type check, the linter that must
 * pass before staged work reaches the user's files. It is deliberately a second
 * file rather than a new OrcaSpec section:
 *
 * - OrcaSpec describes AUTHORITY (who owns what, what they may read and write).
 *   Which programs this machine runs to accept a change is runtime configuration,
 *   not authority, and it is read ONLY by orca-pi. An OrcaSpec document stays
 *   portable across runtimes; nothing here is part of that contract.
 * - Because it is runtime configuration, the overlay can NARROW or CONFIGURE what
 *   a delegation must satisfy, and can never expand it. There is no field through
 *   which an overlay could grant a path, an operation, or an agent — it names
 *   programs to run and nothing else, so a compiled grant is unaffected by its
 *   presence (`resolver.ts` never reads it).
 *
 * Loading mirrors the OrcaSpec pipeline in `load.ts`, phase for phase, so a user
 * who has debugged one file already knows how the other behaves: restricted-YAML
 * parse (ADR 0025, same profile, same `yaml.*` codes) → structural validation
 * against a closed JSON Schema via Ajv (unknown fields are REJECTED, ADR 0066) →
 * schema-version support check → semantic validation against the OrcaSpec document
 * that will actually run (an overlay naming an agent the document does not declare
 * is a diagnostic, never a silently ignored key).
 *
 * A malformed overlay is BLOCKING, for the same reason a broken spec is (ADR 0028,
 * Phase 1): the alternative is a delegation that promotes work while quietly
 * skipping the checks the repository declared. Absence is different from breakage —
 * no overlay means no validators and promotion behaves exactly as it did before
 * this phase.
 *
 * Two decisions worth stating because the schema alone does not explain them:
 *
 * - `timeout_seconds` is REQUIRED. A validator with no declared time budget is
 *   exactly the ambiguity fail-closed governance must not have: it can hang a
 *   promotion forever, and no default this module invents would be the user's.
 * - `cwd` is optional, repository-relative, and must resolve inside the checkout.
 *   A validator runs in the STAGED checkout, where its own writes are inert
 *   (promotion applies committed work only). A `cwd` that escaped — `..`, or an
 *   absolute path — would run it against the user's live files instead, which is
 *   the one thing staging exists to prevent. The overlay is user-authored and
 *   trusted like `.orca/orca.yaml`, so this is a guard against a mistake pointing
 *   at the wrong tree, not a sandbox around a hostile author: a user who writes
 *   `program: /bin/rm` has always been able to run `/bin/rm` themselves.
 */

/** Overlay filename within {@link ORCA_DIR}. */
export const RUNTIME_OVERLAY_FILE = "runtime.yaml";

/** The only `schema_version` this runtime understands. */
export const RUNTIME_OVERLAY_SCHEMA_VERSION = 1;

/** Upper bound on a declared timeout, so a typo cannot wedge a promotion for a day. */
export const MAX_TIMEOUT_SECONDS = 3600;

/** How the overlay names itself in restricted-YAML diagnostics. */
const OVERLAY_SUBJECT: YamlSubject = {
  subject: "The Orca runtime overlay",
  emptyAdvice:
    "a valid `.orca/runtime.yaml` declares `schema_version: 1` and a `validations` mapping",
};

/** One declared validator program, normalized and ready to run. */
export interface ValidatorDeclaration {
  /** Executable name or path; run via `execFile`-style argv, never a shell. */
  program: string;
  /** Arguments passed as an argv array; never concatenated into a command line. */
  args: string[];
  /** Repository-relative directory inside the staged checkout; `""` is its root. */
  cwd: string;
  /** Wall-clock budget for one run; exceeding it fails the acceptance gate. */
  timeoutSeconds: number;
}

/** The validated overlay: validators per declared OrcaSpec agent id. */
export interface RuntimeOverlay {
  schemaVersion: typeof RUNTIME_OVERLAY_SCHEMA_VERSION;
  /** Declaration-ordered validators, keyed by the agent id that owns them. */
  validations: Record<string, ValidatorDeclaration[]>;
}

/**
 * The three outcomes of looking for an overlay: there is none (no validators, and
 * promotion is unchanged), there is a usable one, or there is one that cannot be
 * trusted — which blocks the delegation rather than running it unvalidated.
 */
export type RuntimeOverlayResult =
  | { kind: "absent" }
  | { kind: "loaded"; overlay: RuntimeOverlay }
  | { kind: "invalid"; diagnostics: Diagnostic[] };

/** Absolute path to the runtime overlay for a repository root. */
export function overlayPathFor(cwd: string): string {
  return join(cwd, ORCA_DIR, RUNTIME_OVERLAY_FILE);
}

// --- Structural validation (closed schema, Ajv — mirrors `schema.ts`) ---------

/**
 * The overlay's closed JSON Schema. `additionalProperties: false` at every level
 * is the point: an unknown field is a REJECTION, so a misspelled `timeout_second`
 * fails loudly instead of silently leaving a validator unbounded. Agent ids are
 * the one open key set — they are validated semantically against the document,
 * which is where a useful message about them can be produced.
 */
const overlaySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["schema_version"],
  properties: {
    schema_version: { type: "integer" },
    validations: {
      type: "object",
      additionalProperties: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["program", "timeout_seconds"],
          properties: {
            program: { type: "string", minLength: 1 },
            args: { type: "array", items: { type: "string" } },
            cwd: { type: "string" },
            timeout_seconds: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: MAX_TIMEOUT_SECONDS,
            },
          },
        },
      },
    },
  },
} as const;

/** The overlay exactly as authored, once the schema has accepted its shape. */
interface RawOverlay {
  schema_version: number;
  validations?: Record<
    string,
    Array<{ program: string; args?: string[]; cwd?: string; timeout_seconds: number }>
  >;
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    // `allErrors` so one broken overlay reports every problem at once, matching
    // how a broken spec is reported (`schema.ts`).
    compiled = new Ajv2020({ allErrors: true, strict: false }).compile(overlaySchema);
  }
  return compiled;
}

function overlayDiag(
  reason: string,
  message: string,
  pointer: string,
  detail?: Record<string, unknown>,
): Diagnostic {
  return { phase: "overlay", reason, message, pointer, path: pathOf(pointer), detail };
}

/** Convert a JSON Pointer (`/validations/web/0`) to a readable path. */
function pathOf(pointer: string): string | undefined {
  if (pointer === "") return undefined;
  let out = "";
  for (const token of pointer.split("/").slice(1)) {
    const segment = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (/^\d+$/.test(segment)) out += `[${segment}]`;
    else out += out ? `.${segment}` : segment;
  }
  return out || undefined;
}

/** Map one Ajv keyword failure onto an actionable `overlay.*` diagnostic. */
function toDiagnostic(error: ErrorObject): Diagnostic {
  const at = error.instancePath === "" ? "the overlay root" : error.instancePath;
  switch (error.keyword) {
    case "required": {
      const missing = (error.params as { missingProperty: string }).missingProperty;
      return overlayDiag(
        "overlay.missing_required",
        `Required field \`${missing}\` is missing at ${at}. ` +
          (missing === "timeout_seconds"
            ? "Every validator must declare its own time budget; Orca does not invent one."
            : "See `.orca/runtime.yaml` in the Orca documentation for the declaration shape."),
        error.instancePath,
      );
    }
    case "additionalProperties": {
      const extra = (error.params as { additionalProperty: string }).additionalProperty;
      return overlayDiag(
        "overlay.unknown_field",
        `Unknown field \`${extra}\` at ${at}; the runtime overlay rejects fields outside its ` +
          "schema, so a misspelled key can never leave a validator silently unconfigured.",
        error.instancePath,
        { field: extra },
      );
    }
    default:
      return overlayDiag(
        "overlay.invalid_type",
        `Invalid value at ${at}${error.message ? `: ${error.message}` : ""}.`,
        error.instancePath,
      );
  }
}

// --- Semantic validation (the overlay against the document that will run) -----

/**
 * Normalize a declared `cwd` to a clean repository-relative directory, or reject
 * it. Absolute paths and anything escaping the checkout are refused outright
 * (unlike `normalizeTarget`, which rewrites absolute paths inside the repository:
 * an overlay declares repository-relative paths only, so an absolute one is a
 * mistake about which tree the validator runs in, not a spelling of a valid path).
 * `""`, `.`, and `./` all mean the checkout root.
 */
function normalizeValidatorCwd(input: string): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (input.includes("\0")) return { ok: false, reason: "it contains a NUL byte" };
  if (posix.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input) || input.includes("\\")) {
    return {
      ok: false,
      reason: "it is not a repository-relative POSIX path (absolute paths are refused)",
    };
  }
  const normalized = posix.normalize(input === "" ? "." : input);
  if (normalized === "." || normalized === "./") return { ok: true, cwd: "" };
  if (normalized === ".." || normalized.startsWith("../")) {
    return { ok: false, reason: "it escapes the staged checkout" };
  }
  return { ok: true, cwd: normalized.replace(/\/+$/, "") };
}

function checkSemantics(raw: RawOverlay, document: OrcaSpecDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const declared = new Set(document.agents.map((agent) => agent.id));

  for (const [agent, validators] of Object.entries(raw.validations ?? {})) {
    if (!declared.has(agent)) {
      diagnostics.push(
        overlayDiag(
          "overlay.unknown_agent",
          `The overlay declares validators for agent \`${agent}\`, which the OrcaSpec document ` +
            `does not declare (declared: ${[...declared].sort().join(", ") || "none"}). An agent ` +
            "id that matches nothing would mean validators that silently never run, so it is a " +
            "diagnostic rather than an ignored key.",
          `/validations/${agent}`,
          { agent },
        ),
      );
    }
    validators.forEach((declaration, index) => {
      const pointer = `/validations/${agent}/${index}`;
      if (declaration.program.includes("\0")) {
        diagnostics.push(
          overlayDiag(
            "overlay.invalid_program",
            `The \`program\` at ${pointer} contains a NUL byte.`,
            `${pointer}/program`,
          ),
        );
      }
      (declaration.args ?? []).forEach((argument, position) => {
        if (argument.includes("\0")) {
          diagnostics.push(
            overlayDiag(
              "overlay.invalid_argument",
              `Argument ${position} at ${pointer} contains a NUL byte.`,
              `${pointer}/args/${position}`,
            ),
          );
        }
      });
      if (declaration.cwd !== undefined) {
        const normalized = normalizeValidatorCwd(declaration.cwd);
        if (!normalized.ok) {
          diagnostics.push(
            overlayDiag(
              "overlay.invalid_cwd",
              `The \`cwd\` \`${declaration.cwd}\` at ${pointer} is refused because ${normalized.reason}. ` +
                "A validator runs inside the staged checkout, so its `cwd` must be a repository-" +
                "relative directory within it — never a path that reaches the user's own files.",
              `${pointer}/cwd`,
              { cwd: declaration.cwd },
            ),
          );
        }
      }
    });
  }
  return diagnostics;
}

// --- The pipeline -------------------------------------------------------------

/**
 * Parse and validate overlay source against the document it will govern. Pure —
 * {@link readRuntimeOverlay} is the I/O half — so every phase is exercised
 * directly from source text.
 */
export function loadRuntimeOverlay(
  source: string,
  document: OrcaSpecDocument,
): RuntimeOverlayResult {
  const yaml = parseRestrictedYaml(source, OVERLAY_SUBJECT);
  if (!yaml.ok) return { kind: "invalid", diagnostics: yaml.diagnostics };

  const validate = validator();
  if (!validate(yaml.value)) {
    return {
      kind: "invalid",
      diagnostics: (validate.errors ?? []).map(toDiagnostic),
    };
  }
  const raw = yaml.value as RawOverlay;

  if (raw.schema_version !== RUNTIME_OVERLAY_SCHEMA_VERSION) {
    return {
      kind: "invalid",
      diagnostics: [
        overlayDiag(
          "overlay.unsupported_schema_version",
          `The overlay declares schema_version ${raw.schema_version}, but this runtime supports ` +
            `${RUNTIME_OVERLAY_SCHEMA_VERSION}. An overlay written for another version is not ` +
            "interpreted on a guess.",
          "/schema_version",
          { found: raw.schema_version, supported: RUNTIME_OVERLAY_SCHEMA_VERSION },
        ),
      ],
    };
  }

  const semantic = checkSemantics(raw, document);
  if (semantic.length > 0) return { kind: "invalid", diagnostics: semantic };

  const validations: Record<string, ValidatorDeclaration[]> = {};
  for (const [agent, declarations] of Object.entries(raw.validations ?? {})) {
    validations[agent] = declarations.map((declaration) => {
      const cwd = normalizeValidatorCwd(declaration.cwd ?? "");
      return {
        program: declaration.program,
        args: [...(declaration.args ?? [])],
        // Semantic validation already refused every non-normalizable `cwd`.
        cwd: cwd.ok ? cwd.cwd : "",
        timeoutSeconds: declaration.timeout_seconds,
      };
    });
  }
  return { kind: "loaded", overlay: { schemaVersion: RUNTIME_OVERLAY_SCHEMA_VERSION, validations } };
}

/**
 * Read and validate the overlay for a repository, if it has one.
 *
 * The overlay is read from the USER's checkout, before any child session starts,
 * and never from the staged checkout: a delegated agent that writes
 * `.orca/runtime.yaml` inside staging therefore cannot add, remove, or retarget
 * the validators that gate its own promotion.
 */
export function readRuntimeOverlay(cwd: string, document: OrcaSpecDocument): RuntimeOverlayResult {
  const path = overlayPathFor(cwd);
  if (!existsSync(path) || !statSync(path).isFile()) return { kind: "absent" };
  return loadRuntimeOverlay(readFileSync(path, "utf8"), document);
}

/**
 * The steward-facing refusal for an unusable overlay: why the delegation stopped,
 * every diagnostic in the same one-line form `/orca` uses, and what to do about
 * it. Shared by the single-owner and sequence paths so both read identically.
 */
export function overlayRefusalDiagnostics(cwd: string, diagnostics: Diagnostic[]): string[] {
  return [
    `Orca refuses to delegate: \`${overlayPathFor(cwd)}\` is present but not valid, so the ` +
      "validators this repository declares cannot be run.",
    "A delegation is blocked rather than promoted unvalidated — an overlay that cannot be read is " +
      "not the same as a repository that declared no validators. Fix the overlay (or remove it) " +
      "and delegate again; your checkout was not touched.",
    ...diagnostics.map((diagnostic) => `  - ${formatDiagnostic(diagnostic)}`),
  ];
}
