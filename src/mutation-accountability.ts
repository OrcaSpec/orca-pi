import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { CompiledGrant } from "./resolver";
import { checkGrant } from "./grant";

/** Explicit next-version identity for mutation-accountability evidence. */
export const MUTATION_ACCOUNTABILITY_SCHEMA_VERSION = "1.1" as const;

/** Sanitized evidence for an attempted mutation rejected from the accepted patch. */
export interface MutationViolation {
  schemaVersion: typeof MUTATION_ACCOUNTABILITY_SCHEMA_VERSION;
  path: string;
  owner: string;
  grantId: string;
  operation: "write";
  source: "file_tool" | "shell";
  disposition: "blocked" | "reverted";
}

interface AccountabilityRecord {
  changedPaths: Set<string>;
  mutationViolations: MutationViolation[];
}

interface FileSnapshot {
  kind: "file" | "symlink";
  content: Buffer | string;
  mode: number;
}

type RepositorySnapshot = Map<string, FileSnapshot>;

const FALLBACK_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  "coverage",
]);

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function listFallback(cwd: string, current = cwd): string[] {
  const paths: string[] = [];
  if (!existsSync(current)) return paths;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && FALLBACK_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) paths.push(...listFallback(cwd, absolute));
    else paths.push(toPosix(relative(cwd, absolute)));
  }
  return paths;
}

/**
 * List files that can enter the retained repository patch. Git supplies tracked
 * and non-ignored untracked files; a non-git fixture falls back to a recursive
 * walk while excluding repository metadata and installed dependencies.
 */
function retainedPaths(cwd: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["-C", cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map(toPosix)
      .sort();
  } catch {
    return listFallback(cwd).sort();
  }
}

function capturePath(cwd: string, path: string): FileSnapshot | undefined {
  const absolute = join(cwd, path);
  if (!existsSync(absolute)) return undefined;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", content: readlinkSync(absolute), mode: stat.mode };
  }
  if (!stat.isFile()) return undefined;
  return { kind: "file", content: readFileSync(absolute), mode: stat.mode };
}

function snapshot(cwd: string): RepositorySnapshot {
  const result: RepositorySnapshot = new Map();
  for (const path of retainedPaths(cwd)) {
    const captured = capturePath(cwd, path);
    if (captured) result.set(path, captured);
  }
  return result;
}

function equal(left: FileSnapshot | undefined, right: FileSnapshot | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.mode !== right.mode) return false;
  if (typeof left.content === "string" || typeof right.content === "string") {
    return left.content === right.content;
  }
  return left.content.equals(right.content);
}

function changedPaths(before: RepositorySnapshot, after: RepositorySnapshot): string[] {
  const candidates = new Set([...before.keys(), ...after.keys()]);
  return [...candidates].filter((path) => !equal(before.get(path), after.get(path))).sort();
}

function restore(cwd: string, path: string, before: FileSnapshot | undefined): void {
  const absolute = join(cwd, path);
  rmSync(absolute, { recursive: true, force: true });
  if (!before) return;
  mkdirSync(dirname(absolute), { recursive: true });
  if (before.kind === "symlink") {
    symlinkSync(before.content as string, absolute);
    return;
  }
  writeFileSync(absolute, before.content as Buffer);
  chmodSync(absolute, before.mode);
}

function legacyGrantId(grant: CompiledGrant): string {
  const payload = JSON.stringify({
    read: grant.read,
    write: grant.write,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/**
 * Reconciles retained filesystem mutations against one effective grant.
 *
 * Shell execution itself remains ordinary pi execution. Immediately afterward
 * (and once more at checkpoint), the repository state is diffed against the
 * previous snapshot. Authorized changes enter the observed manifest;
 * unauthorized changes are restored byte-for-byte and recorded as sanitized
 * violation evidence.
 */
export class MutationAccountability {
  private readonly cwd: string;
  private baseline: RepositorySnapshot;

  constructor(
    cwd: string,
    private readonly grant: CompiledGrant,
    private readonly record: AccountabilityRecord,
  ) {
    this.cwd = existsSync(cwd) ? realpathSync(cwd) : cwd;
    this.baseline = snapshot(this.cwd);
  }

  private evidence(
    path: string,
    source: MutationViolation["source"],
    disposition: MutationViolation["disposition"],
  ): MutationViolation {
    return {
      schemaVersion: MUTATION_ACCOUNTABILITY_SCHEMA_VERSION,
      path,
      owner: this.grant.owner ?? "legacy-unknown",
      grantId: this.grant.grantId ?? legacyGrantId(this.grant),
      operation: "write",
      source,
      disposition,
    };
  }

  /** Record a file-tool denial before the underlying mutation executes. */
  recordBlockedFileMutation(path: string): void {
    this.record.mutationViolations.push(this.evidence(path, "file_tool", "blocked"));
  }

  /** Update the baseline after an already-authorized file tool succeeds. */
  recordAuthorizedFileMutation(path: string): void {
    this.record.changedPaths.add(path);
    const current = capturePath(this.cwd, path);
    if (current) this.baseline.set(path, current);
    else this.baseline.delete(path);
  }

  /** Reconcile all retained mutations since the previous observation. */
  reconcileShellMutations(): void {
    const after = snapshot(this.cwd);
    for (const path of changedPaths(this.baseline, after)) {
      const decision = checkGrant(this.grant, "write", path);
      if (decision.allowed) {
        this.record.changedPaths.add(path);
        continue;
      }
      restore(this.cwd, path, this.baseline.get(path));
      this.record.mutationViolations.push(this.evidence(path, "shell", "reverted"));
    }
    this.baseline = snapshot(this.cwd);
  }
}
