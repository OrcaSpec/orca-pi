import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelegationRecord } from "../src/checkpoint";
import type { DelegationSessionConfig } from "../src/delegation";
import { createRealSessionFactory } from "../src/session-runner";

function config(cwd: string): DelegationSessionConfig {
  return {
    cwd,
    owner: "runtime",
    targets: ["src/duration.py"],
    grantId: "grant-1",
    systemPrompt: "Work only on the assigned target.",
    contextFiles: [],
    tools: [] as ToolDefinition[],
    toolNames: [],
    model: undefined,
    thinkingLevel: "medium",
    kickoffPrompt: "Begin.",
    record: createDelegationRecord(),
    warnings: [],
    instructionDigests: [],
    contextDigests: [],
  };
}

describe("real delegated session observer isolation", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("loads only the hidden child observer and finalizes its evidence", async () => {
    directory = mkdtempSync(join(tmpdir(), "orca-pi-observer-"));
    const start = vi.fn();
    const setOutcome = vi.fn();
    const finish = vi.fn();
    const shutdown = vi.fn();
    const prepareDelegation = vi.fn(() => ({
      extension: {
        name: "orca-eval-child-observer",
        hidden: true,
        factory: (pi: ExtensionAPI) => {
          pi.on("session_shutdown", shutdown);
        },
      },
      start,
      setOutcome,
      finish,
    }));
    const factory = createRealSessionFactory(
      await ModelRuntime.create(),
      { prepareDelegation },
    );
    const session = await factory(config(directory));
    await session.finish?.({
      status: "completed",
      checkpointStatus: "completed",
      changedPaths: ["src/duration.py"],
    });

    expect(prepareDelegation).toHaveBeenCalledWith({
      grantId: "grant-1",
      targetPaths: ["src/duration.py"],
      resolvedOwners: ["runtime"],
    });
    expect(start).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(setOutcome).toHaveBeenCalledWith({
      status: "completed",
      checkpointStatus: "completed",
      changedPaths: ["src/duration.py"],
    });
    expect(finish).toHaveBeenCalledOnce();
  });
});
