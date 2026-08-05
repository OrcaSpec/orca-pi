import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  DELEGATION_ENTRY_TYPE,
} from "../src/delegation-entry";
import { promotionDetailLines, promotionHeadline } from "../src/render";
import { detectRepositoryState } from "../src/state";
import { createDelegateTool } from "../src/tools";
import {
  abandonStagedWork,
  commitAuthorizedWork,
  promoteStagedCommits,
  type PromotionRecord,
  type StagedWorkspace,
} from "../src/staging";
import { gitWorktreeStaging } from "../src/staging-worktree";
import { git, makeGitRepo, makeStateRoot } from "./git-fixture";

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;

/**
 * Governance changes are HELD, never applied (hardening plan, Phase 2).
 *
 * A delegation may be authorized to edit `.orca/**` — that is a per-owner grant
 * question and this phase does not touch it. What this phase adds is a narrowing
 * AFTER authorization: an authorized governance change is written to its own patch
 * in the state directory and waits for the user, because a change to the document
 * that governs the agents is the one change an agent must not land on its own.
 *
 * Driven against real git repositories through the real gate, and every held patch
 * is proved by actually running `git apply` on it — the recovery route is only real
 * if git accepts it.
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

/**
 * The user's own runtime overlay, as valid YAML: a delegation refuses to start
 * against an overlay it cannot read, so the governance file this suite holds changes
 * to has to be a real one.
 */
const USER_OVERLAY = "schema_version: 1\nvalidations: {}\n";

/** What a delegated agent rewrites it to. Held, so the checkout never sees it. */
const AGENT_OVERLAY = "schema_version: 1\nvalidations: {}\n# tightened by the agent\n";

/** A repository holding both a governance document and ordinary source. */
function fixture(): { repo: string; stateRoot: string } {
  const repo = makeGitRepo("orca-held-");
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

/** The gate exactly as a single-owner delegation runs it. */
async function gate(workspace: StagedWorkspace, grant: CompiledGrant): Promise<PromotionRecord> {
  return promoteStagedCommits(workspace, [commitAuthorizedWork(workspace, grant, "governance")]);
}

describe("an authorized governance change is held, not applied", () => {
  it("keeps it out of the checkout and preserves it as a patch git will take", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), AGENT_OVERLAY);

    const record = await gate(workspace, governanceGrant);

    expect(record.heldGovernance?.paths).toEqual([".orca/runtime.yaml"]);
    expect(record.appliedPaths).toEqual([]);
    // The governance document in the user's checkout is exactly as they left it.
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(USER_OVERLAY);

    // The hold is only honest if the work is recoverable, so the patch is proved by
    // running the very command the diagnostics tell the user to run.
    git(repo, "apply", record.heldGovernance!.patchPath);
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(AGENT_OVERLAY);
  });

  it("holds every governance path it touched, whichever they are", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "orca.yaml"), "rewritten spec\n");
    mkdirSync(join(workspace.dir, ".orca", "nested"), { recursive: true });
    writeFileSync(join(workspace.dir, ".orca", "nested", "extra.yaml"), "new\n");

    const record = await gate(workspace, governanceGrant);

    expect(record.heldGovernance?.paths).toEqual([".orca/nested/extra.yaml", ".orca/orca.yaml"]);
    expect(record.appliedPaths).toEqual([]);
  });

  it("reports `held` rather than `promoted` when governance is all there was", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), AGENT_OVERLAY);

    const record = await gate(workspace, governanceGrant);

    // `promoted` is the word the compact history line prints, and nothing was
    // promoted: the delegation's whole change is still waiting for a decision.
    expect(record.status).toBe("held");
    expect(record.patchPath).toBeUndefined();
  });
});

/** An owner authorized over both the governance directory and the application. */
const wideGrant: CompiledGrant = compileGrant(
  {
    id: "wide",
    name: "Wide",
    description: "Owns everything.",
    ownership: ["**"],
    permissions: { edit: { allow: ["**"] } },
  } satisfies DomainAgent,
  {},
);

describe("the rest of the delegation promotes alongside the hold", () => {
  it("applies the non-governance half and holds only the governance half", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "agent app\n");
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), AGENT_OVERLAY);

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, wideGrant, "wide"),
    ]);

    expect(record.status).toBe("promoted");
    expect(record.appliedPaths).toEqual(["apps/web/app.tsx"]);
    expect(record.heldGovernance?.paths).toEqual([".orca/runtime.yaml"]);
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("agent app\n");
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(USER_OVERLAY);
  });

  it("keeps the two patches disjoint, so each applies without the other", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "agent app\n");
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), AGENT_OVERLAY);

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, wideGrant, "wide"),
    ]);

    // The promotable half is already applied; the held patch must still go in on top
    // of it, which is only true because the split is by path and no file is on both
    // sides. Applying it is the whole delegation, landed in two deliberate steps.
    git(repo, "apply", record.heldGovernance!.patchPath);
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(AGENT_OVERLAY);
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("agent app\n");
    // The held patch is exactly the governance change and nothing else.
    expect(readFileSync(record.heldGovernance!.patchPath, "utf8")).not.toContain("app.tsx");
  });
});

/** An owner with no authority over the governance directory at all. */
const webGrant: CompiledGrant = compileGrant(
  {
    id: "web",
    name: "Web",
    description: "Owns the web application.",
    ownership: ["apps/web/**"],
    permissions: { edit: { allow: ["apps/web/**"] } },
  } satisfies DomainAgent,
  {},
);

describe("holding never replaces the authorization it follows", () => {
  it("still refuses an ungranted governance change at the staged commit", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), "not this owner's file\n");

    const staged = commitAuthorizedWork(workspace, webGrant, "web");
    const record = await promoteStagedCommits(workspace, [staged]);

    // Unchanged by this phase: an owner outside its write grant fails its own step,
    // and a failed step fails the whole promotion. Being held for approval is a
    // narrowing that applies to authorized work; it is not a softer landing for
    // unauthorized work.
    expect(staged).toMatchObject({ status: "rejected", rejectedPaths: [".orca/runtime.yaml"] });
    expect(record.status).toBe("rejected");
    expect(record.heldGovernance).toBeUndefined();
    expect(existsSync(join(stateRoot, "patches", "d1.governance.patch"))).toBe(false);
  });

  it("preserves one cumulative evidence patch on a refusal, not a held proposal", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    // Authorized governance work, and an unauthorized path that fails the step with it.
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), AGENT_OVERLAY);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "outside the grant\n");

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, governanceGrant, "governance"),
    ]);

    expect(record.status).toBe("rejected");
    // A proposal to approve, out of a delegation that could not land, is a
    // contradiction: the refusal preserves everything in ONE evidence patch instead.
    expect(record.heldGovernance).toBeUndefined();
    expect(existsSync(join(stateRoot, "patches", "d1.governance.patch"))).toBe(false);
    expect(readFileSync(record.patchPath!, "utf8")).toContain("tightened by the agent");
  });

  it("conflicts on drift in a governance file rather than holding a stale patch", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), AGENT_OVERLAY);
    // The user edits the very governance file the delegation is rewriting.
    writeFileSync(join(repo, ".orca", "runtime.yaml"), "the user's own edit\n");

    const record = await gate(workspace, governanceGrant);

    // The base guard sees the change WHOLE, governance included, so a governance path
    // drifts exactly as any other path does. Holding a patch computed against a base
    // that no longer exists would hand the user something that cannot apply.
    expect(record.status).toBe("conflict");
    expect(record.driftedPaths).toEqual([".orca/runtime.yaml"]);
    expect(record.heldGovernance).toBeUndefined();
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe("the user's own edit\n");
  });

  it("holds nothing for a delegation that never reached the gate", () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), "unfinished\n");

    const record = abandonStagedWork(workspace, "the delegation ended 'failed'.");

    expect(record.status).toBe("not_attempted");
    expect(record.heldGovernance).toBeUndefined();
    expect(existsSync(join(stateRoot, "patches", "d1.governance.patch"))).toBe(false);
    expect(readFileSync(record.patchPath!, "utf8")).toContain("unfinished");
  });
});

describe("a delegation that touches no governance path", () => {
  it("promotes as it always did and leaves no governance artifact behind", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "agent app\n");

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, wideGrant, "wide"),
    ]);

    expect(record).toMatchObject({ status: "promoted", appliedPaths: ["apps/web/app.tsx"] });
    expect(record.heldGovernance).toBeUndefined();
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("agent app\n");
    // The ordinary case is the one that must not have changed at all: no extra file in
    // the state directory, and the report reads word for word as it did before holding
    // existed.
    expect(existsSync(join(stateRoot, "patches"))).toBe(false);
    expect(promotionHeadline(record)).toBe(
      "Promotion: promoted — 1 path(s) applied to your checkout.",
    );
    expect(promotionDetailLines(record)).toEqual([
      "  Promoted 1 authorized path(s) to your checkout as unstaged changes.",
    ]);
  });
});

/**
 * Where the boundary actually falls. `.orca/**` is a root-anchored directory prefix,
 * and each of these is a path a repository can really contain that sits just inside
 * or just outside it — decided here rather than left to whatever git happens to do.
 */
describe("the edge of the governance boundary", () => {
  it("holds a change to the governance directory's own path when it is a file", async () => {
    const { repo, stateRoot } = fixture();
    rmSync(join(repo, ".orca"), { recursive: true, force: true });
    writeFileSync(join(repo, ".orca"), "a file, not a directory\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "flatten");

    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca"), "rewritten\n");

    const record = await gate(workspace, governanceGrant);

    // `.orca` itself is inside the scope `.orca/**` (see `matchScope`), and a
    // repository that keeps its governance in one file is governed no less.
    expect(record.heldGovernance?.paths).toEqual([".orca"]);
    expect(readFileSync(join(repo, ".orca"), "utf8")).toBe("a file, not a directory\n");
  });

  it("promotes a path that merely starts with the directory's name", async () => {
    const { repo, stateRoot } = fixture();
    mkdirSync(join(repo, ".orca-backup"), { recursive: true });
    writeFileSync(join(repo, ".orca-backup", "old.yaml"), "committed\n");
    writeFileSync(join(repo, ".orcarc"), "committed\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "near");

    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca-backup", "old.yaml"), "agent edit\n");
    writeFileSync(join(workspace.dir, ".orcarc"), "agent edit\n");

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, wideGrant, "wide"),
    ]);

    expect(record.status).toBe("promoted");
    expect(record.appliedPaths).toEqual([".orca-backup/old.yaml", ".orcarc"]);
    expect(record.heldGovernance).toBeUndefined();
  });

  it("promotes a nested directory of the same name, since the scope is root-anchored", async () => {
    const { repo, stateRoot } = fixture();
    mkdirSync(join(repo, "packages", "inner", ".orca"), { recursive: true });
    writeFileSync(join(repo, "packages", "inner", ".orca", "orca.yaml"), "committed\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "nested");

    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "packages", "inner", ".orca", "orca.yaml"), "agent edit\n");

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, wideGrant, "wide"),
    ]);

    // Only the repository root's `.orca` governs this repository; a nested one is
    // some other package's business and is ordinary content here.
    expect(record.appliedPaths).toEqual(["packages/inner/.orca/orca.yaml"]);
    expect(record.heldGovernance).toBeUndefined();
  });

  it("holds a governance DELETION, so removing the spec needs approval too", async () => {
    const { repo, stateRoot } = fixture();
    const workspace = open(repo, stateRoot);
    rmSync(join(workspace.dir, ".orca", "runtime.yaml"));

    const record = await gate(workspace, governanceGrant);

    expect(record.status).toBe("held");
    expect(record.heldGovernance?.paths).toEqual([".orca/runtime.yaml"]);
    expect(existsSync(join(repo, ".orca", "runtime.yaml"))).toBe(true);
    // The deletion is real work, and the held patch performs it when applied.
    git(repo, "apply", record.heldGovernance!.patchPath);
    expect(existsSync(join(repo, ".orca", "runtime.yaml"))).toBe(false);
  });

  it("holds a binary governance file byte-for-byte", async () => {
    const { repo, stateRoot } = fixture();
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x7f]);
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, ".orca", "seal.bin"), bytes);

    const record = await gate(workspace, governanceGrant);

    expect(record.heldGovernance?.paths).toEqual([".orca/seal.bin"]);
    git(repo, "apply", record.heldGovernance!.patchPath);
    expect(readFileSync(join(repo, ".orca", "seal.bin"))).toEqual(bytes);
  });

  it("refuses the whole promotion when the hold cannot be written", async () => {
    const { repo, stateRoot } = fixture();
    // The patch directory's path is occupied by a file, so nothing can be written
    // inside it — a stand-in for any state directory the runtime cannot write to.
    writeFileSync(join(stateRoot, "patches"), "in the way\n");
    const workspace = open(repo, stateRoot);
    writeFileSync(join(workspace.dir, "apps", "web", "app.tsx"), "agent app\n");
    writeFileSync(join(workspace.dir, ".orca", "runtime.yaml"), AGENT_OVERLAY);

    const record = await promoteStagedCommits(workspace, [
      commitAuthorizedWork(workspace, wideGrant, "wide"),
    ]);

    // Landing the promotable half while silently dropping the governance change is
    // the one outcome that loses authorized work, so nothing lands at all.
    expect(record.status).toBe("rejected");
    expect(record.diagnostics.join("\n")).toMatch(/could not be held for your approval/);
    // The same unwritable directory defeats the evidence patch, and the refusal says
    // so rather than claiming a preserved patch or an empty delegation.
    expect(record.diagnostics.join("\n")).toMatch(/could NOT be preserved either/);
    expect(record.patchPath).toBeUndefined();
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed app\n");
  });
});

/**
 * The whole path a steward actually walks: a real delegated session writing a
 * governance file through its grant-wrapped tools, the sequence's one promotion, the
 * durable record, and the `/orca` history rendered from it. Nothing here is driven at
 * the gate; the point is that the hold survives every layer above it.
 */
const monolithDoc = orcaspec.loadFixture("root-recursive-owner");

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
    parent: { model: fakeModel, thinkingLevel: "high" },
  };
}

/** A scripted owner that writes the given files, then checkpoints completed. */
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

describe("what the steward is told about a hold", () => {
  it("names the patch, the paths, and the apply hint in the delegation's own report", async () => {
    const { repo, stateRoot } = fixture();
    const inputs = monolithInputs(repo, [".orca/runtime.yaml"]);
    const { createSession } = writesThenCompletes({ ".orca/runtime.yaml": AGENT_OVERLAY });

    const sequence = await runDelegationSequence([inputs], { createSession, stateRoot });

    const promotion = sequence.promotion;
    expect(promotion.status).toBe("held");
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(USER_OVERLAY);

    const report = [promotionHeadline(promotion), ...promotionDetailLines(promotion)].join("\n");
    expect(report).toContain("HELD");
    expect(report).toContain(".orca/runtime.yaml");
    expect(report).toContain(`git apply ${promotion.heldGovernance!.patchPath}`);
    expect(report).toContain(promotion.heldGovernance!.baseCommit);
  });

  it("says the same thing in the `/orca` history, from the durable record alone", async () => {
    const { repo, stateRoot } = fixture();
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
    });

    // The record is the only thing that outlives the session, so the route to the
    // pending patch has to be in it — a resumed session rebuilds history from
    // entries alone.
    const history = new DelegationHistory();
    history.rebuildFrom([
      { type: "custom", customType: DELEGATION_ENTRY_TYPE, data: JSON.parse(JSON.stringify(record)) },
    ]);

    const detail = history.lastDetailLines().join("\n");
    expect(detail).toContain("HELD FOR YOUR APPROVAL");
    expect(detail).toContain(".orca/runtime.yaml");
    expect(detail).toContain(`git apply ${sequence.promotion.heldGovernance!.patchPath}`);
    // And the compact line does not call it a promotion.
    expect(history.statusLines().join("\n")).toContain("promotion: held");
  });

  it("names the hold even when other paths did land", async () => {
    const { repo, stateRoot } = fixture();
    const inputs = monolithInputs(repo, [".orca/runtime.yaml", "apps/web/app.tsx"]);
    const { createSession } = writesThenCompletes({
      ".orca/runtime.yaml": AGENT_OVERLAY,
      "apps/web/app.tsx": "agent app\n",
    });

    const sequence = await runDelegationSequence([inputs], { createSession, stateRoot });

    expect(sequence.promotion.status).toBe("promoted");
    expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("agent app\n");
    // The owner's own view of the sequence's one promotion must carry the hold too:
    // a single-owner delegation reports through it, and "promoted" on its own would
    // let a steward close the report believing everything landed.
    const step = sequence.steps[0];
    if (step.kind !== "delegated") throw new Error("expected a delegated step");
    const owned = [
      promotionHeadline(step.outcome.promotion),
      ...promotionDetailLines(step.outcome.promotion),
    ].join("\n");
    expect(owned).toContain("HELD");
    expect(owned).toContain(".orca/runtime.yaml");
  });

  it("treats an in-grant governance write as ordinary work, not a mutation violation", async () => {
    const { repo, stateRoot } = fixture();
    const inputs = monolithInputs(repo, [".orca/runtime.yaml"]);
    const { createSession } = writesThenCompletes({ ".orca/runtime.yaml": AGENT_OVERLAY });

    const sequence = await runDelegationSequence([inputs], { createSession, stateRoot });

    const step = sequence.steps[0];
    if (step.kind !== "delegated") throw new Error("expected a delegated step");
    // Accountability is about authority, and this write had it: the file was written
    // in staging, reported in the manifest, and reverted by nothing. Only promotion
    // holds it.
    expect(step.outcome.checkpoint.mutationViolations ?? []).toEqual([]);
    expect(step.outcome.checkpoint.changedPaths).toEqual([".orca/runtime.yaml"]);
  });

  it("leads the `orca_delegate` result with the hold, not with what landed", async () => {
    const { repo, stateRoot } = fixture();
    // The steward-facing tool reads the spec off the checkout, so the fixture needs a
    // real one; this is the surface a human actually sees when a delegation ends.
    writeFileSync(
      join(repo, ".orca", "orca.yaml"),
      orcaspec.loadFixtureSource("root-recursive-owner"),
    );
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=F", "-c", "user.email=f@localhost", "commit", "-q", "-m", "spec");
    const { createSession } = writesThenCompletes({ ".orca/runtime.yaml": AGENT_OVERLAY });

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
      { cwd: repo, model: fakeModel } as never,
    );

    const body = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(body).toContain("HELD");
    expect(body).toContain("HELD FOR YOUR APPROVAL");
    expect(body).toContain("git apply ");
    expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toBe(USER_OVERLAY);
  });
});
