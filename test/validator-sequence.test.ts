import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import * as orcaspec from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import { resolve } from "../src/resolver";
import {
  runDelegationSequence,
  type DelegationInputs,
  type DelegationSession,
  type DelegationSessionConfig,
} from "../src/delegation";
import { makeGitRepo, makeStateRoot, snapshotTree } from "./git-fixture";

/**
 * The acceptance gate over a MULTI-OWNER sequence (staged-promotion plan, Phase 4).
 *
 * A sequence is one transaction with one promotion, so it gets one acceptance gate:
 * it runs once, after the last owner has committed, over the sequence's complete
 * work — not once per owner over a half-finished checkout. These tests pin who is
 * asked, in what order, and what their verdict does to the transaction, with real
 * validator processes in a real shared staged checkout.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;
const doc = orcaspec.loadFixture("multi-owner");

/** One DelegationInputs per resolved owner, in the resolver's order. */
function orderedFor(cwd: string, paths: string[]): DelegationInputs[] {
  return resolve(doc, paths).delegations.map((delegation) => ({
    document: doc,
    owner: delegation.owner,
    targets: delegation.targets,
    grant: delegation.grant,
    task: "work",
    effectiveMode: "enforce" as const,
    cwd,
    parent: { model: fakeModel, thinkingLevel: "high" as const },
  }));
}

async function callTool(
  config: DelegationSessionConfig,
  name: string,
  params: unknown,
): Promise<void> {
  const tool = config.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`scripted agent referenced missing tool '${name}'`);
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

type Script = (config: DelegationSessionConfig) => Promise<void>;

function sessions(scripts: Record<string, Script>) {
  const captured: DelegationSessionConfig[] = [];
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    captured.push(config);
    const script = scripts[config.owner];
    if (!script) throw new Error(`no script for owner '${config.owner}'`);
    return { prompt: () => script(config), abort: vi.fn() };
  };
  return { createSession, captured };
}

function writeOverlay(repo: string, overlay: unknown): void {
  mkdirSync(join(repo, ".orca"), { recursive: true });
  writeFileSync(
    join(repo, ".orca", "runtime.yaml"),
    stringify(overlay, { aliasDuplicateObjects: false }),
  );
}

/**
 * A validator that appends its own label to a file OUTSIDE the checkout, so the
 * record of which validators ran, and in what order, survives the checkout's
 * teardown.
 */
function recordingValidator(trail: string, label: string): Record<string, unknown> {
  return {
    program: process.execPath,
    args: [
      "-e",
      `require('fs').appendFileSync(${JSON.stringify(trail)}, ${JSON.stringify(`${label}\n`)});`,
    ],
    timeout_seconds: 10,
  };
}

/** The scripted owner: write its own file, then complete. */
const ownFile: Record<string, string> = {
  billing: "services/billing/x.rb",
  web: "apps/web/app.tsx",
};

function completing(status = "completed"): Script {
  return async (config) => {
    await callTool(config, "write", {
      path: ownFile[config.owner],
      content: `${config.owner} work\n`,
    });
    await callTool(config, "orca_checkpoint", { status, summary: `${config.owner} ${status}` });
  };
}

describe("one gate for the whole sequence", () => {
  let repo: string;
  let stateRoot: string;
  let trail: string;
  beforeEach(() => {
    repo = makeGitRepo("orca-validator-seq-");
    stateRoot = makeStateRoot();
    trail = join(stateRoot, "trail.txt");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("runs every participating owner's validators, in execution order, and nobody else's", async () => {
    writeOverlay(repo, {
      schema_version: 1,
      validations: {
        web: [recordingValidator(trail, "web-1"), recordingValidator(trail, "web-2")],
        billing: [recordingValidator(trail, "billing-1")],
        // Declared, but this agent takes no part in the delegation.
        "design-system": [recordingValidator(trail, "design-system-1")],
      },
    });
    const { createSession } = sessions({ billing: completing(), web: completing() });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    expect(sequence.allCompleted).toBe(true);
    expect(sequence.promotion.status).toBe("promoted");
    // Execution order first, declaration order within an owner, and no validator
    // belonging to an agent that never ran: a delegation is accountable for its own
    // work, not for a suite it had no way to affect.
    expect(readFileSync(trail, "utf8")).toBe("billing-1\nweb-1\nweb-2\n");
    expect(sequence.promotion.validations.map((run) => run.agent)).toEqual([
      "billing",
      "web",
      "web",
    ]);
  });

  it("records the sequence's validator runs on every owner's delegation entry", async () => {
    writeOverlay(repo, {
      schema_version: 1,
      validations: { web: [recordingValidator(trail, "web-1")] },
    });
    const { createSession } = sessions({ billing: completing(), web: completing() });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    // The gate decided one promotion for all of them, so each entry can answer
    // "what cleared my work" with the same evidence.
    for (const step of sequence.steps) {
      expect(step.kind).toBe("delegated");
      if (step.kind !== "delegated") continue;
      expect(step.outcome.appendEntry.promotion.validations.map((run) => run.status)).toEqual([
        "passed",
      ]);
    }
  });

  it("promotes nothing for anybody when one validator fails, and keeps the whole patch", async () => {
    writeOverlay(repo, {
      schema_version: 1,
      validations: {
        web: [
          {
            program: process.execPath,
            args: ["-e", "process.stderr.write('web suite red');process.exit(2);"],
            timeout_seconds: 10,
          },
        ],
      },
    });
    const before = snapshotTree(repo);
    const { createSession } = sessions({ billing: completing(), web: completing() });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    // Every owner completed and every owner's change was authorized — and still
    // nothing lands, because the transaction failed its acceptance gate.
    expect(sequence.allCompleted).toBe(true);
    expect(sequence.promotion.status).toBe("rejected");
    expect(snapshotTree(repo)).toEqual(before);
    const patch = readFileSync(sequence.promotion.patchPath!, "utf8");
    expect(patch).toContain("billing work");
    expect(patch).toContain("web work");
    expect(readFileSync(sequence.promotion.validatorOutputPath!, "utf8")).toContain(
      "web suite red",
    );
  });

  it("does not run a validator for a sequence that could never promote anyway", async () => {
    writeOverlay(repo, {
      schema_version: 1,
      validations: { web: [recordingValidator(trail, "web-1")] },
    });
    const { createSession } = sessions({
      billing: completing(),
      web: completing("failed"),
    });

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    expect(sequence.promotion.status).toBe("not_attempted");
    // Spending the user's time on a suite whose verdict cannot change the outcome
    // would be waste, so the gate is never reached.
    expect(existsSync(trail)).toBe(false);
    expect(sequence.promotion.validations).toEqual([]);
  });

  it("blocks the whole sequence before anything spawns when the overlay is malformed", async () => {
    mkdirSync(join(repo, ".orca"), { recursive: true });
    writeFileSync(
      join(repo, ".orca", "runtime.yaml"),
      "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      timeout_secs: 5\n",
    );
    const before = snapshotTree(repo);
    const { createSession, captured } = sessions({});

    const sequence = await runDelegationSequence(
      orderedFor(repo, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, stateRoot },
    );

    expect(captured).toHaveLength(0);
    expect(sequence.steps[0].kind).toBe("build_failed");
    if (sequence.steps[0].kind === "build_failed") {
      expect(sequence.steps[0].failureKind).toBe("invalid_runtime_overlay");
      expect(sequence.steps[0].diagnostics.join("\n")).toContain("overlay.unknown_field");
    }
    expect(sequence.steps[1].kind).toBe("not_run");
    expect(sequence.promotion.status).toBe("not_attempted");
    // Not even a checkout: a sequence that cannot be validated does not start.
    expect(existsSync(join(stateRoot, "worktrees"))).toBe(false);
    expect(snapshotTree(repo)).toEqual(before);
  });
});
