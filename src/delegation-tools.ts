import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { type Static, type TSchema } from "typebox";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CompiledGrant } from "./resolver";
import { normalizeTarget } from "./paths";
import { checkGrant } from "./grant";
import { checkpointSchema, fromInput, type CheckpointResult, type DelegationRecord } from "./checkpoint";

/**
 * The delegated session's tool set, compiled from its grant (ADR 0078, 0079,
 * 0032, 0083).
 *
 * Every file tool is pi's own built-in implementation wrapped, not
 * reimplemented: {@link createReadToolDefinition} et al. give the exact
 * schemas, rendering, truncation, and diff behavior the model already knows, and
 * this module adds a grant check and (for mutations) a manifest record around
 * `execute`. Reimplementing file I/O would duplicate that surface and drift from
 * pi; wrapping keeps one code path and confines Orca's addition to authorization.
 *
 * The guarantees this module constructs:
 *
 * - `read` checks every path against the grant's read set; `write`/`edit` check
 *   the write set. A denied path makes `execute` THROW an explanatory error that
 *   names the boundary (`grant.ts`), so a well-meaning agent cannot act outside
 *   its authority and the model sees why (ADR 0078).
 * - Symlinks follow ADR 0032: reads resolve the real target and reject one that
 *   escapes the repository; writes reject creating/replacing a symlink or writing
 *   through a parent symlink that escapes the repository. Real-path resolution
 *   means an in-repo symlink cannot alias a read into a scope the grant forbids.
 * - Successful mutations are recorded into a per-delegation
 *   {@link DelegationRecord}; that set is the sole source of the checkpoint's
 *   observed manifest (ADR 0083). `bash` is included UNMODIFIED (ADR 0079) — no
 *   heuristic inspection — and its filesystem effects are outside the manifest.
 * - `orca_checkpoint` is the terminating structured-output tool; it exists only
 *   in delegated sessions and attaches only observed paths.
 */

/** The file-tool input shape shared by read, write, and edit (all use `path`). */
interface PathParams {
  path: string;
}

/** Resolve `cwd`'s canonical root once; fall back to the literal path if it cannot. */
function realRoot(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Canonicalize `p`, following symlinks. When the leaf does not exist yet (a
 * to-be-created file), resolve the deepest existing ancestor's real path and
 * re-append the missing tail, so a symlinked parent directory is still detected
 * even for a new file.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Leaf (or deeper) is missing; walk up to the nearest existing ancestor.
  }
  const tail: string[] = [];
  let current = p;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return p; // reached the filesystem root; nothing resolved
    tail.unshift(basename(current));
    try {
      return resolvePath(realpathSync(parent), ...tail);
    } catch {
      current = parent;
    }
  }
}

function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}

/** The repository-relative logical target, or a rejection reason for a bad path. */
function logicalTarget(cwd: string, raw: string): { rel: string } | { reason: string } {
  const norm = normalizeTarget(raw, cwd);
  if (!norm.ok) {
    return {
      reason:
        `Orca grant boundary: \`${raw}\` is not a valid repository-relative target (${norm.reason}). ` +
        "Delegated file tools act only on paths inside the repository.",
    };
  }
  return { rel: norm.path };
}

/** Guard a read: resolve the real target, reject escapes, then grant-check it (ADR 0032, 0078). */
function guardRead(cwd: string, grant: CompiledGrant, params: PathParams): void {
  const logical = logicalTarget(cwd, params.path);
  if ("reason" in logical) throw new Error(logical.reason);

  const root = realRoot(cwd);
  const real = safeRealpath(resolvePath(root, logical.rel));
  const realRel = relative(root, real);
  if (escapes(realRel)) {
    throw new Error(
      `Orca grant boundary: \`${params.path}\` resolves through a symbolic link to a target outside ` +
        "the repository root. Symlink targets that escape the repository are rejected (ADR 0032).",
    );
  }

  const decision = checkGrant(grant, "read", toPosix(realRel));
  if (!decision.allowed) throw new Error(decision.reason);
}

/**
 * Guard a write/edit: reject a symlink leaf (creating/replacing a symlink) and a
 * parent symlink whose real path escapes the repository (writing through it),
 * then grant-check the logical target (ADR 0032, 0078). Returns the logical
 * repository-relative path and its absolute form for the mutation queue and the
 * observed manifest.
 */
function guardWrite(
  cwd: string,
  grant: CompiledGrant,
  params: PathParams,
): { rel: string; abs: string } {
  const logical = logicalTarget(cwd, params.path);
  if ("reason" in logical) throw new Error(logical.reason);

  const root = realRoot(cwd);
  const abs = resolvePath(root, logical.rel);

  let leaf: ReturnType<typeof lstatSync> | undefined;
  try {
    leaf = lstatSync(abs);
  } catch {
    // No leaf yet: a new file. Symlink-leaf check does not apply.
  }
  if (leaf?.isSymbolicLink()) {
    throw new Error(
      `Orca grant boundary: \`${params.path}\` is a symbolic link. Creating, replacing, or writing ` +
        "through a symlink is blocked in the MVP (ADR 0032); write to a real path within the grant.",
    );
  }

  const realRel = relative(root, safeRealpath(abs));
  if (escapes(realRel)) {
    throw new Error(
      `Orca grant boundary: \`${params.path}\` resolves through a symlinked parent to a location ` +
        "outside the repository root. Writing through an escaping symlink is blocked (ADR 0032).",
    );
  }

  const decision = checkGrant(grant, "write", logical.rel);
  if (!decision.allowed) throw new Error(decision.reason);
  return { rel: logical.rel, abs };
}

/**
 * Wrap a built-in file tool: run `guard` (which throws on a denied or unsafe
 * path) before delegating to the base tool, then hand the base call to
 * `wrapExec` so mutations can serialize on the file and record the observed
 * path. Parameter, detail, and render types are preserved from `base`.
 */
function withGrant<S extends TSchema, D, T, G>(
  base: ToolDefinition<S, D, T>,
  guard: (params: Static<S>) => G,
  wrapExec: (guarded: G, exec: () => Promise<AgentToolResult<D>>) => Promise<AgentToolResult<D>>,
): ToolDefinition<S, D, T> {
  return {
    ...base,
    // Async so a synchronous grant/symlink denial in `guard` surfaces as a
    // rejected promise (a model-visible tool error), never an uncaught throw.
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const guarded = guard(params);
      return wrapExec(guarded, () => base.execute(toolCallId, params, signal, onUpdate, ctx));
    },
  };
}

/** The grant-checked `read` tool for a delegated session. */
export function createGrantedReadTool(cwd: string, grant: CompiledGrant): ToolDefinition {
  return withGrant(
    createReadToolDefinition(cwd),
    (params) => guardRead(cwd, grant, params as PathParams),
    (_guarded, exec) => exec(),
  ) as ToolDefinition;
}

/**
 * A mutation wrapper: run the (already grant-checked) base tool and record the
 * observed path when the call succeeds. pi's built-in write/edit tools serialize
 * their own filesystem work with {@link withFileMutationQueue} internally, so
 * this deliberately does NOT re-enter that queue on the same file — a second
 * acquisition of the same per-file lock would deadlock. Recording happens after
 * the awaited mutation settles; a thrown/errored result records nothing.
 */
function recordingMutation(record: DelegationRecord) {
  return async <D>(
    guarded: { rel: string; abs: string },
    exec: () => Promise<AgentToolResult<D>>,
  ): Promise<AgentToolResult<D>> => {
    const result = await exec();
    if ((result as { isError?: boolean }).isError !== true) record.changedPaths.add(guarded.rel);
    return result;
  };
}

/** The grant-checked `write` tool for a delegated session; records observed mutations. */
export function createGrantedWriteTool(
  cwd: string,
  grant: CompiledGrant,
  record: DelegationRecord,
): ToolDefinition {
  return withGrant(
    createWriteToolDefinition(cwd),
    (params) => guardWrite(cwd, grant, params as PathParams),
    recordingMutation(record),
  ) as ToolDefinition;
}

/** The grant-checked `edit` tool for a delegated session; records observed mutations. */
export function createGrantedEditTool(
  cwd: string,
  grant: CompiledGrant,
  record: DelegationRecord,
): ToolDefinition {
  return withGrant(
    createEditToolDefinition(cwd),
    (params) => guardWrite(cwd, grant, params as PathParams),
    recordingMutation(record),
  ) as ToolDefinition;
}

/**
 * The unmodified `bash` tool (ADR 0079). Included by default so domain agents
 * keep shells for tests, builds, and codegen. Orca applies no heuristic command
 * inspection; the delegation prompt states the write boundary so the model
 * self-polices, and the enforcement summary discloses that bash filesystem
 * effects are advisory, never counted in the observed manifest.
 */
export function createDelegationBashTool(cwd: string): ToolDefinition {
  return createBashToolDefinition(cwd) as ToolDefinition;
}

function renderCheckpointText(result: CheckpointResult): string {
  const lines = [`Delegation checkpoint: ${result.status}`, result.summary];
  if (result.scopeRequest && result.scopeRequest.length > 0) {
    lines.push(`Scope requested: ${result.scopeRequest.join(", ")}`);
  }
  lines.push(
    result.changedPaths.length > 0
      ? `Observed changed paths (${result.changedPaths.length}): ${result.changedPaths.join(", ")}`
      : "Observed changed paths: (none)",
  );
  return lines.join("\n");
}

/**
 * The terminating `orca_checkpoint` tool, registered ONLY in delegated sessions
 * (ADR 0083). Calling it ends the session (`terminate: true`). The result
 * attaches the observed manifest from `record.changedPaths` — never anything the
 * agent claims — because the schema has no changed-paths field for the model to
 * populate.
 */
export function createCheckpointTool(
  record: DelegationRecord,
): ToolDefinition<typeof checkpointSchema, CheckpointResult> {
  return defineTool({
    name: "orca_checkpoint",
    label: "Orca checkpoint",
    description:
      "End this delegated session with a structured checkpoint. Provide the terminal status and a " +
      "summary; for needs_scope include the paths you need. Do NOT list changed files — Orca records " +
      "those from your tool calls. Calling this tool terminates the session; call it once, last.",
    promptSnippet: "orca_checkpoint — end the delegation with status + summary (terminates the session).",
    promptGuidelines: [
      "Finish every delegation by calling orca_checkpoint exactly once, as your final action.",
      "Use status 'completed' only when the assigned work is done within your grant.",
      "Use 'needs_scope' with scope_request when you need paths outside your grant; never work around the boundary.",
    ],
    parameters: checkpointSchema,
    async execute(_toolCallId, params) {
      const result: CheckpointResult = {
        ...fromInput(params),
        changedPaths: [...record.changedPaths].sort(),
        synthesized: false,
      };
      record.checkpoint = result;
      return {
        content: [{ type: "text", text: renderCheckpointText(result) }],
        details: result,
        terminate: true,
      };
    },
  });
}

/**
 * The complete delegated-session tool set for one grant: grant-checked
 * `read`/`write`/`edit`, unmodified `bash`, and the terminating
 * `orca_checkpoint`. Nothing else — no `orca_delegate`, `orca_resolve`, or
 * `orca_explain` (those are the steward's), and no ungoverned built-ins.
 */
export function createDelegationTools(
  cwd: string,
  grant: CompiledGrant,
  record: DelegationRecord,
): ToolDefinition[] {
  return [
    createGrantedReadTool(cwd, grant),
    createGrantedWriteTool(cwd, grant, record),
    createGrantedEditTool(cwd, grant, record),
    createDelegationBashTool(cwd),
    createCheckpointTool(record) as ToolDefinition,
  ];
}
