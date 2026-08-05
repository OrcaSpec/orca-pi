import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { DomainAgent, OrcaSpecDocument } from "orcaspec";
import { compileGrant } from "../src/resolver";
import {
  runDelegation,
  type DelegationInputs,
  type DelegationSession,
  type DelegationSessionConfig,
} from "../src/delegation";
import {
  captureOverlayBinding,
  commitAuthorizedWork,
  commitStagedBaseline,
  dirtyOverlayPaths,
  promoteStagedCommits,
  stagingPaths,
  type StagingProvider,
} from "../src/staging";
import {
  git,
  headOf,
  makeGitRepo,
  makeStateRoot,
  snapshotTree,
  worktreePathsOf,
} from "./git-fixture";

/**
 * Staged promotion for a single-owner delegation (Phase 2 of the staged-promotion
 * plan): the child runs in an isolated checkout outside the repository, and only
 * its authorized cumulative diff reaches the user's checkout, applied once through
 * `git apply`. Driven offline through the `createSession` seam against real git
 * repositories in temp directories.
 *
 * Since Phase 3 a single owner is the degenerate SEQUENCE — one authorized staged
 * commit, then one promotion — so these tests also pin that the multi-owner
 * transaction did not change what a single owner does.
 *
 * The last group swaps the staging PROVIDER for a second real implementation (a
 * whole-tree copy, the shape a future copy-on-write provider takes) to pin that
 * the promotion gate is provider-independent — and that the injected provider is
 * genuinely the one used.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;

function webAgent(overrides: Partial<DomainAgent> = {}): DomainAgent {
  return {
    id: "web",
    name: "Web",
    description: "Owns the web application.",
    ownership: ["apps/web/**"],
    permissions: { read: { allow: ["docs/**"] }, edit: { allow: ["apps/web/**"] } },
    ...overrides,
  };
}

function doc(agent: DomainAgent): OrcaSpecDocument {
  return {
    spec_version: "0.1",
    repository: { id: "018f4f72-0000-7000-8000-0000000000aa" },
    administration: { approvers: [{ provider: "orca-local", principal: "test" }] },
    steward: { discovery: { read: { allow: ["**"], deny: [] } } },
    protected_denies: {},
    agents: [agent],
  };
}

function inputsFor(cwd: string, overrides: Partial<DelegationInputs> = {}): DelegationInputs {
  const agent = webAgent();
  return {
    document: doc(agent),
    owner: agent.id,
    targets: ["apps/web/app.tsx"],
    grant: compileGrant(agent, {}),
    task: "restyle the button",
    effectiveMode: "enforce",
    cwd,
    parent: { model: fakeModel, thinkingLevel: "high" },
    delegationId: "delegation_staged_test",
    ...overrides,
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

/** A scripted session over the assembled tools; captures every config it built. */
function sessions(script: (config: DelegationSessionConfig) => Promise<void>) {
  const captured: DelegationSessionConfig[] = [];
  const abort = vi.fn();
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    captured.push(config);
    return { prompt: () => script(config), abort };
  };
  return { createSession, captured, abort };
}

/** A repository with one committed file and one uncommitted (dirty) edit. */
function repoWithDirtyOverlay(): string {
  const repo = makeGitRepo("orca-staged-");
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "app.tsx"), "committed\n");
  writeFileSync(join(repo, "docs.md"), "committed docs\n");
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
  writeFileSync(join(repo, "docs.md"), "dirty docs\n");
  writeFileSync(join(repo, "untracked.md"), "untracked note\n");
  return repo;
}

describe("staged single-owner delegation", () => {
  it("runs the child in a worktree outside the repository and promotes the authorized change once", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      let observedDuringRun = "";
      const { createSession, captured } = sessions(async (config) => {
        observedDuringRun = readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8");
        await callTool(config, "write", {
          path: "apps/web/app.tsx",
          content: "<button>staged</button>\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "restyled" });
      });

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The child worked somewhere else entirely: inside the runtime state root,
      // never in the user's checkout.
      expect(captured).toHaveLength(1);
      expect(captured[0].cwd).not.toBe(repo);
      expect(captured[0].cwd.startsWith(stateRoot)).toBe(true);

      // The user's checkout was untouched while the child was running...
      expect(observedDuringRun).toBe("committed\n");
      // ...and carries exactly the promoted change afterwards.
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe(
        "<button>staged</button>\n",
      );
      expect(result.outcome.promotion.status).toBe("promoted");
      expect(result.outcome.promotion.appliedPaths).toEqual(["apps/web/app.tsx"]);

      // The dirty overlay the user had before the delegation survived promotion.
      expect(readFileSync(join(repo, "docs.md"), "utf8")).toBe("dirty docs\n");
      expect(readFileSync(join(repo, "untracked.md"), "utf8")).toBe("untracked note\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("shows the child the user's uncommitted work, not a bare HEAD", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const seen: Record<string, string> = {};
      const { createSession } = sessions(async (config) => {
        seen.dirty = readFileSync(join(config.cwd, "docs.md"), "utf8");
        seen.untracked = readFileSync(join(config.cwd, "untracked.md"), "utf8");
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "looked around" });
      });

      await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(seen.dirty).toBe("dirty docs\n");
      expect(seen.untracked).toBe("untracked note\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("promotes an authorized change while an unauthorized shell write is reverted and recorded", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const { createSession } = sessions(async (config) => {
        await callTool(config, "write", {
          path: "apps/web/app.tsx",
          content: "<button>mine</button>\n",
        });
        await callTool(config, "bash", {
          command: "printf 'stolen\\n' > docs.md; printf 'new\\n' > elsewhere.md",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "did my part" });
      });

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only the owned path was promoted; the out-of-grant paths never made it
      // into the patch, so the user's overlay and untracked tree are intact.
      expect(result.outcome.promotion.status).toBe("promoted");
      expect(result.outcome.promotion.appliedPaths).toEqual(["apps/web/app.tsx"]);
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe(
        "<button>mine</button>\n",
      );
      expect(readFileSync(join(repo, "docs.md"), "utf8")).toBe("dirty docs\n");
      expect(existsSync(join(repo, "elsewhere.md"))).toBe(false);

      // The attempts are still recorded as violation evidence.
      expect(result.outcome.checkpoint.mutationViolations).toEqual([
        expect.objectContaining({ path: "docs.md", source: "shell", disposition: "reverted" }),
        expect.objectContaining({ path: "elsewhere.md", source: "shell", disposition: "reverted" }),
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses the whole delegation when the repository is not a git working tree", async () => {
    const plain = mkdtempSync(join(tmpdir(), "orca-plain-"));
    const stateRoot = makeStateRoot();
    try {
      const { createSession, captured } = sessions(async (config) => {
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "never runs" });
      });

      const result = await runDelegation(inputsFor(plain), { createSession, stateRoot });

      expect(captured).toHaveLength(0);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("staging_unavailable");
      const diagnostics = result.diagnostics.join("\n");
      expect(diagnostics).toContain("not inside a git working tree");
      expect(diagnostics).toMatch(/git init/);
      // Explicit degradation: refused, never silently edited in place.
      expect(diagnostics).toMatch(/refuse/i);
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses a git repository that has no commit to stage from", async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "orca-unborn-")));
    const stateRoot = makeStateRoot();
    try {
      git(empty, "init", "-q");
      const { createSession, captured } = sessions(async () => {});

      const result = await runDelegation(inputsFor(empty), { createSession, stateRoot });

      expect(captured).toHaveLength(0);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("staging_unavailable");
      expect(result.diagnostics.join("\n")).toContain("no commits yet");
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

// --- The staging seam is pluggable -------------------------------------------

/**
 * A second, REAL staging provider: it copies the whole repository (including
 * `.git` and therefore the dirty overlay) instead of adding a linked worktree,
 * then caps it with the shared synthetic baseline. This is the shape a future
 * copy-on-write provider takes (APFS `clonefile` replaces `cpSync`), and it exists
 * here to prove the promotion gate is genuinely provider-independent: it is not a
 * double for the git provider, it is a different way to satisfy the same contract.
 */
const copyStaging: StagingProvider = {
  name: "full-copy",
  open(input) {
    const repoRoot = realpathSync(input.cwd);
    const { dir, patchPath, governancePatchPath, validatorOutputPath } = stagingPaths(input);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    cpSync(repoRoot, dir, { recursive: true, verbatimSymlinks: true });
    return {
      ok: true,
      workspace: {
        repoRoot,
        dir: realpathSync(dir),
        baseCommit: headOf(repoRoot),
        // The base binding is part of the contract, not of one provider's mechanism:
        // the shared helpers digest the same overlay set for any provider.
        overlayBinding: captureOverlayBinding(repoRoot, dirtyOverlayPaths(repoRoot)),
        baselineCommit: commitStagedBaseline(realpathSync(dir)),
        patchPath,
        governancePatchPath,
        validatorOutputPath,
        provider: "full-copy",
      },
    };
  },
  close(workspace) {
    rmSync(workspace.dir, { recursive: true, force: true });
  },
};

describe("staging provider seam", () => {
  it("promotes an authorized change identically under a non-worktree provider", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      // A whole-tree copy carries ignored files across; the worktree provider
      // never does (see `staging.test.ts`). Observing this file inside the child is
      // therefore proof that the INJECTED provider produced the checkout.
      writeFileSync(join(repo, ".gitignore"), "local.env\n");
      writeFileSync(join(repo, "local.env"), "IGNORED=1\n");

      let sawIgnored = false;
      const { createSession, captured } = sessions(async (config) => {
        sawIgnored = existsSync(join(config.cwd, "local.env"));
        // The overlay came across even though no file was copied path-by-path.
        expect(readFileSync(join(config.cwd, "docs.md"), "utf8")).toBe("dirty docs\n");
        await callTool(config, "write", {
          path: "apps/web/app.tsx",
          content: "<button>copied</button>\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      });

      const result = await runDelegation(inputsFor(repo), {
        createSession,
        stateRoot,
        staging: copyStaging,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(sawIgnored).toBe(true);
      expect(captured[0].cwd.startsWith(stateRoot)).toBe(true);
      expect(result.outcome.promotion.status).toBe("promoted");
      expect(result.outcome.promotion.appliedPaths).toEqual(["apps/web/app.tsx"]);
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe(
        "<button>copied</button>\n",
      );
      // No linked worktree was left registered: this provider does not use them.
      expect(worktreePathsOf(repo)).toEqual([repo]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("uses the default git-worktree provider when none is injected", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      writeFileSync(join(repo, ".gitignore"), "local.env\n");
      writeFileSync(join(repo, "local.env"), "IGNORED=1\n");

      let sawIgnored = true;
      let registeredDuringRun: string[] = [];
      const { createSession } = sessions(async (config) => {
        sawIgnored = existsSync(join(config.cwd, "local.env"));
        registeredDuringRun = worktreePathsOf(repo);
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      });

      await runDelegation(inputsFor(repo), { createSession, stateRoot });

      // The worktree provider checks out tracked content only, and registers a
      // real linked worktree with the repository while the child runs.
      expect(sawIgnored).toBe(false);
      expect(registeredDuringRun).toHaveLength(2);
      expect(registeredDuringRun).toContain(join(stateRoot, "worktrees", "delegation_staged_test"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("applies the same authorization gate to a non-worktree provider's checkout", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      // The gate is driven directly, as in `staging.test.ts`: inside a real
      // delegation, mutation accountability would already have reverted this write,
      // so reaching the gate at all requires bypassing that layer.
      const opened = copyStaging.open({
        cwd: repo,
        delegationId: "delegation_staged_test",
        stateRoot,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      writeFileSync(join(opened.workspace.dir, "docs.md"), "smuggled through a copy\n");

      const staged = commitAuthorizedWork(opened.workspace, inputsFor(repo).grant, "web");
      const record = await promoteStagedCommits(opened.workspace, [staged]);

      expect(record.status).toBe("rejected");
      expect(record.rejectedPaths).toEqual(["docs.md"]);
      expect(readFileSync(join(repo, "docs.md"), "utf8")).toBe("dirty docs\n");
      copyStaging.close(opened.workspace);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("closes the provider's checkout on the way out, whichever provider ran", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const { createSession } = sessions(async (config) => {
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      });
      await runDelegation(inputsFor(repo), { createSession, stateRoot, staging: copyStaging });
      expect(existsSync(join(stateRoot, "worktrees", "delegation_staged_test"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

// --- Nothing promoted: the checkout stays byte-identical ----------------------

describe("staged delegation that does not complete", () => {
  for (const status of ["failed", "blocked", "needs_scope"] as const) {
    it(`leaves the checkout byte-identical when the delegation ends '${status}'`, async () => {
      const repo = repoWithDirtyOverlay();
      const stateRoot = makeStateRoot();
      try {
        const before = snapshotTree(repo);
        const { createSession } = sessions(async (config) => {
          await callTool(config, "write", {
            path: "apps/web/app.tsx",
            content: "half-finished\n",
          });
          await callTool(config, "orca_checkpoint", { status, summary: `ended ${status}` });
        });

        const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(snapshotTree(repo)).toEqual(before);
        expect(result.outcome.promotion.status).toBe("not_attempted");
        expect(result.outcome.promotion.appliedPaths).toEqual([]);
        // The abandoned work is still recoverable rather than lost with the worktree.
        expect(readFileSync(result.outcome.promotion.patchPath!, "utf8")).toContain(
          "half-finished",
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(stateRoot, { recursive: true, force: true });
      }
    });
  }

  it("leaves the checkout byte-identical when the parent cancels mid-delegation", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const before = snapshotTree(repo);
      const controller = new AbortController();
      const { createSession, abort } = sessions(async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "interrupted\n" });
        controller.abort();
      });

      const result = await runDelegation(inputsFor(repo), {
        createSession,
        stateRoot,
        signal: controller.signal,
      });

      expect(abort).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.checkpoint.synthesized).toBe(true);
      expect(result.outcome.promotion.status).toBe("not_attempted");
      expect(snapshotTree(repo)).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses to promote and preserves the patch when HEAD moves during the delegation", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const stagedFrom = headOf(repo);
      const { createSession } = sessions(async (config) => {
        await callTool(config, "write", {
          path: "apps/web/app.tsx",
          content: "<button>staged</button>\n",
        });
        // The user commits in their own checkout while the child is working.
        writeFileSync(join(repo, "moved.md"), "a commit landed mid-delegation\n");
        git(repo, "add", "moved.md");
        git(
          repo,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@localhost",
          "commit",
          "-q",
          "-m",
          "user commit during delegation",
        );
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      });

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const promotion = result.outcome.promotion;
      expect(promotion.status).toBe("conflict");
      expect(promotion.appliedPaths).toEqual([]);
      expect(promotion.diagnostics.join("\n")).toContain("HEAD moved");
      expect(promotion.diagnostics.join("\n")).toContain(stagedFrom);

      // Nothing was applied, and the staged work survives as a patch file.
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
      expect(existsSync(promotion.patchPath!)).toBe(true);
      expect(readFileSync(promotion.patchPath!, "utf8")).toContain("<button>staged</button>");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

// --- Cleanup on every exit path ----------------------------------------------

describe("staged workspace cleanup", () => {
  /** Assert no worktree checkout and no `.git/worktrees` metadata survived. */
  function expectNoWorktreeRemains(repo: string, stateRoot: string): void {
    expect(worktreePathsOf(repo)).toEqual([repo]);
    expect(existsSync(join(stateRoot, "worktrees", "delegation_staged_test"))).toBe(false);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
  }

  it("removes the worktree after a completed, promoted delegation", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const { createSession } = sessions(async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "done\n" });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      });
      await runDelegation(inputsFor(repo), { createSession, stateRoot });
      expectNoWorktreeRemains(repo, stateRoot);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("removes the worktree after a failed delegation, keeping the preserved patch", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const { createSession } = sessions(async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "partial\n" });
        await callTool(config, "orca_checkpoint", { status: "failed", summary: "gave up" });
      });
      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });
      expectNoWorktreeRemains(repo, stateRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(existsSync(result.outcome.promotion.patchPath!)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("removes the worktree when assembly fails after staging (required source missing)", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const agent = webAgent({ instructions: { required: [".orca/web/missing.md"], optional: [] } });
      const { createSession, captured } = sessions(async () => {});
      const result = await runDelegation(
        inputsFor(repo, { document: doc(agent), grant: compileGrant(agent, {}) }),
        { createSession, stateRoot },
      );
      expect(captured).toHaveLength(0);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("required_missing");
      expectNoWorktreeRemains(repo, stateRoot);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("removes the worktree when the session factory throws (crash path)", async () => {
    const repo = repoWithDirtyOverlay();
    const stateRoot = makeStateRoot();
    try {
      const createSession = async (): Promise<DelegationSession> => {
        throw new Error("child runtime exploded");
      };
      await expect(
        runDelegation(inputsFor(repo), { createSession, stateRoot }),
      ).rejects.toThrow(/exploded/);
      expectNoWorktreeRemains(repo, stateRoot);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
