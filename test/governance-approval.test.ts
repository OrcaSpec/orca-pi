import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import type { DomainAgent } from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import { compileGrant, resolve, type CompiledGrant } from "../src/resolver";
import {
  runDelegationSequence,
  type DelegationInputs,
  type DelegationSession,
  type DelegationSessionConfig,
} from "../src/delegation";
import {
  buildDelegationRecord,
  digestGrants,
  DelegationHistory,
  APPROVAL_ENTRY_TYPE,
  DELEGATION_ENTRY_TYPE,
  toPersistedApproval,
} from "../src/delegation-entry";
import {
  commitAuthorizedWork,
  promoteStagedCommits,
  type HeldGovernance,
  type StagedWorkspace,
} from "../src/staging";
import { gitWorktreeStaging } from "../src/staging-worktree";
import { runApprovalAction, type GovernanceHold } from "../src/approval";
import { createDelegateTool } from "../src/tools";
import { detectRepositoryState } from "../src/state";
import { git, makeGitRepo, makeStateRoot, snapshotTree } from "./git-fixture";

/**
 * The explicit approval action (hardening plan, Phase 3).
 *
 * Phase 2 made a governance change something no delegation can land; this is the one
 * runtime path that lands it, and it lands it because the user said so. Every test
 * here drives a REAL held patch — produced by the real gate out of a real staged
 * worktree — against a real checkout, because the whole claim of the phase is about
 * what `git apply` does to the user's files.
 */

/** An owner whose grant covers the governance directory itself. */
const governanceGrant: CompiledGrant = compileGrant(
  {
    id: "governance",
    name: "Governance",
    description: "Owns the governance documents.",
    ownership: [".orca/**"],
    permissions: { edit: { allow: [".orca/**"] } },
  } satisfies DomainAgent,
  {},
);

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The user's own runtime overlay, as valid YAML. */
const USER_OVERLAY = "schema_version: 1\nvalidations: {}\n";

/** What a delegated agent proposes it should become. */
const AGENT_OVERLAY = "schema_version: 1\nvalidations: {}\n# tightened by the agent\n";

/** A fixed instant, so an approval's recorded time is an assertion and not a race. */
const APPROVED_AT = Date.UTC(2026, 7, 5, 12, 0, 0);

function fixture(): { repo: string; stateRoot: string } {
  const repo = makeGitRepo("orca-approve-");
  const stateRoot = makeStateRoot();
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  mkdirSync(join(repo, ".orca"), { recursive: true });
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, ".orca", "runtime.yaml"), USER_OVERLAY);
  writeFileSync(join(repo, "apps", "web", "app.tsx"), "committed app\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "seed");
  return { repo, stateRoot };
}

function open(repo: string, stateRoot: string, delegationId = "d1"): StagedWorkspace {
  const opened = gitWorktreeStaging.open({ cwd: repo, delegationId, stateRoot });
  if (!opened.ok) throw new Error(`staging refused: ${opened.diagnostics.join(" ")}`);
  cleanups.push(() => gitWorktreeStaging.close(opened.workspace));
  return opened.workspace;
}

/**
 * A real held patch: a delegation rewrites the governance overlay, the real gate
 * holds it, and the workspace is torn down — exactly the state a steward is in when
 * they come to approve, with nothing left but the patch and the record.
 */
async function heldOverlayChange(
  repo: string,
  stateRoot: string,
  content = AGENT_OVERLAY,
  delegationId = "d1",
): Promise<HeldGovernance> {
  const workspace = open(repo, stateRoot, delegationId);
  writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), content);
  const record = await promoteStagedCommits(workspace, [
    commitAuthorizedWork(workspace, governanceGrant, "governance"),
  ]);
  if (!record.heldGovernance) throw new Error(`nothing was held: ${record.diagnostics.join(" ")}`);
  gitWorktreeStaging.close(workspace);
  return record.heldGovernance;
}

/** One hold as the history offers it to the action: awaiting a decision. */
function pending(held: HeldGovernance, task = "tighten the governance overlay"): GovernanceHold {
  return { held, task, sequenceId: "sequence_abc123" };
}

/** A session entry as pi stores it, JSON round-tripped like the real store. */
function entryOf(customType: string, data: unknown): unknown {
  return { type: "custom", customType, data: JSON.parse(JSON.stringify(data)) };
}

/** A real delegated session writing the given files, then checkpointing completed. */
function writesThenCompletes(files: Record<string, string>) {
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => ({
    abort: vi.fn(),
    prompt: async () => {
      for (const [path, content] of Object.entries(files)) {
        const write = config.tools.find((tool) => tool.name === "write");
        if (!write) throw new Error("the delegated session has no write tool");
        await write.execute("t", { path, content } as never, undefined, undefined, {
          cwd: config.cwd,
        } as never);
      }
      const checkpoint = config.tools.find((tool) => tool.name === "orca_checkpoint")!;
      await checkpoint.execute(
        "t",
        { status: "completed", summary: "overlay tightened" } as never,
        undefined,
        undefined,
        { cwd: config.cwd } as never,
      );
    },
  });
  return { createSession };
}

const monolithDoc = orcaspec.loadFixture("root-recursive-owner");

/** A one-owner delegation of the given targets under a spec that owns everything. */
function monolithInputs(cwd: string, targets: string[]): DelegationInputs {
  const delegation = resolve(monolithDoc, targets).delegations[0];
  return {
    document: monolithDoc,
    owner: delegation.owner,
    targets: delegation.targets,
    grant: delegation.grant,
    task: "tighten the governance overlay",
    effectiveMode: "enforce",
    cwd,
    parent: { model: { id: "fake", provider: "fake" } as unknown as Model<any>, thinkingLevel: "high" },
  };
}

describe("approving a held governance change", () => {
  it("applies the patch to the user's checkout and records what landed", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);

    const result = runApprovalAction({
      cwd: repo,
      holds: [pending(held)],
      now: APPROVED_AT,
    });

    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(AGENT_OVERLAY);
    expect(result.approval).toMatchObject({
      outcome: "applied",
      patchPath: held.patchPath,
      paths: [".orca/runtime.yaml"],
      at: APPROVED_AT,
    });
    expect(result.lines.join("\n")).toContain(".orca/runtime.yaml");
  });
});

/**
 * Every shape of change a governance patch can carry, approved for real. Binary content
 * and deletions are the two that git reports differently from an ordinary edit, and both
 * have to survive the check that the patch still matches the hold.
 */
describe("approving every kind of governance change", () => {
  it("applies a multi-file hold whole", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), AGENT_OVERLAY);
    writeFileSync(join(workspace.dir, ".orca", "orca.yaml"), "rewritten spec\n");
    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, governanceGrant, "governance"),
    ]);
    gitWorktreeStaging.close(workspace);

    const result = runApprovalAction({
      cwd: repo,
      holds: [pending(record.heldGovernance!)],
      now: APPROVED_AT,
    });

    expect(result.approval?.outcome).toBe("applied");
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(AGENT_OVERLAY);
    expect(readFileSync(join(repo, ".orca", "orca.yaml"), "utf8")).toBe("rewritten spec\n");
  });

  it("applies a binary governance file byte for byte", async () => {
    const { repo, stateRoot } = fixture();
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x7f]);
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "seal.bin"), bytes);
    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, governanceGrant, "governance"),
    ]);
    gitWorktreeStaging.close(workspace);

    const result = runApprovalAction({
      cwd: repo,
      holds: [pending(record.heldGovernance!)],
      now: APPROVED_AT,
    });

    expect(result.approval?.outcome).toBe("applied");
    expect(readFileSync(join(repo, ".orca", "seal.bin"))).toEqual(bytes);
  });

  it("applies a governance DELETION, removing the file the user still has", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    rmSync(join(workspace.dir, ".orca", "runtime.yaml"));
    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, governanceGrant, "governance"),
    ]);
    gitWorktreeStaging.close(workspace);

    const result = runApprovalAction({
      cwd: repo,
      holds: [pending(record.heldGovernance!)],
      now: APPROVED_AT,
    });

    expect(result.approval?.outcome).toBe("applied");
    expect(existsSync(join(repo, ".orca", "runtime.yaml"))).toBe(false);
  });
});

describe("approving a patch the checkout has moved under", () => {
  it("refuses, says the patch no longer applies, and leaves the checkout untouched", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);
    // The user edits the very file the held patch rewrites, after it was staged.
    writeFileSync(join(repo, ".orca", "runtime.yaml"), "schema_version: 1\n# the user's own edit\n");
    const before = snapshotTree(repo);

    const result = runApprovalAction({ cwd: repo, holds: [pending(held)], now: APPROVED_AT });

    expect(result.approval?.outcome).toBe("does_not_apply");
    expect(result.level).toBe("warning");
    expect(result.lines.join("\n")).toMatch(/does not apply/i);
    // Nothing about the user's files moved, and the proposal is still there to retry.
    expect(snapshotTree(repo)).toEqual(before);
    expect(readFileSync(held.patchPath, "utf8")).toContain("tightened by the agent");
  });
});

/**
 * The durable side. A held patch outlives the session that proposed it, so the history
 * is the only thing that remembers a hold exists — and once it is approved, the only
 * thing that can stop telling the steward to go and approve it.
 */
describe("what the history says about a hold before and after approval", () => {
  /** A delegation that rewrites the governance overlay, persisted as a session entry. */
  async function delegatedHold(repo: string, stateRoot: string) {
    const inputs = monolithInputs(repo, [".orca/runtime.yaml"]);
    const { createSession } = writesThenCompletes({ ".orca/runtime.yaml": AGENT_OVERLAY });
    const sequence = await runDelegationSequence([inputs], { createSession, stateRoot });
    const record = buildDelegationRecord({
      task: "tighten the governance overlay",
      targets: [".orca/runtime.yaml"],
      grantDigest: digestGrants([inputs.grant]),
      sequence,
      startedAt: 1,
      endedAt: 2,
      sequenceId: "sequence_abc123",
    });
    return { record, entry: entryOf(DELEGATION_ENTRY_TYPE, record) };
  }

  it("offers the hold for approval, then reports it approved and when", async () => {
    const { repo, stateRoot } = fixture();
    const { record, entry } = await delegatedHold(repo, stateRoot);

    const history = new DelegationHistory();
    history.rebuildFrom([entry]);
    expect(history.lastDetailLines().join("\n")).toContain("HELD FOR YOUR APPROVAL");
    const holds = history.holds();
    expect(holds).toHaveLength(1);
    expect(holds[0].held.patchPath).toBe(record.promotion!.heldGovernance!.patchPath);
    expect(holds[0].task).toBe("tighten the governance overlay");

    const result = runApprovalAction({ cwd: repo, holds, now: APPROVED_AT });
    expect(result.approval?.outcome).toBe("applied");
    history.recordApproval(result.approval!);

    const detail = history.lastDetailLines().join("\n");
    expect(detail).not.toMatch(/HELD FOR YOUR APPROVAL|await/i);
    expect(detail).toContain("APPROVED");
    expect(detail).toContain(new Date(APPROVED_AT).toISOString());
    // And nothing is left waiting for a decision.
    expect(history.holds().filter((hold) => !hold.approval)).toEqual([]);
  });

  it("recovers the approval in a resumed session, from session entries alone", async () => {
    const { repo, stateRoot } = fixture();
    const { entry } = await delegatedHold(repo, stateRoot);

    const live = new DelegationHistory();
    live.rebuildFrom([entry]);
    const result = runApprovalAction({ cwd: repo, holds: live.holds(), now: APPROVED_AT });
    const approvalEntry = entryOf(APPROVAL_ENTRY_TYPE, toPersistedApproval(result.approval!));

    // A fresh history, rebuilt from the branch the way `session_start` does it: the
    // approval has to travel as its own entry, because the delegation entry was written
    // before the user ever decided.
    const resumed = new DelegationHistory();
    resumed.rebuildFrom([entry, approvalEntry]);

    const detail = resumed.lastDetailLines().join("\n");
    expect(detail).toContain("APPROVED");
    expect(detail).not.toContain("HELD FOR YOUR APPROVAL");
    expect(resumed.statusLines().join("\n")).toContain("governance approved");
    // Approving again in the resumed session is refused as already approved.
    const again = runApprovalAction({
      cwd: repo,
      selector: result.approval!.patchPath,
      holds: resumed.holds(),
      now: APPROVED_AT + 60_000,
    });
    expect(again.approval).toBeUndefined();
    expect(again.lines.join("\n")).toMatch(/already approved/i);
  });

  it("shows a refused approval attempt without retiring the hold", async () => {
    const { repo, stateRoot } = fixture();
    const { entry } = await delegatedHold(repo, stateRoot);
    // The user edits the file themselves, so the held patch no longer applies.
    writeFileSync(join(repo, ".orca", "runtime.yaml"), "schema_version: 1\n# mine\n");

    const history = new DelegationHistory();
    history.rebuildFrom([entry]);
    const result = runApprovalAction({ cwd: repo, holds: history.holds(), now: APPROVED_AT });
    history.recordApproval(result.approval!);

    const detail = history.lastDetailLines().join("\n");
    // Still awaiting — a refusal is not a decision — but the attempt is on the record,
    // so a steward is not told to approve a patch that just refused to apply.
    expect(detail).toContain("HELD FOR YOUR APPROVAL");
    expect(detail).toContain("does_not_apply");
    expect(detail).toContain(new Date(APPROVED_AT).toISOString());
    expect(history.holds()).toHaveLength(1);
  });

  it("ignores an approval entry that is not one of ours", () => {
    const history = new DelegationHistory();
    // Rebuild has to survive an arbitrary branch: a foreign entry, a stale version, and
    // a malformed payload must all be skipped rather than trusted or thrown on.
    history.rebuildFrom([
      { type: "custom", customType: APPROVAL_ENTRY_TYPE, data: { v: 99, patchPath: "/x" } },
      { type: "custom", customType: APPROVAL_ENTRY_TYPE, data: "not an object" },
      { type: "custom", customType: APPROVAL_ENTRY_TYPE },
      { type: "message", message: { role: "user" } },
    ]);
    expect(history.count()).toBe(0);
    expect(history.holds()).toEqual([]);
  });
});

describe("which held change an approval means", () => {
  it("says so plainly when nothing is held for approval", () => {
    const { repo } = fixture();
    const before = snapshotTree(repo);

    const result = runApprovalAction({ cwd: repo, holds: [], now: APPROVED_AT });

    expect(result.approval).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(/nothing is (held|awaiting)/i);
    expect(snapshotTree(repo)).toEqual(before);
  });

  it("approves the newest hold when no selector is given, and names the older ones", async () => {
    const { repo, stateRoot } = fixture();
    const older = await heldOverlayChange(repo, stateRoot, AGENT_OVERLAY, "older");
    const newer = await heldOverlayChange(
      repo,
      stateRoot,
      "schema_version: 1\nvalidations: {}\n# newest proposal\n",
      "newer",
    );

    // Newest first: a hold is nearly always approved right after the delegation that
    // proposed it, so the common case needs no selector — but the action says which one
    // it took and what else is waiting, because the pick is not reversible by asking.
    const result = runApprovalAction({
      cwd: repo,
      holds: [pending(newer, "the newest task"), pending(older, "the older task")],
      now: APPROVED_AT,
    });

    expect(result.approval).toMatchObject({ outcome: "applied", patchPath: newer.patchPath });
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toContain("newest proposal");
    expect(result.lines.join("\n")).toContain("the older task");
    expect(result.lines.join("\n")).toContain(older.patchPath);
  });

  it("takes a position in the list of holds as a selector", async () => {
    const { repo, stateRoot } = fixture();
    const older = await heldOverlayChange(repo, stateRoot, AGENT_OVERLAY, "older");
    const newer = await heldOverlayChange(
      repo,
      stateRoot,
      "schema_version: 1\nvalidations: {}\n# newest proposal\n",
      "newer",
    );

    const result = runApprovalAction({
      cwd: repo,
      selector: "2",
      holds: [pending(newer, "the newest task"), pending(older, "the older task")],
      now: APPROVED_AT,
    });

    expect(result.approval).toMatchObject({ outcome: "applied", patchPath: older.patchPath });
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(AGENT_OVERLAY);
  });

  it("takes the patch path the reports print as a selector too", async () => {
    const { repo, stateRoot } = fixture();
    const older = await heldOverlayChange(repo, stateRoot, AGENT_OVERLAY, "older");
    const newer = await heldOverlayChange(
      repo,
      stateRoot,
      "schema_version: 1\nvalidations: {}\n# newest proposal\n",
      "newer",
    );

    // Every surface that mentions a hold prints its patch path, so pasting that back is
    // the one selector a user always has to hand.
    const result = runApprovalAction({
      cwd: repo,
      selector: older.patchPath,
      holds: [pending(newer), pending(older)],
      now: APPROVED_AT,
    });

    expect(result.approval).toMatchObject({ outcome: "applied", patchPath: older.patchPath });
  });

  it("refuses a selector that matches nothing and lists what is held", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);
    const before = snapshotTree(repo);

    const result = runApprovalAction({
      cwd: repo,
      selector: "sequence_nothing",
      holds: [pending(held, "the only task")],
      now: APPROVED_AT,
    });

    expect(result.approval).toBeUndefined();
    expect(result.level).toBe("warning");
    expect(result.lines.join("\n")).toContain("sequence_nothing");
    expect(result.lines.join("\n")).toContain(held.patchPath);
    expect(snapshotTree(repo)).toEqual(before);
  });

  it("refuses a selector that matches more than one hold rather than guessing", async () => {
    const { repo, stateRoot } = fixture();
    const older = await heldOverlayChange(repo, stateRoot, AGENT_OVERLAY, "older");
    const newer = await heldOverlayChange(
      repo,
      stateRoot,
      "schema_version: 1\nvalidations: {}\n# newest proposal\n",
      "newer",
    );
    const before = snapshotTree(repo);

    // Both patches live in the same directory, so a directory-ish selector matches both.
    const result = runApprovalAction({
      cwd: repo,
      selector: "governance.patch",
      holds: [pending(newer), pending(older)],
      now: APPROVED_AT,
    });

    expect(result.approval).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(/more than one|ambiguous/i);
    expect(snapshotTree(repo)).toEqual(before);
  });

  it("tells a second approval of the same hold that it was already approved, without touching git", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);
    const settled: GovernanceHold = {
      ...pending(held),
      approval: {
        patchPath: held.patchPath,
        paths: held.paths,
        outcome: "applied",
        at: APPROVED_AT,
      },
    };
    // The patch is deliberately destroyed: if the action reached git at all, the answer
    // would be `missing_patch` instead of the recorded approval.
    rmSync(held.patchPath);

    const result = runApprovalAction({
      cwd: repo,
      selector: held.patchPath,
      holds: [settled],
      now: APPROVED_AT + 5000,
    });

    expect(result.approval).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(/already approved/i);
    expect(result.lines.join("\n")).toContain(new Date(APPROVED_AT).toISOString());
  });
});

/**
 * Approval is the ONLY runtime path from a held patch to the user's checkout. Two
 * different kinds of assertion, because the claim has two halves: what the running
 * system does, and what the code is even able to do.
 */
/**
 * The held patch lives in the runtime state directory, OUTSIDE the repository and
 * outside everything that governs a delegation's writes. So approval trusts the record,
 * not the file: what it agrees to apply is the governance paths the gate recorded, and a
 * patch whose content no longer matches that is refused rather than applied.
 */
describe("approving is bounded by what was actually held", () => {
  it("refuses a patch that touches a path the hold does not name", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);
    // A patch file rewritten to reach outside `.orca/**` — the state directory is not
    // governed, so this is a thing that can happen to the artifact.
    writeFileSync(
      held.patchPath,
      [
        "diff --git a/apps/web/app.tsx b/apps/web/app.tsx",
        "index 0000000..1111111 100644",
        "--- a/apps/web/app.tsx",
        "+++ b/apps/web/app.tsx",
        "@@ -1 +1 @@",
        "-committed app",
        "+tampered",
        "",
      ].join("\n"),
    );
    const before = snapshotTree(repo);

    const result = runApprovalAction({ cwd: repo, holds: [pending(held)], now: APPROVED_AT });

    expect(result.approval?.outcome).toBe("patch_mismatch");
    expect(result.lines.join("\n")).toContain("apps/web/app.tsx");
    expect(snapshotTree(repo)).toEqual(before);
  });

  it("refuses when the repository root cannot be found, rather than applying somewhere", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);
    const outside = makeStateRoot();
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const before = snapshotTree(repo);

    // `git apply` outside a repository happily patches files relative to the current
    // directory, which is the one thing an approval must never do: it lands in the
    // user's checkout or it lands nowhere.
    const result = runApprovalAction({ cwd: outside, holds: [pending(held)], now: APPROVED_AT });

    expect(result.approval?.outcome).toBe("unreadable_repository");
    expect(snapshotTree(repo)).toEqual(before);
    expect(snapshotTree(outside)).toEqual({});
  });
});

describe("nothing else applies a held governance patch", () => {
  it("leaves the governance file untouched through a whole delegation", async () => {
    const { repo, stateRoot } = fixture();
    writeFileSync(join(repo, ".orca", "orca.yaml"), orcaspec.loadFixtureSource("root-recursive-owner"));
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "spec");
    const before = snapshotTree(repo);
    const { createSession } = writesThenCompletes({ ".orca/runtime.yaml": AGENT_OVERLAY });

    // The full steward-facing path: the delegate tool, a real staged worktree, a real
    // session writing through its grant, the gate, the record, the report.
    const result = await createDelegateTool({
      getState: (cwd) => detectRepositoryState(cwd, "enforce"),
      getThinkingLevel: () => "medium",
      createSession,
      stateRoot,
    }).execute(
      "d1",
      { task: "tighten the governance overlay", paths: [".orca/runtime.yaml"] } as never,
      undefined,
      undefined,
      { cwd: repo, model: { id: "fake", provider: "fake" } as unknown as Model<any> } as never,
    );

    const body = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(body).toContain("HELD FOR YOUR APPROVAL");
    // Byte-identical: not one path in the repository moved, governance or otherwise.
    expect(snapshotTree(repo)).toEqual(before);
  });

  it("keeps `git apply` out of every module but the gate and the approval action", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(src)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name: `src/${name}`, text: readFileSync(join(src, name), "utf8") }));
    files.push({
      name: "index.ts",
      text: readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8"),
    });

    // `git apply` writes to the user's checkout, so the set of modules that may run it at
    // all is part of the design: the promotion gate (the promotable half of a delegation)
    // and the approval action (a held patch the user asked for). A third one appearing
    // here is the failure this pins — it means a held patch acquired a second route in.
    const appliers = files.filter((file) => /"apply"/.test(file.text)).map((file) => file.name);
    expect(appliers.sort()).toEqual(["src/approval.ts", "src/staging.ts"]);

    // And in the gate, every `git apply` is handed the PROMOTABLE half. The governance
    // patch is written to disk there and never offered to git.
    const staging = files.find((file) => file.name === "src/staging.ts")!.text;
    const applyCalls = staging.match(/tryGit\([^;]*?"apply"[\s\S]*?\);/g) ?? [];
    expect(applyCalls.length).toBeGreaterThan(0);
    for (const call of applyCalls) {
      expect(call, "the gate may only apply the promotable half").toContain("promotable.patch");
    }
  });
});

/**
 * A selector is raw text a user typed. Each of these is decided here rather than left
 * to whatever `Number()` or a regex would have done with it: none of them may approve
 * anything, and none of them may throw.
 */
describe("a selector that is not a hold", () => {
  const nonsense = [
    { selector: "0", why: "positions start at 1" },
    { selector: "-1", why: "a negative position is not a position" },
    { selector: "2", why: "a position past the end of the list" },
    { selector: "1x", why: "not a number and not an identifier" },
    { selector: ".*", why: "selectors are literal text, never patterns" },
    { selector: "9999999999999999999999", why: "an absurd position" },
  ];

  for (const { selector, why } of nonsense) {
    it(`refuses '${selector}' (${why}) and changes nothing`, async () => {
      const { repo, stateRoot } = fixture();
      const held = await heldOverlayChange(repo, stateRoot);
      const before = snapshotTree(repo);

      const result = runApprovalAction({
        cwd: repo,
        selector,
        holds: [pending(held)],
        now: APPROVED_AT,
      });

      expect(result.approval, `'${selector}' must approve nothing`).toBeUndefined();
      expect(result.level, `'${selector}' is not an approval`).toBe("warning");
      expect(result.lines.length, `'${selector}' must be explained`).toBeGreaterThan(0);
      expect(snapshotTree(repo), `'${selector}' must not touch the checkout`).toEqual(before);
    });
  }
});

describe("approving a change the checkout already contains", () => {
  it("recognizes a patch the user applied by hand instead of blaming drift", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);
    // Phase 2's documented route: the user ran `git apply` themselves.
    git(repo, "apply", held.patchPath);
    const before = snapshotTree(repo);

    const result = runApprovalAction({ cwd: repo, holds: [pending(held)], now: APPROVED_AT });

    // Forward it cannot apply, in REVERSE it applies perfectly — which is what "the
    // content is already here" looks like to git, and it is a settled hold rather than
    // a conflict to go and investigate.
    expect(result.approval?.outcome).toBe("already_applied");
    expect(result.lines.join("\n")).toMatch(/already/i);
    expect(snapshotTree(repo)).toEqual(before);
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(AGENT_OVERLAY);
  });

  it("applies a held governance change exactly once, however often it is approved", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);

    const first = runApprovalAction({ cwd: repo, holds: [pending(held)], now: APPROVED_AT });
    const landed = snapshotTree(repo);
    const second = runApprovalAction({ cwd: repo, holds: [pending(held)], now: APPROVED_AT + 1000 });

    expect(first.approval?.outcome).toBe("applied");
    // Approving the same patch again is not a second application and not an error: the
    // proposal is simply already in the checkout, and nothing moved.
    expect(second.approval?.outcome).toBe("already_applied");
    expect(snapshotTree(repo)).toEqual(landed);
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(AGENT_OVERLAY);
  });
});

describe("approving a patch that is not there to apply", () => {
  it("reports the missing patch file rather than crashing", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);
    // The state directory is not sacred: a user (or a future retention sweep) can
    // remove a patch the record still points at.
    rmSync(held.patchPath);
    const before = snapshotTree(repo);

    const result = runApprovalAction({ cwd: repo, holds: [pending(held)], now: APPROVED_AT });

    expect(result.approval?.outcome).toBe("missing_patch");
    expect(result.level).toBe("warning");
    expect(result.lines.join("\n")).toContain(held.patchPath);
    expect(snapshotTree(repo)).toEqual(before);
  });

  it("reports an empty patch file rather than approving nothing at all", async () => {
    const { repo, stateRoot } = fixture();
    const held = await heldOverlayChange(repo, stateRoot);
    // A truncated artifact. `git apply` accepts empty input happily, which would let
    // an approval claim success over a proposal that no longer exists.
    writeFileSync(held.patchPath, "");

    const result = runApprovalAction({ cwd: repo, holds: [pending(held)], now: APPROVED_AT });

    expect(result.approval?.outcome).toBe("empty_patch");
    expect(result.lines.join("\n")).toMatch(/empty/i);
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(USER_OVERLAY);
  });
});
