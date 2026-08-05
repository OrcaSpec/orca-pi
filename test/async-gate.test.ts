import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { Model } from "@earendil-works/pi-ai";
import type { DomainAgent, OrcaSpecDocument } from "orcaspec";
import { compileGrant } from "../src/resolver";
import {
  runDelegation,
  type DelegationInputs,
  type DelegationSession,
  type DelegationSessionConfig,
} from "../src/delegation";
import type { RuntimeOverlay, ValidatorDeclaration } from "../src/runtime-overlay";
import type { AcceptanceGate, StagedWorkspace } from "../src/staging";
import { gitWorktreeStaging } from "../src/staging-worktree";
import { createAcceptanceGate } from "../src/validators";
import { git, makeGitRepo, makeStateRoot, snapshotTree } from "./git-fixture";

/**
 * The acceptance gate runs WITHOUT holding the event loop (staged-promotion
 * hardening plan, Phase 1).
 *
 * Everything about the gate's verdicts is pinned by `runtime-validators.test.ts`
 * and `validator-sequence.test.ts`; this file pins the two things that are only
 * meaningful once the gate is asynchronous — that other work progresses while a
 * validator runs, and that cancelling the delegation kills the validator and
 * refuses the promotion.
 *
 * The validators are REAL child processes and the timing assertions are made
 * against the wall clock both sides share, because "the event loop was free" is
 * exactly the claim a doubled runner could not support.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;

function webAgent(): DomainAgent {
  return {
    id: "web",
    name: "Web",
    description: "Owns the web application.",
    ownership: ["apps/web/**"],
    permissions: { read: { allow: ["docs/**"] }, edit: { allow: ["apps/web/**"] } },
  };
}

function doc(): OrcaSpecDocument {
  return {
    spec_version: "0.1",
    repository: { id: "018f4f72-0000-7000-8000-0000000000aa" },
    administration: { approvers: [{ provider: "orca-local", principal: "test" }] },
    steward: { discovery: { read: { allow: ["**"], deny: [] } } },
    protected_denies: {},
    agents: [webAgent()],
  };
}

function inputsFor(cwd: string): DelegationInputs {
  return {
    document: doc(),
    owner: "web",
    targets: ["apps/web/app.tsx"],
    grant: compileGrant(webAgent(), {}),
    task: "restyle the button",
    effectiveMode: "enforce",
    cwd,
    parent: { model: fakeModel, thinkingLevel: "high" },
    delegationId: "delegation_async_gate",
  };
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

/** The scripted owner: one authorized write, then a completed checkpoint. */
const writeAndComplete = async (config: DelegationSessionConfig): Promise<void> => {
  await callTool(config, "write", { path: "apps/web/app.tsx", content: "reviewed\n" });
  await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
};

function sessions(script: (config: DelegationSessionConfig) => Promise<void>) {
  const captured: DelegationSessionConfig[] = [];
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    captured.push(config);
    return { prompt: () => script(config), abort: vi.fn() };
  };
  return { createSession, captured };
}

/** A repository with one committed owned file, ready to delegate against. */
function repoWithApp(): string {
  const repo = makeGitRepo("orca-async-gate-");
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "app.tsx"), "committed\n");
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-q",
    "-m",
    "seed",
  );
  return repo;
}

function writeOverlay(repo: string, overlay: unknown): void {
  mkdirSync(join(repo, ".orca"), { recursive: true });
  writeFileSync(
    join(repo, ".orca", "runtime.yaml"),
    stringify(overlay, { aliasDuplicateObjects: false }),
  );
}

/** One validator declaration running an inline node script as a real process. */
function nodeValidator(
  script: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { program: process.execPath, args: ["-e", script], timeout_seconds: 10, ...extra };
}

/**
 * Wait for a marker a child process writes, so the test can act at a moment it knows
 * is INSIDE the gate. Polling a real file rather than sleeping is what keeps the
 * cancellation tests deterministic: nothing is asserted about how long staging, the
 * scripted session, or process startup take.
 */
async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`marker never appeared: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a process still exists; signal 0 tests for it without touching it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One normalized declaration, as the overlay loader would have produced it. */
function decl(script: string, overrides: Partial<ValidatorDeclaration> = {}): ValidatorDeclaration {
  return {
    program: process.execPath,
    args: ["-e", script],
    cwd: "",
    timeoutSeconds: 10,
    ...overrides,
  };
}

/**
 * The gate exactly as `delegation.ts` builds it — from a validated overlay, for the
 * owners that ran — over a real staged checkout. Driving the gate directly is what
 * lets a test pin how one validator ends without also arranging a whole delegation
 * around it; the workspace is real because where a validator runs, and where its
 * output is preserved, are part of what is being asserted.
 */
function gateOver(
  repo: string,
  stateRoot: string,
  declarations: ValidatorDeclaration[],
): { gate: AcceptanceGate; workspace: StagedWorkspace; close: () => void } {
  const opened = gitWorktreeStaging.open({
    cwd: repo,
    delegationId: "delegation_edges",
    stateRoot,
  });
  if (!opened.ok) throw new Error(`staging refused: ${opened.diagnostics.join(" ")}`);
  const overlay: RuntimeOverlay = { schemaVersion: 1, validations: { web: declarations } };
  const gate = createAcceptanceGate(overlay, ["web"]);
  if (!gate) throw new Error("the overlay declared no validators");
  return {
    gate,
    workspace: opened.workspace,
    close: () => gitWorktreeStaging.close(opened.workspace),
  };
}

/**
 * A validator that announces its own pid and would take five seconds to finish.
 * Both halves matter to a cancellation test: the pid is how the test asserts the
 * child was really killed, and the long tail is what a cancellation has to cut.
 */
function longValidator(startedAt: string, finishedAt: string): Record<string, unknown> {
  return nodeValidator(
    "const fs = require('fs');" +
      `fs.writeFileSync(${JSON.stringify(startedAt)}, String(process.pid));` +
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(finishedAt)}, 'finished'), 5000);`,
    { timeout_seconds: 30 },
  );
}

describe("a validator no longer holds the event loop", () => {
  it("lets other work progress while a validator sleeps", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const startedAt = join(stateRoot, "validator-started");
    const endedAt = join(stateRoot, "validator-ended");
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          // A validator that takes real time and reports the wall-clock window it
          // occupied, so the test can ask what the session did DURING it.
          web: [
            nodeValidator(
              "const fs = require('fs');" +
                `fs.writeFileSync(${JSON.stringify(startedAt)}, String(Date.now()));` +
                `setTimeout(() => fs.writeFileSync(${JSON.stringify(endedAt)}, String(Date.now())), 400);`,
            ),
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      // A concurrent task on the parent's own event loop, stamping the clock. Under a
      // synchronous gate these stamps cannot land inside the validator's window: the
      // spawn holds the loop, and every missed interval is coalesced into one tick
      // after the child is gone.
      const ticks: number[] = [];
      const heartbeat = setInterval(() => ticks.push(Date.now()), 20);
      let result: Awaited<ReturnType<typeof runDelegation>>;
      try {
        result = await runDelegation(inputsFor(repo), { createSession, stateRoot });
      } finally {
        clearInterval(heartbeat);
      }

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The gate really ran (and passed), so the window below is a validator's.
      expect(result.outcome.promotion.status).toBe("promoted");
      const started = Number(readFileSync(startedAt, "utf8"));
      const ended = Number(readFileSync(endedAt, "utf8"));
      expect(ended).toBeGreaterThan(started);
      expect(ticks.filter((tick) => tick > started && tick < ended).length).toBeGreaterThan(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("cancelling a delegation while a validator runs", () => {
  it("kills the child, refuses the promotion, and records the run that was cut", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const startedAt = join(stateRoot, "validator-started");
    const finishedAt = join(stateRoot, "validator-finished");
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: { web: [longValidator(startedAt, finishedAt)] },
      });
      const before = snapshotTree(repo);
      const { createSession } = sessions(writeAndComplete);
      const controller = new AbortController();

      const running = runDelegation(inputsFor(repo), {
        createSession,
        stateRoot,
        signal: controller.signal,
      });
      // Cancel at a moment that is certainly inside the gate: the validator itself
      // said it had started.
      await waitForFile(startedAt);
      const pid = Number(readFileSync(startedAt, "utf8"));
      controller.abort();
      const result = await running;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const promotion = result.outcome.promotion;
      // The child is gone, long before the five seconds it wanted.
      expect(alive(pid)).toBe(false);
      await sleep(100);
      expect(existsSync(finishedAt)).toBe(false);
      // The promotion is refused through the ordinary gate path, and the run that was
      // cut is on the record rather than missing from it.
      expect(promotion.status).toBe("rejected");
      expect(promotion.validations.map((run) => run.status)).toEqual(["cancelled"]);
      expect(promotion.diagnostics.join("\n")).toMatch(/cancelled/i);
      expect(readFileSync(promotion.validatorOutputPath!, "utf8")).toContain("CANCELLED");
      // Nothing reached the user's files, and the work survives as evidence.
      expect(snapshotTree(repo)).toEqual(before);
      expect(readFileSync(promotion.patchPath!, "utf8")).toContain("reviewed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not start the validators that would have run after it", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const startedAt = join(stateRoot, "validator-started");
    const finishedAt = join(stateRoot, "validator-finished");
    const trail = join(stateRoot, "trail.txt");
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            longValidator(startedAt, finishedAt),
            nodeValidator(`require('fs').appendFileSync(${JSON.stringify(trail)}, 'second\\n');`),
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);
      const controller = new AbortController();

      const running = runDelegation(inputsFor(repo), {
        createSession,
        stateRoot,
        signal: controller.signal,
      });
      await waitForFile(startedAt);
      controller.abort();
      const result = await running;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A cancellation is one more way not to pass, so it stops the run of the
      // sequence exactly where a failing validator would have.
      expect(existsSync(trail)).toBe(false);
      expect(result.outcome.promotion.validations.map((run) => run.status)).toEqual(["cancelled"]);
      expect(result.outcome.promotion.diagnostics.join("\n")).toContain(
        "1 later validator(s) were not run",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("spawns nothing at all when the cancellation arrived before the gate did", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const trail = join(stateRoot, "trail.txt");
    const { gate, workspace, close } = gateOver(repo, stateRoot, [
      decl(`require('fs').appendFileSync(${JSON.stringify(trail)}, 'ran\\n');`),
    ]);
    try {
      const controller = new AbortController();
      controller.abort();

      const result = await gate(workspace, controller.signal);

      // Already cancelled is not "run it anyway" and not "pass it silently": the run is
      // recorded so the evidence names the validator that never got its chance.
      expect(existsSync(trail)).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.validations.map((run) => run.status)).toEqual(["cancelled"]);
      expect(result.validations[0].stderr).toContain("cancelled before this validator started");
      expect(readFileSync(result.validatorOutputPath!, "utf8")).toContain("CANCELLED");
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("a validator the runtime has to stop", () => {
  it("kills a validator that ignores SIGTERM rather than letting it outlive its budget", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const { gate, workspace, close } = gateOver(repo, stateRoot, [
        // A program that traps the polite signal and keeps running. Under the
        // synchronous gate this was unbounded: `spawnSync` waited for a child that
        // never left.
        decl("process.on('SIGTERM', () => {});setInterval(() => {}, 1000);", {
          timeoutSeconds: 0.25,
        }),
      ]);
    try {

      const result = await gate(workspace, undefined);

      expect(result.ok).toBe(false);
      // Still a timeout — that is what happened — and the escalation is visible in the
      // signal that actually ended it.
      expect(result.validations[0].status).toBe("timed_out");
      expect(result.validations[0].signal).toBe("SIGKILL");
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("stops a validator whose output passes the capture cap, and says so", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const { gate, workspace, close } = gateOver(repo, stateRoot, [
        // More output than the gate will hold. The cap bounds THIS process's memory,
        // so passing it is a refusal rather than a truncated pass.
        decl("const line = 'x'.repeat(1024 * 1024);for (let i = 0; i < 12; i++) process.stdout.write(line);"),
      ]);
    try {

      const result = await gate(workspace, undefined);

      expect(result.ok).toBe(false);
      expect(result.validations[0].status).toBe("unavailable");
      expect(result.validations[0].stderr).toContain("bytes of output and was stopped");
      // What was captured before the cap is still evidence, bounded for the log.
      expect(result.validations[0].stdout).toContain("… (truncated at 4000 characters)");
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("reports a validator something else killed as one that could not be run", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const { gate, workspace, close } = gateOver(repo, stateRoot, [
        decl("process.kill(process.pid, 'SIGKILL');setInterval(() => {}, 1000);"),
      ]);
    try {

      const result = await gate(workspace, undefined);

      // A death by signal that the gate did not order is not a verdict the program
      // gave, so it refuses the promotion rather than counting as a pass.
      expect(result.ok).toBe(false);
      expect(result.validations[0].status).toBe("unavailable");
      expect(result.validations[0].signal).toBe("SIGKILL");
      expect(result.validations[0].exitCode).toBeUndefined();
    } finally {
      close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("the window a real validator opens", () => {
  it("still catches a checkout the user moved while a validator was running", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const startedAt = join(stateRoot, "validator-started");
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            nodeValidator(
              "const fs = require('fs');" +
                `fs.writeFileSync(${JSON.stringify(startedAt)}, 'started');` +
                "setTimeout(() => {}, 400);",
            ),
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      // The base guard bracketing the gate is pinned by `stale-base.test.ts` with a
      // synthetic gate standing in for elapsed time. Now that the gate is really
      // asynchronous, the same window can be entered for real: this edit happens on
      // the parent's event loop WHILE a validator process is running.
      const running = runDelegation(inputsFor(repo), { createSession, stateRoot });
      await waitForFile(startedAt);
      writeFileSync(join(repo, "apps", "web", "app.tsx"), "the user got there first\n");
      const result = await running;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const promotion = result.outcome.promotion;
      expect(promotion.status).toBe("conflict");
      expect(promotion.driftedPaths).toEqual(["apps/web/app.tsx"]);
      // The user's own edit stands, and the delegation's work is recoverable.
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe(
        "the user got there first\n",
      );
      expect(readFileSync(promotion.patchPath!, "utf8")).toContain("reviewed");
      // The gate itself passed; the base is what moved.
      expect(promotion.validations[0].status).toBe("passed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
