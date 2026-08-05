import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { git, makeGitRepo, makeStateRoot, snapshotTree } from "./git-fixture";

/**
 * Structured validators as the acceptance gate (staged-promotion plan, Phase 4):
 * `.orca/runtime.yaml` declares per-agent validator programs, they run inside the
 * staged checkout after the last owner completes and before promotion, and a
 * failing one refuses the promotion.
 *
 * The validators here are REAL child processes (`node -e "..."`), because
 * execution, timeout, output capture, and the working directory a validator runs
 * in are exactly what has to hold — a doubled runner would assert none of it.
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

function inputsFor(cwd: string, overrides: Partial<DelegationInputs> = {}): DelegationInputs {
  return {
    document: doc(),
    owner: "web",
    targets: ["apps/web/app.tsx"],
    grant: compileGrant(webAgent(), {}),
    task: "restyle the button",
    effectiveMode: "enforce",
    cwd,
    parent: { model: fakeModel, thinkingLevel: "high" },
    delegationId: "delegation_validator_test",
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
  const repo = makeGitRepo("orca-validators-");
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

/** Write `.orca/runtime.yaml` as real YAML text, the way a user would author it. */
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

/** The scripted owner: one authorized write, then a completed checkpoint. */
const writeAndComplete = async (config: DelegationSessionConfig): Promise<void> => {
  await callTool(config, "write", { path: "apps/web/app.tsx", content: "reviewed\n" });
  await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
};

describe("declared validators gate the promotion", () => {
  it("promotes the staged change when every validator passes, and records what ran", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const observed = join(stateRoot, "validator-cwd.txt");
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            nodeValidator(
              `require('fs').writeFileSync(${JSON.stringify(observed)}, process.cwd());` +
                "process.stdout.write('suite green');",
            ),
          ],
        },
      });
      const { createSession, captured } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The validator passed, so the authorized change reached the checkout.
      expect(result.outcome.promotion.status).toBe("promoted");
      expect(result.outcome.promotion.appliedPaths).toEqual(["apps/web/app.tsx"]);
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("reviewed\n");
      // It ran inside the staged checkout, not the user's repository.
      expect(readFileSync(observed, "utf8")).toBe(captured[0].cwd);
      // ...and what ran is recorded on the delegation entry, with its output.
      const runs = result.outcome.appendEntry.promotion.validations;
      expect(runs).toHaveLength(1);
      expect(runs[0].agent).toBe("web");
      expect(runs[0].status).toBe("passed");
      expect(runs[0].exitCode).toBe(0);
      expect(runs[0].stdout).toContain("suite green");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses the promotion when a validator fails, preserving the patch and the output", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            nodeValidator(
              "process.stderr.write('2 tests failed');process.exit(3);",
            ),
          ],
        },
      });
      const before = snapshotTree(repo);
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const promotion = result.outcome.promotion;
      expect(promotion.status).toBe("rejected");
      // The checkout is byte-identical: a failed validator promotes nothing.
      expect(snapshotTree(repo)).toEqual(before);
      // The work survives as a patch...
      expect(readFileSync(promotion.patchPath!, "utf8")).toContain("reviewed");
      // ...and so does the validator's own evidence, in the state directory.
      expect(promotion.validations[0].status).toBe("failed");
      expect(promotion.validations[0].exitCode).toBe(3);
      expect(promotion.validations[0].stderr).toContain("2 tests failed");
      expect(readFileSync(promotion.validatorOutputPath!, "utf8")).toContain("2 tests failed");
      expect(promotion.diagnostics.join("\n")).toMatch(/validator/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
