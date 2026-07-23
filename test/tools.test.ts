import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import { detectRepositoryState, ORCA_DIR, ORCA_SPEC_FILE } from "../src/state";
import { createExplainTool, createResolveTool, type ResolveToolDetails, type ToolDeps } from "../src/tools";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Minimal execute context: the tools read only `ctx.cwd`. */
function ctxFor(cwd: string): never {
  return { cwd } as never;
}

function run(
  tool: ReturnType<typeof createResolveTool>,
  cwd: string,
  paths: string[],
): Promise<AgentToolResult<ResolveToolDetails>> {
  return tool.execute("call-1", { paths }, undefined, undefined, ctxFor(cwd));
}

const textOf = (result: AgentToolResult<ResolveToolDetails>): string =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

describe("orca_resolve / orca_explain tools", () => {
  let dir: string;
  let deps: ToolDeps;
  let onRoute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-tools-"));
    onRoute = vi.fn();
    deps = { getState: (cwd) => detectRepositoryState(cwd, "advisory"), onRoute };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSpec(fixture: string): void {
    mkdirSync(join(dir, ORCA_DIR), { recursive: true });
    writeFileSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), orcaspec.loadFixtureSource(fixture));
  }

  it("registers the two tool names and non-empty schemas", () => {
    expect(createResolveTool(deps).name).toBe("orca_resolve");
    expect(createExplainTool(deps).name).toBe("orca_explain");
  });

  it("orca_resolve previews owners, writability, grants, and records the decision", async () => {
    writeSpec("multi-owner");
    const result = await run(createResolveTool(deps), dir, [
      "apps/web/app.tsx",
      "apps/web/components/button.tsx",
    ]);
    const body = textOf(result);
    expect(body).toContain("routing preview");
    expect(body).toContain("apps/web/app.tsx: owner=web, writable=yes");
    expect(body).toContain("apps/web/components/button.tsx: owner=design-system, writable=yes");
    // Compiled grant surfaced in the preview.
    expect(body).toContain("write.allow: apps/web/**");
    expect(result.details.kind).toBe("resolution");
    expect(onRoute).toHaveBeenCalledTimes(1);
  });

  it("orca_resolve reports an unowned target distinctly", async () => {
    writeSpec("multi-owner");
    const body = textOf(await run(createResolveTool(deps), dir, ["scripts/deploy.rb"]));
    expect(body).toContain("scripts/deploy.rb: unowned");
    expect(body).toContain("Unowned targets (1)");
  });

  it("orca_explain renders the same decision with reasoning and does not record", async () => {
    writeSpec("multi-owner");
    const explain = createExplainTool(deps);
    const body = textOf(await run(explain, dir, ["apps/web/components/button.tsx"]));
    expect(body).toContain("routing explanation");
    expect(body).toContain("most specific match");
    // The nested owner explanation names the more-general match that lost.
    expect(body).toContain("web");
    expect(onRoute).not.toHaveBeenCalled();
  });

  it("explain and resolve compute the identical resolution object (provably consistent)", async () => {
    writeSpec("multi-owner");
    const paths = ["services/billing/generated/schema.rb", "apps/web/app.tsx", "scripts/x.rb"];
    const resolveResult = await run(createResolveTool(deps), dir, paths);
    const explainResult = await run(createExplainTool(deps), dir, paths);
    expect(resolveResult.details.kind).toBe("resolution");
    expect(explainResult.details.kind).toBe("resolution");
    if (resolveResult.details.kind === "resolution" && explainResult.details.kind === "resolution") {
      expect(explainResult.details.resolution).toEqual(resolveResult.details.resolution);
    }
  });

  it("explains a protected-deny non-writable target for the human", async () => {
    writeSpec("multi-owner");
    const body = textOf(await run(createExplainTool(deps), dir, ["infra/production/deploy.sh"]));
    expect(body).toContain("Writable: no");
    expect(body).toContain("protected deny");
  });

  it("rejects path escapes with actionable text and no resolution", async () => {
    writeSpec("multi-owner");
    const result = await run(createResolveTool(deps), dir, ["../../etc/passwd"]);
    expect(textOf(result)).toContain("escapes the repository root");
    expect(result.details.kind).toBe("invalid");
    expect(onRoute).not.toHaveBeenCalled();
  });

  it("explains the current state instead of throwing when unmanaged", async () => {
    const result = await run(createResolveTool(deps), dir, ["apps/web/app.tsx"]);
    expect(textOf(result)).toContain("not under active governance");
    expect(textOf(result)).toContain("unmanaged");
    expect(result.details.kind).toBe("inactive");
  });

  it("explains a blocked invalid_spec state without routing", async () => {
    writeSpec("duplicate-agent-id");
    const result = await run(createResolveTool(deps), dir, ["apps/web/app.tsx"]);
    expect(result.details.kind).toBe("inactive");
    if (result.details.kind === "inactive") expect(result.details.state).toBe("invalid_spec");
    expect(textOf(result)).toContain("invalid_spec");
  });

  it("behaves identically in enforce mode (preview has no mode-dependent blocking)", async () => {
    writeSpec("multi-owner");
    const advisory = detectRepositoryState(dir, "advisory");
    const enforce = detectRepositoryState(dir, "enforce");
    expect(advisory.kind).toBe("active");
    expect(enforce.kind).toBe("active");
    const advisoryTool = createResolveTool({ getState: () => advisory });
    const enforceTool = createResolveTool({ getState: () => enforce });
    const a = textOf(await run(advisoryTool, dir, ["apps/web/app.tsx"]));
    const e = textOf(await run(enforceTool, dir, ["apps/web/app.tsx"]));
    expect(e).toBe(a);
  });

  it("prompts for a target when called with no paths", async () => {
    writeSpec("multi-owner");
    const result = await run(createResolveTool(deps), dir, []);
    expect(textOf(result)).toContain("at least one");
    expect(result.details.kind).toBe("empty");
  });
});
