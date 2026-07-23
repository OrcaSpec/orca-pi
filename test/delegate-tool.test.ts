import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { detectRepositoryState, ORCA_DIR, ORCA_SPEC_FILE } from "../src/state";
import { createDelegateTool, type DelegateDeps, type ResolveToolDetails } from "../src/tools";
import type { DelegationSession, DelegationSessionConfig } from "../src/delegation";

/**
 * The executing `orca_delegate` tool: single-owner delegations run end-to-end
 * through an injected `createSession`; multi-owner and unowned targets defer to
 * Phase 7 without spawning. Offline — the session factory is a scripted fake.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;

async function callTool(config: DelegationSessionConfig, name: string, params: unknown): Promise<void> {
  const tool = config.tools.find((t) => t.name === name)!;
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

describe("orca_delegate executing tool", () => {
  let dir: string;
  let captured: DelegationSessionConfig | undefined;
  let createSession: ReturnType<typeof vi.fn>;
  let onDelegation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-deltool-"));
    mkdirSync(join(dir, ORCA_DIR), { recursive: true });
    writeFileSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), orcaspec.loadFixtureSource("multi-owner"));
    captured = undefined;
    onDelegation = vi.fn();
    createSession = vi.fn(async (config: DelegationSessionConfig): Promise<DelegationSession> => {
      captured = config;
      return {
        prompt: async () => {
          await callTool(config, "write", { path: "apps/web/app.tsx", content: "<button/>" });
          await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
        },
        abort: vi.fn(),
      };
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(): DelegateDeps {
    return {
      getState: (cwd) => detectRepositoryState(cwd, "enforce"),
      getThinkingLevel: () => "medium",
      createSession,
      onDelegation,
    };
  }

  function run(paths: string[], task = "do the work"): Promise<AgentToolResult<ResolveToolDetails>> {
    const tool = createDelegateTool(deps());
    return tool.execute("d1", { task, paths }, undefined, undefined, {
      cwd: dir,
      model: fakeModel,
    } as never);
  }

  it("runs a single-owner delegation end-to-end and reports the observed manifest", async () => {
    const result = await run(["apps/web/app.tsx"]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "apps", "web", "app.tsx"), "utf8")).toContain("<button/>");

    expect(result.details?.kind).toBe("delegation");
    if (result.details?.kind !== "delegation") return;
    expect(result.details.outcome.owner).toBe("web");
    expect(result.details.outcome.checkpoint.status).toBe("completed");
    expect(result.details.outcome.checkpoint.changedPaths).toEqual(["apps/web/app.tsx"]);
    expect(onDelegation).toHaveBeenCalledTimes(1);
  });

  it("passes the parent model and thinking level into the session config (ADR 0076)", async () => {
    await run(["apps/web/app.tsx"]);
    expect(captured?.model).toBe(fakeModel);
    expect(captured?.thinkingLevel).toBe("medium");
  });

  it("defers a multi-owner task to Phase 7 without spawning", async () => {
    const result = await run(["apps/web/app.tsx", "services/billing/x.rb"]);
    expect(createSession).not.toHaveBeenCalled();
    expect(result.details?.kind).toBe("phase7_pending");
  });

  it("defers when an unowned target is present without spawning", async () => {
    const result = await run(["apps/web/app.tsx", "scripts/deploy.sh"]);
    expect(createSession).not.toHaveBeenCalled();
    expect(result.details?.kind).toBe("phase7_pending");
  });
});
