import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import { resolve } from "../src/resolver";
import {
  runDelegationSequence,
  type DelegationInputs,
  type DelegationSession,
  type DelegationSessionConfig,
  type DelegationUsage,
} from "../src/delegation";
import {
  buildDelegationRecord,
  DELEGATION_ENTRY_TYPE,
  DELEGATION_ENTRY_VERSION,
  DelegationHistory,
  digestGrants,
  parseDelegationEntry,
  recordSummaryLine,
  renderRecordLines,
  type PersistedDelegationRecord,
} from "../src/delegation-entry";

/**
 * The persistent delegation record and the durable history rebuilt from session
 * entries ALONE (PRD "User Surface"). Offline — the sequence runs through the
 * scripted `createSession` seam; each fake records a bash command (as the spawn
 * hook would) and a changed path, then checkpoints completed with scripted usage.
 */

const fakeModel = { id: "fake", provider: "fake" } as unknown as Model<any>;
const doc = orcaspec.loadFixture("multi-owner");
const parent = { model: fakeModel, thinkingLevel: "medium" as const };

const OWNED: Record<string, string> = {
  billing: "services/billing/x.rb",
  web: "apps/web/app.tsx",
  "design-system": "apps/web/components/button.tsx",
  infra: "infra/main.tf",
};

async function callTool(config: DelegationSessionConfig, name: string, params: unknown): Promise<void> {
  const tool = config.tools.find((t) => t.name === name)!;
  await tool.execute("t", params as never, undefined, undefined, { cwd: config.cwd } as never);
}

function usageOf(totalTokens: number, costUsd: number): DelegationUsage {
  return { inputTokens: totalTokens, outputTokens: 0, totalTokens, costUsd, available: true };
}

/** A scripted session that records a bash command + a changed path, then completes. */
function completingSessions(usageByOwner: Record<string, DelegationUsage> = {}) {
  const createSession = async (config: DelegationSessionConfig): Promise<DelegationSession> => ({
    prompt: async () => {
      config.record.bashActivity.push({ command: `npm run build # ${config.owner}`, cwd: config.cwd });
      config.record.changedPaths.add(OWNED[config.owner]);
      await callTool(config, "orca_checkpoint", { status: "completed", summary: `${config.owner} done` });
    },
    abort: () => {},
    usage: () => usageByOwner[config.owner] ?? usageOf(0, 0),
  });
  return createSession;
}

function orderedFor(cwd: string, paths: string[]): DelegationInputs[] {
  return resolve(doc, paths).delegations.map((delegation) => ({
    document: doc,
    owner: delegation.owner,
    targets: delegation.targets,
    grant: delegation.grant,
    task: "align the buttons and bill for it",
    effectiveMode: "enforce",
    cwd,
    parent,
  }));
}

describe("delegation record: build, digest, round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-entry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function buildRecord(paths: string[], usage: Record<string, DelegationUsage> = {}) {
    const ordered = orderedFor(dir, paths);
    const sequence = await runDelegationSequence(ordered, { createSession: completingSessions(usage) });
    return buildDelegationRecord({
      task: "align the buttons and bill for it",
      targets: paths,
      grantDigest: digestGrants(ordered.map((o) => o.grant)),
      sequence,
      startedAt: 1000,
      endedAt: 2000,
    });
  }

  it("builds a versioned, JSON-safe record with per-owner statuses and observed manifests", async () => {
    const record = await buildRecord(["apps/web/app.tsx", "services/billing/x.rb"]);
    expect(record.v).toBe(DELEGATION_ENTRY_VERSION);
    expect(record.owners).toEqual(["billing", "web"]);
    expect(record.steps.map((s) => s.status)).toEqual(["completed", "completed"]);
    const billing = record.steps.find((s) => s.owner === "billing")!;
    expect(billing.changedPaths).toEqual(["services/billing/x.rb"]);
    expect(billing.capabilitySummary).toBe("partially_enforced");
    expect(billing.bashActivity?.[0]?.command).toContain("npm run build");
    // JSON-safe: a full stringify/parse cycle preserves the record exactly.
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it("sums usage across the sequence", async () => {
    const record = await buildRecord(["apps/web/app.tsx", "services/billing/x.rb"], {
      web: usageOf(100, 0.01),
      billing: usageOf(250, 0.02),
    });
    expect(record.usage.totalTokens).toBe(350);
    expect(record.usage.costUsd).toBeCloseTo(0.03, 6);
    expect(record.usage.available).toBe(true);
  });

  it("round-trips through an appendEntry payload and back via parseDelegationEntry", async () => {
    const record = await buildRecord(["apps/web/app.tsx"]);
    const persisted = JSON.parse(JSON.stringify(record)) as unknown;
    const entry = { type: "custom", customType: DELEGATION_ENTRY_TYPE, data: persisted };
    expect(parseDelegationEntry(entry)).toEqual(record);
  });

  it("digestGrants is deterministic and distinguishes different grants", () => {
    const web = resolve(doc, ["apps/web/app.tsx"]).delegations.map((d) => d.grant);
    const billing = resolve(doc, ["services/billing/x.rb"]).delegations.map((d) => d.grant);
    expect(digestGrants(web)).toBe(digestGrants(web));
    expect(digestGrants(web)).not.toBe(digestGrants(billing));
  });

  it("rejects foreign, mistyped, and wrong-version entries", () => {
    expect(parseDelegationEntry({ type: "message", message: {} })).toBeNull();
    expect(parseDelegationEntry({ type: "custom", customType: "other", data: {} })).toBeNull();
    expect(
      parseDelegationEntry({
        type: "custom",
        customType: DELEGATION_ENTRY_TYPE,
        data: { v: 999, task: "x", owners: [], targets: [], steps: [] },
      }),
    ).toBeNull();
    expect(parseDelegationEntry(undefined)).toBeNull();
  });
});

describe("DelegationHistory rebuild from entries alone", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-hist-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function record(paths: string[]): Promise<PersistedDelegationRecord> {
    const ordered = orderedFor(dir, paths);
    const sequence = await runDelegationSequence(ordered, { createSession: completingSessions() });
    return buildDelegationRecord({
      task: `task for ${paths.join("+")}`,
      targets: paths,
      grantDigest: digestGrants(ordered.map((o) => o.grant)),
      sequence,
      startedAt: 1,
      endedAt: 2,
    });
  }

  const asEntry = (r: PersistedDelegationRecord) => ({
    type: "custom",
    customType: DELEGATION_ENTRY_TYPE,
    data: JSON.parse(JSON.stringify(r)) as unknown,
  });

  it("rebuilds identical summaries from a branch with unrelated entries interleaved", async () => {
    const a = await record(["apps/web/app.tsx"]);
    const b = await record(["services/billing/x.rb"]);
    const branch = [
      { type: "message", message: { role: "user" } },
      asEntry(a),
      { type: "custom", customType: "some-other-extension", data: { hi: 1 } },
      asEntry(b),
      { type: "leaf", targetId: null },
    ];
    const history = new DelegationHistory();
    history.rebuildFrom(branch);
    expect(history.count()).toBe(2);
    expect(history.all().map(recordSummaryLine)).toEqual([recordSummaryLine(a), recordSummaryLine(b)]);
  });

  it("a resumed session displays prior history from entries ONLY (fresh in-memory state)", async () => {
    const a = await record(["apps/web/app.tsx", "services/billing/x.rb"]);
    // The "resumed" session starts with an empty history and rebuilds purely from
    // the persisted branch — no live delegation happened in this instance.
    const resumed = new DelegationHistory();
    expect(resumed.statusLines()).toEqual([]);
    resumed.rebuildFrom([asEntry(a)]);
    const lines = resumed.statusLines().join("\n");
    expect(lines).toContain("Delegation history (1):");
    expect(lines).toContain(a.task);
  });

  it("rebuild is idempotent (a second rebuild clears first, never doubles)", async () => {
    const a = await record(["apps/web/app.tsx"]);
    const history = new DelegationHistory();
    history.rebuildFrom([asEntry(a)]);
    history.rebuildFrom([asEntry(a)]);
    expect(history.count()).toBe(1);
  });
});

describe("renderRecordLines (transcript + last-delegation detail)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-render-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders checkpoint outcome, capability summary, bash activity (labelled), and usage", async () => {
    const ordered = orderedFor(dir, ["apps/web/app.tsx"]);
    const sequence = await runDelegationSequence(ordered, {
      createSession: completingSessions({ web: usageOf(1234, 0.0456) }),
    });
    const record = buildDelegationRecord({
      task: "restyle the primary button",
      targets: ["apps/web/app.tsx"],
      grantDigest: digestGrants(ordered.map((o) => o.grant)),
      sequence,
      startedAt: 1,
      endedAt: 2,
    });
    const text = renderRecordLines(record).join("\n");
    expect(text).toContain("restyle the primary button");
    expect(text).toContain("web: completed");
    expect(text).toContain("Observed changed paths (1): apps/web/app.tsx");
    expect(text).toContain("Capability summary (not a mode): partially_enforced");
    expect(text).toContain("Bash activity — VISIBILITY ONLY, not enforcement (ADR 0079)");
    expect(text).toContain("npm run build");
    expect(text).toContain("1234 tokens");
    expect(text).toContain("$0.0456");
  });
});
