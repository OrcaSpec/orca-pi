import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainAgent, OrcaSpecDocument } from "orcaspec";
import { createDelegationRecord, type DelegationRecord } from "../src/checkpoint";
import { createDelegationTools } from "../src/delegation-tools";
import { resolve } from "../src/resolver";

function run(tool: ToolDefinition, cwd: string, params: unknown): Promise<AgentToolResult<unknown>> {
  return tool.execute("c1", params as never, undefined, undefined, { cwd } as never);
}

function grantFor(targets: string[]) {
  const agent: DomainAgent = {
    id: "core",
    name: "core",
    description: "core owner",
    ownership: ["src/**"],
    permissions: { edit: { allow: ["src/**"] } },
  };
  const document: OrcaSpecDocument = {
    spec_version: "0.1",
    repository: { id: "018f4f72-0000-7000-8000-000000000099" },
    administration: { approvers: [{ provider: "orca-local", principal: "test" }] },
    steward: { discovery: { read: { allow: ["**"], deny: [] } } },
    protected_denies: {},
    agents: [agent],
  };
  return resolve(document, targets, {
    contractVersion: "1.1",
    governanceIdentity: "sha256:test-governance",
    resolutionCycleId: "cycle-1",
  }).delegations[0].grant;
}

describe("shell mutation accountability", () => {
  let dir: string;
  let record: DelegationRecord;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps an authorized shell mutation but reverts an out-of-grant mutation", async () => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-accountability-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "assigned.ts"), "before assigned\n");
    writeFileSync(join(dir, "src", "specific-owner.ts"), "before specific\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    record = createDelegationRecord();
    const tools = createDelegationTools(dir, grantFor(["src/assigned.ts"]), record);
    const bash = tools.find((tool) => tool.name === "bash")!;

    await run(bash, dir, {
      command:
        "printf 'after assigned\\n' > src/assigned.ts; printf 'stolen\\n' > src/specific-owner.ts; printf 'new\\n' > src/new-outside.ts",
    });

    expect(readFileSync(join(dir, "src", "assigned.ts"), "utf8")).toBe("after assigned\n");
    expect(readFileSync(join(dir, "src", "specific-owner.ts"), "utf8")).toBe("before specific\n");
    expect(existsSync(join(dir, "src", "new-outside.ts"))).toBe(false);
    expect([...record.changedPaths]).toEqual(["src/assigned.ts"]);
    expect(record.mutationViolations).toEqual([
      {
        schemaVersion: "1.1",
        path: "src/new-outside.ts",
        owner: "core",
        grantId: expect.stringMatching(/^sha256:/),
        operation: "write",
        source: "shell",
        disposition: "reverted",
      },
      {
        schemaVersion: "1.1",
        path: "src/specific-owner.ts",
        owner: "core",
        grantId: expect.stringMatching(/^sha256:/),
        operation: "write",
        source: "shell",
        disposition: "reverted",
      },
    ]);
    const retainedEvidence = JSON.stringify(record.mutationViolations);
    expect(retainedEvidence).not.toContain("printf");
    expect(retainedEvidence).not.toContain(dir);
  });

  it("runs a final reconciliation at checkpoint for mutations landing after a command", async () => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-accountability-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "assigned.ts"), "assigned\n");
    writeFileSync(join(dir, "src", "specific-owner.ts"), "before\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    record = createDelegationRecord();
    const tools = createDelegationTools(dir, grantFor(["src/assigned.ts"]), record);
    const checkpoint = tools.find((tool) => tool.name === "orca_checkpoint")!;
    writeFileSync(join(dir, "src", "specific-owner.ts"), "late unauthorized\n");

    const result = await run(checkpoint, dir, { status: "completed", summary: "assigned work done" });

    expect(readFileSync(join(dir, "src", "specific-owner.ts"), "utf8")).toBe("before\n");
    expect((result.details as { mutationViolations: unknown[] }).mutationViolations).toEqual([
      expect.objectContaining({
        path: "src/specific-owner.ts",
        source: "shell",
        disposition: "reverted",
      }),
    ]);
  });

  it("records the same grant identity when a file tool blocks an unauthorized mutation", async () => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-accountability-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "assigned.ts"), "assigned\n");
    writeFileSync(join(dir, "src", "specific-owner.ts"), "before\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    record = createDelegationRecord();
    const grant = grantFor(["src/assigned.ts"]);
    const write = createDelegationTools(dir, grant, record).find((tool) => tool.name === "write")!;

    await expect(
      run(write, dir, { path: "src/specific-owner.ts", content: "stolen\n" }),
    ).rejects.toThrow(/grant boundary/i);

    expect(readFileSync(join(dir, "src", "specific-owner.ts"), "utf8")).toBe("before\n");
    expect(record.mutationViolations).toEqual([
      {
        schemaVersion: "1.1",
        path: "src/specific-owner.ts",
        owner: "core",
        grantId: grant.grantId,
        operation: "write",
        source: "file_tool",
        disposition: "blocked",
      },
    ]);
  });

  it("reconciles unauthorized effects even when the shell command fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-accountability-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "assigned.ts"), "assigned\n");
    writeFileSync(join(dir, "src", "specific-owner.ts"), "before\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    record = createDelegationRecord();
    const bash = createDelegationTools(
      dir,
      grantFor(["src/assigned.ts"]),
      record,
    ).find((tool) => tool.name === "bash")!;

    await expect(
      run(bash, dir, {
        command: "printf 'unauthorized\\n' > src/specific-owner.ts; exit 7",
      }),
    ).rejects.toThrow(/code 7/i);

    expect(readFileSync(join(dir, "src", "specific-owner.ts"), "utf8")).toBe("before\n");
    expect(record.mutationViolations).toEqual([
      expect.objectContaining({
        path: "src/specific-owner.ts",
        source: "shell",
        disposition: "reverted",
      }),
    ]);
  });
});
