import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import type { DomainAgent, OrcaSpecDocument } from "orcaspec";
import { compileGrant, resolve } from "../src/resolver";
import {
  runDelegationSequence,
  stepCompleted,
  type DelegationInputs,
  type DelegationSession,
  type DelegationSessionConfig,
} from "../src/delegation";

/**
 * The pure multi-owner sequence runner (ADR 0006, 0009, 0077, 0083) and the
 * structural grant-immutability guarantee (ADR 0008), both driven offline
 * through the injected `createSession` seam.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;
const doc = orcaspec.loadFixture("multi-owner");

const OWNED: Record<string, string> = {
  billing: "services/billing/x.rb",
  web: "apps/web/app.tsx",
  "design-system": "apps/web/components/button.tsx",
  infra: "infra/main.tf",
};

const parent = { model: fakeModel, thinkingLevel: "high" as const };

/** Build one DelegationInputs per resolved owner, in the resolver's order. */
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

async function callTool(config: DelegationSessionConfig, name: string, params: unknown): Promise<void> {
  const tool = config.tools.find((t) => t.name === name)!;
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

type Script = (config: DelegationSessionConfig) => Promise<void>;

function sessions(scripts: Record<string, Script>, fallback?: Script) {
  const captured: DelegationSessionConfig[] = [];
  const abort = vi.fn();
  const createSession = vi.fn(async (config: DelegationSessionConfig): Promise<DelegationSession> => {
    captured.push(config);
    const script =
      scripts[config.owner] ??
      fallback ??
      (async (c: DelegationSessionConfig) => {
        await callTool(c, "write", { path: OWNED[c.owner], content: `// ${c.owner}` });
        await callTool(c, "orca_checkpoint", { status: "completed", summary: "done" });
      });
    return { prompt: () => script(config), abort };
  });
  return { createSession, captured, abort };
}

describe("runDelegationSequence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-seq-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs owners strictly sequentially in order, never interleaved", async () => {
    const events: string[] = [];
    const track: Script = async (config) => {
      events.push(`${config.owner}:start`);
      await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
      events.push(`${config.owner}:end`);
    };
    const { createSession } = sessions({ billing: track, web: track, infra: track });
    const seq = await runDelegationSequence(
      orderedFor(dir, ["apps/web/app.tsx", "services/billing/x.rb", "infra/main.tf"]),
      { createSession },
    );
    // Each owner starts only after the previous one ends (no interleave).
    expect(events).toEqual([
      "billing:start",
      "billing:end",
      "infra:start",
      "infra:end",
      "web:start",
      "web:end",
    ]);
    expect(seq.allCompleted).toBe(true);
    expect(seq.stoppedAt).toBeUndefined();
    expect(seq.cancelled).toBe(false);
    expect(seq.steps.map(stepCompleted)).toEqual([true, true, true]);
  });

  it("gives each owner its own distinct, correct grant (no authority merge)", async () => {
    const { createSession, captured } = sessions({});
    await runDelegationSequence(orderedFor(dir, ["apps/web/app.tsx", "services/billing/x.rb"]), {
      createSession,
    });
    const resolution = resolve(doc, ["apps/web/app.tsx", "services/billing/x.rb"]);
    const billing = resolution.delegations.find((d) => d.owner === "billing")!.grant;
    const web = resolution.delegations.find((d) => d.owner === "web")!.grant;
    expect(billing.write.allow).toEqual(["services/billing/**"]);
    expect(web.write.allow).toEqual(["apps/web/**"]);
    expect(billing).not.toBe(web);
    expect(captured.map((c) => c.owner)).toEqual(["billing", "web"]);
  });

  for (const status of ["needs_scope", "blocked", "failed"] as const) {
    it(`stops the sequence on a first-owner ${status} status and leaves the rest not run`, async () => {
      const { createSession, captured } = sessions({
        billing: async (config) => {
          await callTool(config, "orca_checkpoint", { status, summary: status });
        },
      });
      const seq = await runDelegationSequence(
        orderedFor(dir, ["apps/web/app.tsx", "services/billing/x.rb"]),
        { createSession },
      );
      expect(captured.map((c) => c.owner)).toEqual(["billing"]); // web never spawned
      expect(seq.stoppedAt).toBe("billing");
      expect(seq.cancelled).toBe(false);
      expect(seq.allCompleted).toBe(false);
      expect(seq.steps[1].kind).toBe("not_run");
      if (seq.steps[1].kind === "not_run") expect(seq.steps[1].reason).toBe("sequence_stopped");
    });
  }

  it("treats a pre-spawn build failure as non-completed and stops the sequence", async () => {
    // A first owner whose required instruction source is missing fails pre-spawn.
    const brokenAgent: DomainAgent = {
      id: "billing",
      name: "Billing",
      description: "x",
      ownership: ["services/billing/**"],
      permissions: { edit: { allow: ["services/billing/**"] } },
      instructions: { required: [".orca/missing.md"], optional: [] },
    };
    const brokenDoc: OrcaSpecDocument = {
      spec_version: "0.1",
      repository: { id: "018f4f72-0000-7000-8000-0000000000ff" },
      administration: { approvers: [] },
      steward: { discovery: { read: { allow: ["**"], deny: [] } } },
      protected_denies: {},
      agents: [brokenAgent],
    };
    const ordered: DelegationInputs[] = [
      {
        document: brokenDoc,
        owner: "billing",
        targets: ["services/billing/x.rb"],
        grant: compileGrant(brokenAgent, {}),
        task: "work",
        effectiveMode: "enforce",
        cwd: dir,
        parent,
      },
      ...orderedFor(dir, ["apps/web/app.tsx"]),
    ];
    const { createSession, captured } = sessions({});
    const seq = await runDelegationSequence(ordered, { createSession });
    expect(captured).toHaveLength(0); // the build failure never spawns; web is not started
    expect(seq.steps[0].kind).toBe("build_failed");
    if (seq.steps[0].kind === "build_failed") expect(seq.steps[0].failureKind).toBe("required_missing");
    expect(seq.steps[1].kind).toBe("not_run");
    expect(seq.stoppedAt).toBe("billing");
    expect(seq.allCompleted).toBe(false);
  });

  // --- Cancellation --------------------------------------------------------

  it("does not spawn anything when the parent signal is already aborted", async () => {
    const { createSession, captured } = sessions({});
    const seq = await runDelegationSequence(
      orderedFor(dir, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, signal: AbortSignal.abort() },
    );
    expect(captured).toHaveLength(0);
    expect(seq.cancelled).toBe(true);
    expect(seq.steps.every((step) => step.kind === "not_run")).toBe(true);
    for (const step of seq.steps) if (step.kind === "not_run") expect(step.reason).toBe("cancelled");
  });

  it("aborts the in-flight session mid-first-delegation and does not start the rest", async () => {
    const controller = new AbortController();
    const { createSession, captured, abort } = sessions({
      billing: async () => {
        controller.abort(); // parent cancels before this delegation checkpoints
      },
    });
    const seq = await runDelegationSequence(
      orderedFor(dir, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, signal: controller.signal },
    );
    expect(abort).toHaveBeenCalled();
    expect(captured.map((c) => c.owner)).toEqual(["billing"]); // web never spawned
    expect(seq.cancelled).toBe(true);
    // The aborted in-flight session ends with a synthesized failed checkpoint (ADR 0083).
    expect(seq.steps[0].kind).toBe("delegated");
    if (seq.steps[0].kind === "delegated") {
      expect(seq.steps[0].outcome.checkpoint.status).toBe("failed");
      expect(seq.steps[0].outcome.checkpoint.synthesized).toBe(true);
    }
    expect(seq.steps[1].kind).toBe("not_run");
    if (seq.steps[1].kind === "not_run") expect(seq.steps[1].reason).toBe("cancelled");
  });

  it("does not start the next delegation when cancellation lands between delegations", async () => {
    const controller = new AbortController();
    const { createSession, captured } = sessions({
      billing: async (config) => {
        // Complete normally, then the parent cancels before the next owner.
        await callTool(config, "orca_checkpoint", { status: "completed", summary: "done" });
        controller.abort();
      },
    });
    const seq = await runDelegationSequence(
      orderedFor(dir, ["apps/web/app.tsx", "services/billing/x.rb"]),
      { createSession, signal: controller.signal },
    );
    expect(captured.map((c) => c.owner)).toEqual(["billing"]); // web never spawned
    expect(seq.cancelled).toBe(true);
    expect(stepCompleted(seq.steps[0])).toBe(true); // billing completed before cancellation
    expect(seq.steps[1].kind).toBe("not_run");
    if (seq.steps[1].kind === "not_run") expect(seq.steps[1].reason).toBe("cancelled");
    expect(seq.allCompleted).toBe(false);
  });
});

describe("grant immutability (ADR 0008 — never broaden a live grant)", () => {
  it("compiles deep-frozen grants (grant, scopes, and arrays)", () => {
    const grant = resolve(doc, ["apps/web/app.tsx"]).delegations[0].grant;
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.read)).toBe(true);
    expect(Object.isFrozen(grant.write)).toBe(true);
    expect(Object.isFrozen(grant.read.allow)).toBe(true);
    expect(Object.isFrozen(grant.write.allow)).toBe(true);
    expect(Object.isFrozen(grant.write.deny)).toBe(true);
  });

  it("refuses in-place mutation of a live grant", () => {
    const grant = resolve(doc, ["apps/web/app.tsx"]).delegations[0].grant;
    expect(() => (grant.write.allow as string[]).push("secrets/**")).toThrow();
    expect(() => {
      (grant as { write: unknown }).write = { allow: ["**"], deny: [] };
    }).toThrow();
  });

  it("scope expansion re-resolves to a FRESH grant and never widens the original", () => {
    // 'web' works on apps/web/app.tsx and needs services/billing/x.rb (owned by
    // billing). The steward re-delegates with the combined paths.
    const first = resolve(doc, ["apps/web/app.tsx"]);
    const webGrant = first.delegations.find((d) => d.owner === "web")!.grant;
    const before = JSON.parse(JSON.stringify(webGrant));

    const second = resolve(doc, ["apps/web/app.tsx", "services/billing/x.rb"]);
    const billingGrant = second.delegations.find((d) => d.owner === "billing")!.grant;
    const webGrantAgain = second.delegations.find((d) => d.owner === "web")!.grant;

    // The newly requested owner gets its own grant, authorizing its own scope.
    expect(billingGrant.write.allow).toContain("services/billing/**");
    // The original web grant is a different object, byte-for-byte unchanged, still frozen.
    expect(webGrantAgain).not.toBe(webGrant);
    expect(webGrant).toEqual(before);
    expect(webGrant.write.allow).not.toContain("services/billing/**");
    expect(Object.isFrozen(webGrant)).toBe(true);
  });
});
