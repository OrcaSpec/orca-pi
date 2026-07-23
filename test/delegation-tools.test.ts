import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CompiledGrant } from "../src/resolver";
import { createDelegationRecord, type DelegationRecord } from "../src/checkpoint";
import {
  createGrantedEditTool,
  createGrantedReadTool,
  createGrantedWriteTool,
} from "../src/delegation-tools";

/**
 * The grant-wrapped file tools, exercised directly against a real temp-dir
 * filesystem (no model). Every path-bearing call is checked against the
 * delegation grant; a denied or unsafe path throws an explanatory error, and
 * only successful mutations land in the observed manifest (ADR 0078, 0032, 0083).
 */

// A self-contained grant: writable src (minus generated), readable src + docs
// (minus src/secret). Mirrors an edit-expanded ownership ∩ permissions shape.
const grant: CompiledGrant = {
  read: { allow: ["src/**", "docs/**"], deny: ["src/secret/**"] },
  write: { allow: ["src/**"], deny: ["src/generated/**"] },
};

function run(tool: ToolDefinition, cwd: string, params: unknown): Promise<AgentToolResult<unknown>> {
  return tool.execute("c1", params as never, undefined, undefined, { cwd } as never);
}

describe("grant-wrapped delegated-session file tools", () => {
  let dir: string;
  let record: DelegationRecord;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-deltools-"));
    record = createDelegationRecord();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // --- write ---------------------------------------------------------------

  it("writes an in-scope path and records exactly that mutation", async () => {
    const tool = createGrantedWriteTool(dir, grant, record);
    await run(tool, dir, { path: "src/app.ts", content: "export const x = 1;\n" });
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toContain("export const x = 1;");
    expect([...record.changedPaths]).toEqual(["src/app.ts"]);
  });

  it("throws and records nothing for a write outside the grant's write allow", async () => {
    const tool = createGrantedWriteTool(dir, grant, record);
    // docs/** is readable but not writable.
    await expect(run(tool, dir, { path: "docs/readme.md", content: "hi" })).rejects.toThrow(
      /grant boundary.*write authority/is,
    );
    expect(existsSync(join(dir, "docs", "readme.md"))).toBe(false);
    expect(record.changedPaths.size).toBe(0);
  });

  it("throws for a write under a deny scope inside the writable tree", async () => {
    const tool = createGrantedWriteTool(dir, grant, record);
    await expect(run(tool, dir, { path: "src/generated/schema.ts", content: "x" })).rejects.toThrow(
      /grant boundary.*deny/is,
    );
    expect(record.changedPaths.size).toBe(0);
  });

  it("records only the successful mutation when one write is allowed and another blocked", async () => {
    const tool = createGrantedWriteTool(dir, grant, record);
    await run(tool, dir, { path: "src/ok.ts", content: "a" });
    await expect(run(tool, dir, { path: "src/generated/no.ts", content: "b" })).rejects.toThrow();
    expect([...record.changedPaths]).toEqual(["src/ok.ts"]);
  });

  // --- edit ----------------------------------------------------------------

  it("edits an in-scope existing file and records the mutation", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "e.ts"), "alpha\n");
    const tool = createGrantedEditTool(dir, grant, record);
    await run(tool, dir, { path: "src/e.ts", edits: [{ oldText: "alpha", newText: "beta" }] });
    expect(readFileSync(join(dir, "src", "e.ts"), "utf8")).toContain("beta");
    expect([...record.changedPaths]).toEqual(["src/e.ts"]);
  });

  it("throws for an edit outside the grant and records nothing", async () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "r.md"), "alpha\n");
    const tool = createGrantedEditTool(dir, grant, record);
    await expect(
      run(tool, dir, { path: "docs/r.md", edits: [{ oldText: "alpha", newText: "beta" }] }),
    ).rejects.toThrow(/grant boundary/i);
    expect(readFileSync(join(dir, "docs", "r.md"), "utf8")).toContain("alpha");
    expect(record.changedPaths.size).toBe(0);
  });

  // --- read ----------------------------------------------------------------

  it("reads an in-scope file", async () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "r.md"), "hello docs\n");
    const tool = createGrantedReadTool(dir, grant);
    const result = await run(tool, dir, { path: "docs/r.md" });
    const body = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(body).toContain("hello docs");
  });

  it("throws for a read outside the grant's read allow", async () => {
    mkdirSync(join(dir, "outside"), { recursive: true });
    writeFileSync(join(dir, "outside", "s.txt"), "secret");
    const tool = createGrantedReadTool(dir, grant);
    await expect(run(tool, dir, { path: "outside/s.txt" })).rejects.toThrow(/grant boundary.*read/is);
  });

  it("throws for a read under a protected/agent read deny", async () => {
    mkdirSync(join(dir, "src", "secret"), { recursive: true });
    writeFileSync(join(dir, "src", "secret", "key.txt"), "shh");
    const tool = createGrantedReadTool(dir, grant);
    await expect(run(tool, dir, { path: "src/secret/key.txt" })).rejects.toThrow(/grant boundary.*deny/is);
  });

  // --- symlinks (ADR 0032) -------------------------------------------------

  it("blocks writing through a symlink leaf (creating/replacing a symlink)", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "real.ts"), "x\n");
    symlinkSync(join(dir, "src", "real.ts"), join(dir, "src", "link.ts"));
    const tool = createGrantedWriteTool(dir, grant, record);
    await expect(run(tool, dir, { path: "src/link.ts", content: "y" })).rejects.toThrow(
      /symbolic link|symlink/i,
    );
    expect(record.changedPaths.size).toBe(0);
  });

  it("blocks reading a symlink whose real target escapes the repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "orca-pi-outside-"));
    try {
      writeFileSync(join(outside, "leak.txt"), "external secret");
      mkdirSync(join(dir, "src"), { recursive: true });
      symlinkSync(join(outside, "leak.txt"), join(dir, "src", "escape.ts"));
      const tool = createGrantedReadTool(dir, grant);
      await expect(run(tool, dir, { path: "src/escape.ts" })).rejects.toThrow(
        /outside the repository|symlink/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks writing through a parent symlink that escapes the repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "orca-pi-outside-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      // src/ext -> external dir; a write to src/ext/x.ts would land outside the repo.
      symlinkSync(outside, join(dir, "src", "ext"));
      const tool = createGrantedWriteTool(dir, grant, record);
      await expect(run(tool, dir, { path: "src/ext/x.ts", content: "z" })).rejects.toThrow(
        /outside the repository|symlink/i,
      );
      expect(existsSync(join(outside, "x.ts"))).toBe(false);
      expect(record.changedPaths.size).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
