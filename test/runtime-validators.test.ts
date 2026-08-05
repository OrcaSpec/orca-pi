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

  it("kills and refuses a validator that outlives its declared timeout", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          // A validator that would never return on its own; the declared budget is
          // what ends it, so the promotion cannot hang on a wedged check.
          web: [nodeValidator("setTimeout(() => {}, 600000);", { timeout_seconds: 0.25 })],
        },
      });
      const before = snapshotTree(repo);
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const promotion = result.outcome.promotion;
      expect(promotion.validations[0].status).toBe("timed_out");
      expect(promotion.status).toBe("rejected");
      expect(promotion.diagnostics.join("\n")).toContain("TIMED OUT after 0.25s");
      expect(snapshotTree(repo)).toEqual(before);
      expect(readFileSync(promotion.patchPath!, "utf8")).toContain("reviewed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses when a declared validator cannot be run at all", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [{ program: "orca-no-such-validator-program", timeout_seconds: 5 }],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A declared check that could not run is not a check that passed.
      expect(result.outcome.promotion.validations[0].status).toBe("unavailable");
      expect(result.outcome.promotion.status).toBe("rejected");
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("stops at the first validator that fails and reports the ones it never ran", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const trail = join(stateRoot, "trail.txt");
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            nodeValidator(`require('fs').appendFileSync(${JSON.stringify(trail)}, 'first\\n');`),
            nodeValidator(
              `require('fs').appendFileSync(${JSON.stringify(trail)}, 'second\\n');` +
                "process.exit(1);",
            ),
            nodeValidator(`require('fs').appendFileSync(${JSON.stringify(trail)}, 'third\\n');`),
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Declaration order, and nothing after the refusal.
      expect(readFileSync(trail, "utf8")).toBe("first\nsecond\n");
      expect(result.outcome.promotion.validations.map((run) => run.status)).toEqual([
        "passed",
        "failed",
      ]);
      expect(result.outcome.promotion.diagnostics.join("\n")).toContain(
        "1 later validator(s) were not run",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("a validator cannot smuggle changes into the promotion", () => {
  it("promotes the committed work, never what the validator wrote afterwards", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            // A "validator" that rewrites the owner's own file (a formatter would),
            // adds a file of its own, and deletes a committed one — all inside its
            // grant's paths, all after the authorized change was committed.
            nodeValidator(
              "const fs = require('fs');" +
                "fs.writeFileSync('apps/web/app.tsx', 'rewritten by the validator\\n');" +
                "fs.writeFileSync('apps/web/validator-artifact.txt', 'dropped in\\n');",
            ),
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.promotion.status).toBe("promoted");
      // Only the committed path is promoted, with the content the AGENT committed.
      expect(result.outcome.promotion.appliedPaths).toEqual(["apps/web/app.tsx"]);
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("reviewed\n");
      expect(existsSync(join(repo, "apps", "web", "validator-artifact.txt"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("promotes nothing a validator committed for itself in the staged checkout", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            // A validator is arbitrary code running in a real git working tree, so it
            // can make a commit of its own. The promoted patch is pinned to the tip
            // that existed before the gate ran, so this one is not in it.
            nodeValidator(
              "const cp = require('child_process');" +
                "require('fs').writeFileSync('apps/web/app.tsx', 'committed by the validator\\n');" +
                "cp.execFileSync('git', ['add', '-A']);" +
                "cp.execFileSync('git', ['-c', 'user.name=V', '-c', 'user.email=v@localhost'," +
                " 'commit', '-q', '-m', 'validator commit']);",
            ),
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.promotion.status).toBe("promoted");
      expect(result.outcome.promotion.appliedPaths).toEqual(["apps/web/app.tsx"]);
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("reviewed\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("preserves the delegation's own work, not the validator's, when the gate refuses", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            nodeValidator(
              "const fs = require('fs');" +
                "fs.writeFileSync('apps/web/app.tsx', 'reformatted by the validator\\n');" +
                "fs.writeFileSync('validator-scratch.txt', 'noise\\n');" +
                "process.exit(1);",
            ),
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.promotion.status).toBe("rejected");
      // The evidence a user would re-apply is the delegation's work, with none of
      // the validator's leftovers mixed into it.
      const patch = readFileSync(result.outcome.promotion.patchPath!, "utf8");
      expect(patch).toContain("reviewed");
      expect(patch).not.toContain("reformatted by the validator");
      expect(patch).not.toContain("validator-scratch.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("validator arguments are data, never a command line", () => {
  it("passes shell metacharacters through verbatim as inert argv elements", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const dumped = join(stateRoot, "argv.json");
    const hostile = [
      "; rm -rf /",
      "$(touch pwned)",
      "`touch pwned2`",
      "&& echo chained",
      "| tee /dev/null",
      "one two",
      "'quoted'",
      '"double"',
      "new\nline",
      "*",
    ];
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            {
              program: process.execPath,
              args: [
                "-e",
                `require('fs').writeFileSync(${JSON.stringify(dumped)}, JSON.stringify(process.argv.slice(1)));`,
                ...hostile,
              ],
              timeout_seconds: 10,
            },
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The program received exactly the declared strings: nothing was expanded,
      // split on whitespace, glob-matched, or chained into a second command.
      expect(JSON.parse(readFileSync(dumped, "utf8"))).toEqual(hostile);
      expect(result.outcome.promotion.status).toBe("promoted");
      expect(result.outcome.promotion.validations[0].args.slice(2)).toEqual(hostile);
      // ...and no side effect a shell would have produced exists anywhere.
      expect(existsSync(join(repo, "pwned"))).toBe(false);
      expect(existsSync(join(repo, "pwned2"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("a malformed overlay blocks the delegation instead of skipping the checks", () => {
  /** Every shape of breakage refuses the same way: before anything runs. */
  const broken: Array<{ name: string; source: string; expect: RegExp }> = [
    {
      name: "an unknown field",
      source: "schema_version: 1\nvalidation: {}\n",
      expect: /overlay\.unknown_field/,
    },
    {
      name: "an agent id the document does not declare",
      source: "schema_version: 1\nvalidations:\n  mobile:\n    - program: t\n      timeout_seconds: 5\n",
      expect: /overlay\.unknown_agent/,
    },
    {
      name: "a field of the wrong type",
      source: 'schema_version: 1\nvalidations:\n  web:\n    - program: t\n      timeout_seconds: "5"\n',
      expect: /overlay\.invalid_type/,
    },
    {
      name: "an unsupported schema version",
      source: "schema_version: 9\n",
      expect: /overlay\.unsupported_schema_version/,
    },
  ];

  for (const { name, source, expect: pattern } of broken) {
    it(`refuses to start a delegation whose overlay has ${name}`, async () => {
      const repo = repoWithApp();
      const stateRoot = makeStateRoot();
      try {
        mkdirSync(join(repo, ".orca"), { recursive: true });
        writeFileSync(join(repo, ".orca", "runtime.yaml"), source);
        const before = snapshotTree(repo);
        const { createSession, captured } = sessions(writeAndComplete);

        const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe("invalid_runtime_overlay");
        expect(result.diagnostics.join("\n")).toMatch(pattern);
        expect(result.diagnostics.join("\n")).toContain(join(repo, ".orca", "runtime.yaml"));
        // Blocked, not unvalidated: no child ran, no checkout was staged, and the
        // user's files are exactly as they were.
        expect(captured).toHaveLength(0);
        expect(existsSync(join(stateRoot, "worktrees"))).toBe(false);
        expect(snapshotTree(repo)).toEqual(before);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(stateRoot, { recursive: true, force: true });
      }
    });
  }
});

describe("an overlay configures validation and nothing else", () => {
  it("cannot make an unauthorized path promotable, however happily its validators pass", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: { web: [nodeValidator("process.exit(0);")] },
      });
      const before = snapshotTree(repo);
      const { createSession } = sessions(async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "mine\n" });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
        // Straight into the checkout after the checkpoint's reconciliation, the way
        // the Phase 3 gate test does it: what has to hold is the gate, not the layer
        // above it.
        writeFileSync(join(config.cwd, "outside.md"), "not mine\n");
      });

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A passing acceptance gate is not authority: the unauthorized path still
      // fails the whole promotion.
      expect(result.outcome.promotion.status).toBe("rejected");
      expect(result.outcome.promotion.rejectedPaths).toEqual(["outside.md"]);
      expect(snapshotTree(repo)).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("leaves the compiled tool set and its refusals identical to a repository with no overlay", async () => {
    const stateRoot = makeStateRoot();
    const plain = repoWithApp();
    const overlaid = repoWithApp();
    try {
      writeOverlay(overlaid, {
        schema_version: 1,
        validations: { web: [nodeValidator("process.exit(0);")] },
      });
      const refusals: Record<string, string> = {};
      const observe = (label: string) => async (config: DelegationSessionConfig) => {
        try {
          await callTool(config, "write", { path: "services/billing/x.rb", content: "not mine\n" });
          refusals[label] = "allowed";
        } catch (error) {
          refusals[label] = error instanceof Error ? error.message : String(error);
        }
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      };

      const withoutOverlay = sessions(observe("plain"));
      await runDelegation(inputsFor(plain), {
        createSession: withoutOverlay.createSession,
        stateRoot,
      });
      const withOverlay = sessions(observe("overlaid"));
      await runDelegation(inputsFor(overlaid), {
        createSession: withOverlay.createSession,
        stateRoot,
      });

      // Same tools, same grant, same refusal: the overlay is not in that path at all.
      expect(withOverlay.captured[0].toolNames).toEqual(withoutOverlay.captured[0].toolNames);
      expect(refusals.overlaid).toBe(refusals.plain);
      expect(refusals.overlaid).toMatch(/services\/billing\/x\.rb/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(overlaid, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("ignores an overlay rewritten in staging by an agent whose grant covers it", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      // The user's overlay declares a validator that refuses this work.
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [nodeValidator("process.stderr.write('policy says no');process.exit(1);")],
        },
      });
      // This agent's write grant genuinely covers the overlay, so its rewrite is
      // AUTHORIZED and committed in staging — the hardest version of the question.
      const overlayOwner: DomainAgent = {
        ...webAgent(),
        permissions: {
          read: { allow: ["docs/**"] },
          edit: { allow: ["apps/web/**", ".orca/**"] },
        },
      };
      const { createSession } = sessions(async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "reviewed\n" });
        // Rewriting the checks it will be judged by, through its own tools.
        await callTool(config, "write", {
          path: ".orca/runtime.yaml",
          content: "schema_version: 1\nvalidations: {}\n",
        });
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      });

      const result = await runDelegation(
        inputsFor(repo, {
          document: { ...doc(), agents: [overlayOwner] },
          grant: compileGrant(overlayOwner, {}),
        }),
        { createSession, stateRoot },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The overlay that gates a delegation is the USER's, read before it started:
      // an agent cannot relax its own acceptance gate, even by an authorized edit.
      expect(result.outcome.promotion.validations[0].stderr).toContain("policy says no");
      expect(result.outcome.promotion.status).toBe("rejected");
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
      // The overlay in the user's checkout is untouched too, because nothing was
      // promoted at all.
      expect(readFileSync(join(repo, ".orca", "runtime.yaml"), "utf8")).toContain(
        "policy says no",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("ignores an overlay that appears in the checkout as the child is torn down", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [nodeValidator("process.stderr.write('policy says no');process.exit(1);")],
        },
      });
      const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => ({
        prompt: () => writeAndComplete(config),
        abort: vi.fn(),
        // After the authorized change is committed and before the gate runs — the
        // last moment anything could hope to influence it.
        finish: async () => {
          writeFileSync(
            join(config.cwd, ".orca", "runtime.yaml"),
            "schema_version: 1\nvalidations: {}\n",
          );
        },
      });

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.promotion.validations[0].stderr).toContain("policy says no");
      expect(result.outcome.promotion.status).toBe("rejected");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("the agent's own validation report is advisory, the declared validators are not", () => {
  it("promotes work whose checkpoint reports failed validation when nothing is declared", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      const { createSession } = sessions(async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "reviewed\n" });
        await callTool(config, "orca_checkpoint", {
          status: "completed",
          summary: "done, but my own test run was red",
          validation_activities: [
            { kind: "test", name: "unit", command: "npm test", status: "failed" },
          ],
        });
      });

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The agent's account is METADATA: it is recorded, surfaced to the steward,
      // and gates nothing. Only a program Orca ran itself can refuse a promotion.
      expect(result.outcome.checkpoint.validation.status).toBe("failed");
      expect(result.outcome.appendEntry.validation.status).toBe("failed");
      expect(result.outcome.promotion.status).toBe("promoted");
      expect(result.outcome.promotion.validations).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses work whose checkpoint claims passing validation when a declared validator disagrees", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: { web: [nodeValidator("process.exit(1);")] },
      });
      const { createSession } = sessions(async (config) => {
        await callTool(config, "write", { path: "apps/web/app.tsx", content: "reviewed\n" });
        await callTool(config, "orca_checkpoint", {
          status: "completed",
          summary: "all green, promise",
          validation_activities: [
            { kind: "test", name: "unit", command: "npm test", status: "passed" },
          ],
        });
      });

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.checkpoint.validation.status).toBe("passed");
      expect(result.outcome.promotion.status).toBe("rejected");
      expect(readFileSync(join(repo, "apps", "web", "app.tsx"), "utf8")).toBe("committed\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("a validator sees the sequence's complete, committed work", () => {
  it("runs against the content the owner committed, so it can accept or refuse it", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            // The validator is the assertion: it exits non-zero unless the file it
            // reads holds exactly what the agent wrote.
            nodeValidator(
              "const seen = require('fs').readFileSync('apps/web/app.tsx', 'utf8');" +
                "process.stdout.write(seen);" +
                "process.exit(seen === 'reviewed\\n' ? 0 : 9);",
            ),
          ],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.promotion.validations[0].stdout).toBe("reviewed\n");
      expect(result.outcome.promotion.status).toBe("promoted");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("a validator runs where the overlay says", () => {
  it("runs in the declared repository-relative directory inside the staged checkout", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    const observed = join(stateRoot, "where.txt");
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [
            nodeValidator(
              `require('fs').writeFileSync(${JSON.stringify(observed)}, process.cwd());`,
              { cwd: "apps/web" },
            ),
          ],
        },
      });
      const { createSession, captured } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.promotion.status).toBe("promoted");
      expect(readFileSync(observed, "utf8")).toBe(join(captured[0].cwd, "apps", "web"));
      expect(result.outcome.promotion.validations[0].cwd).toBe("apps/web");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses when the declared directory does not exist in the checkout", async () => {
    const repo = repoWithApp();
    const stateRoot = makeStateRoot();
    try {
      writeOverlay(repo, {
        schema_version: 1,
        validations: {
          web: [nodeValidator("process.exit(0);", { cwd: "packages/nowhere" })],
        },
      });
      const { createSession } = sessions(writeAndComplete);

      const result = await runDelegation(inputsFor(repo), { createSession, stateRoot });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.promotion.validations[0].status).toBe("unavailable");
      expect(result.outcome.promotion.status).toBe("rejected");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
