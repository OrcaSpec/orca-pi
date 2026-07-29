import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import { detectRepositoryState, ORCA_DIR, ORCA_SPEC_FILE } from "../src/state";
import { resolve } from "../src/resolver";
import {
  runDelegationSequence,
  type DelegationInputs,
  type DelegationProgress,
  type DelegationSession,
  type DelegationSessionConfig,
} from "../src/delegation";
import { createDelegateTool, type DelegateDeps, type ResolveToolDetails } from "../src/tools";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * Live delegation progress (PRD "User Surface"): the sequence runner emits an
 * ordered stream of progress events, and `orca_delegate` forwards each into the
 * tool's `onUpdate` for the TUI. Offline, driven by scripted sessions.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;
const doc = orcaspec.loadFixture("multi-owner");
const parent = { model: fakeModel, thinkingLevel: "medium" as const };

async function callTool(config: DelegationSessionConfig, name: string, params: unknown): Promise<void> {
  const tool = config.tools.find((t) => t.name === name)!;
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

/** A session that emits one activity note, then checkpoints completed. */
function activeSessions() {
  return async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    let listener: ((note: string) => void) | undefined;
    return {
      onActivity: (l) => {
        listener = l;
      },
      prompt: async () => {
        listener?.("editing files");
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      },
      abort: () => {},
    };
  };
}

function orderedFor(cwd: string, paths: string[]): DelegationInputs[] {
  return resolve(doc, paths).delegations.map((delegation) => ({
    document: doc,
    owner: delegation.owner,
    targets: delegation.targets,
    grant: delegation.grant,
    task: "work",
    effectiveMode: "enforce",
    cwd,
    parent,
  }));
}

describe("runDelegationSequence progress stream", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-prog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits sequence_start, per-step start/activity/end, then sequence_end (single owner)", async () => {
    const progress: DelegationProgress[] = [];
    await runDelegationSequence(orderedFor(dir, ["apps/web/app.tsx"]), {
      createSession: activeSessions(),
      onProgress: (p) => progress.push(p),
    });
    expect(progress.map((p) => p.kind)).toEqual([
      "sequence_start",
      "step_start",
      "step_activity",
      "step_end",
      "sequence_end",
    ]);
    const activity = progress.find((p) => p.kind === "step_activity");
    expect(activity && activity.kind === "step_activity" && activity.note).toBe("editing files");
  });

  it("orders multi-owner progress strictly by owner, never interleaved", async () => {
    const progress: DelegationProgress[] = [];
    await runDelegationSequence(orderedFor(dir, ["apps/web/app.tsx", "services/billing/x.rb"]), {
      createSession: activeSessions(),
      onProgress: (p) => progress.push(p),
    });
    // billing (owner id ascending) runs fully before web starts.
    const trace = progress.map((p) =>
      p.kind === "step_start" || p.kind === "step_end" ? `${p.kind}:${p.owner}:${p.index}/${p.total}` : p.kind,
    );
    expect(trace).toEqual([
      "sequence_start",
      "step_start:billing:1/2",
      "step_activity",
      "step_end:billing:1/2",
      "step_start:web:2/2",
      "step_activity",
      "step_end:web:2/2",
      "sequence_end",
    ]);
  });
});

describe("orca_delegate streams progress into onUpdate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-prog-tool-"));
    mkdirSync(join(dir, ORCA_DIR), { recursive: true });
    writeFileSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), orcaspec.loadFixtureSource("multi-owner"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards each progress event to onUpdate in order, and reports progress to onProgress", async () => {
    const updates: string[] = [];
    const progressSeen: DelegationProgress[] = [];
    const deps: DelegateDeps = {
      getState: (cwd) => detectRepositoryState(cwd, "enforce"),
      getThinkingLevel: () => "medium",
      createSession: activeSessions(),
      onProgress: (p) => progressSeen.push(p),
    };
    const onUpdate = (update: AgentToolResult<ResolveToolDetails>): void => {
      const text = update.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      updates.push(text);
    };
    await createDelegateTool(deps).execute(
      "d1",
      {
        task: "do the work",
        paths: ["apps/web/app.tsx", "services/billing/x.rb"],
        assignments: [
          {
            owner: "billing",
            task: "update billing",
            paths: ["services/billing/x.rb"],
          },
          {
            owner: "web",
            task: "update web",
            paths: ["apps/web/app.tsx"],
            depends_on: ["billing"],
          },
        ],
      },
      undefined,
      onUpdate as never,
      { cwd: dir, model: fakeModel } as never,
    );

    // onUpdate saw the ordered progress narration.
    expect(updates.some((u) => u.includes("delegating to 2 owner(s)"))).toBe(true);
    expect(updates.some((u) => u.includes("[1/2] billing"))).toBe(true);
    expect(updates.some((u) => u.includes("[2/2] web"))).toBe(true);
    expect(updates[updates.length - 1]).toContain("delegation complete");
    // And the extension-facing onProgress saw the same sequence boundaries.
    expect(progressSeen[0].kind).toBe("sequence_start");
    expect(progressSeen[progressSeen.length - 1].kind).toBe("sequence_end");
  });
});
