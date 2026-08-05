import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainAgent } from "orcaspec";
import { compileGrant, type CompiledGrant } from "../src/resolver";
import {
  commitAuthorizedWork,
  promoteStagedCommits,
  type HeldGovernance,
  type StagedWorkspace,
} from "../src/staging";
import { gitWorktreeStaging } from "../src/staging-worktree";
import { runApprovalAction, type GovernanceHold } from "../src/approval";
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
