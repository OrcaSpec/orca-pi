import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as orcaspec from "orcaspec";
import type { Model } from "@earendil-works/pi-ai";
import { detectRepositoryState, ORCA_DIR, ORCA_SPEC_FILE } from "../src/state";
import { createDelegateTool, type DelegateDeps } from "../src/tools";
import type {
  DelegationSession,
  DelegationSessionConfig,
} from "../src/delegation";
import type { PersistedDelegationRecord } from "../src/delegation-entry";

const fakeModel = { id: "offline-fixture", provider: "offline" } as unknown as Model<any>;
const fixtureOutput = process.env.ORCA_CROSS_PACKAGE_OUTPUT;
const temporaryRoots: string[] = [];

async function callTool(
  config: DelegationSessionConfig,
  name: string,
  params: unknown,
): Promise<void> {
  const tool = config.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing delegated tool ${name}`);
  await tool.execute("fixture-call", params as never, undefined, undefined, {
    cwd: config.cwd,
  } as never);
}

describe("cross-package canonical delegation fixture", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits one deterministic provider-then-tests v2 sequence without inference", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const repository = mkdtempSync(join(tmpdir(), "orca-cross-package-v2-"));
    temporaryRoots.push(repository);
    mkdirSync(join(repository, ORCA_DIR), { recursive: true });
    writeFileSync(
      join(repository, ORCA_DIR, ORCA_SPEC_FILE),
      orcaspec.loadFixtureSource("multi-owner"),
    );

    const records: PersistedDelegationRecord[] = [];
    const createSession = async (
      config: DelegationSessionConfig,
    ): Promise<DelegationSession> => ({
      prompt: async () => {
        if (config.owner === "billing") {
          expect(config.assignment.dependencies).toEqual([]);
          expect(config.upstreamHandoffs).toEqual([]);
          await callTool(config, "write", {
            path: "services/billing/provider.rb",
            content: "PROVIDER_ALIASES = ['canonical-v2']\n",
          });
          await callTool(config, "orca_checkpoint", {
            status: "completed",
            summary: "implemented the provider alias",
            validation_activities: [
              {
                kind: "test",
                name: "provider focused tests",
                status: "passed",
                summary: "provider behavior passed",
              },
            ],
          });
          return;
        }

        expect(config.owner).toBe("web");
        expect(config.assignment.dependencies).toEqual(["billing"]);
        expect(config.upstreamHandoffs).toEqual([
          expect.objectContaining({
            owner: "billing",
            changedPaths: ["services/billing/provider.rb"],
            validationStatus: "passed",
          }),
        ]);
        await callTool(config, "write", {
          path: "apps/web/provider.test.ts",
          content: "export const expectedAlias = 'canonical-v2';\n",
        });
        await callTool(config, "orca_checkpoint", {
          status: "completed",
          summary: "added provider compatibility coverage",
          validation_activities: [
            {
              kind: "test",
              name: "provider compatibility tests",
              status: "passed",
              summary: "compatibility behavior passed",
            },
          ],
        });
      },
      abort: () => {},
      usage: () =>
        config.owner === "billing"
          ? {
              inputTokens: 30,
              outputTokens: 10,
              totalTokens: 40,
              costUsd: 0.04,
              available: true,
            }
          : {
              inputTokens: 20,
              outputTokens: 10,
              totalTokens: 30,
              costUsd: 0.03,
              available: true,
            },
    });
    const deps: DelegateDeps = {
      getState: (cwd) => detectRepositoryState(cwd, "enforce"),
      getThinkingLevel: () => "medium",
      createSession,
      onDelegationRecord: (record) => records.push(record),
    };

    const result = await createDelegateTool(deps).execute(
      "cross-package-tool-call",
      {
        task: "implement one provider alias and add its compatibility test",
        paths: [
          "services/billing/provider.rb",
          "apps/web/provider.test.ts",
        ],
        assignments: [
          {
            owner: "billing",
            task: "implement the provider alias",
            paths: ["services/billing/provider.rb"],
          },
          {
            owner: "web",
            task: "add compatibility coverage for the implemented alias",
            paths: ["apps/web/provider.test.ts"],
            depends_on: ["billing"],
          },
        ],
        steward_decision: {
          status: "ready",
          reason: "ownership, dependencies, and validation reviewed",
        },
      },
      undefined,
      undefined,
      { cwd: repository, model: fakeModel } as never,
    );

    expect(result.details?.kind).toBe("delegation_sequence");
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.v).toBe(2);
    expect(record.evidenceSchemaVersion).toBe("1.1");
    expect(record.assignmentGraph?.executionOrder).toEqual(["billing", "web"]);
    expect(record.steps).toHaveLength(2);
    expect(record.steps.map((step) => step.targets)).toEqual([
      ["services/billing/provider.rb"],
      ["apps/web/provider.test.ts"],
    ]);
    expect(record.steps.map((step) => step.changedPaths)).toEqual([
      ["services/billing/provider.rb"],
      ["apps/web/provider.test.ts"],
    ]);
    expect(record.steps[1].upstreamHandoffs).toHaveLength(1);
    expect(record.integration?.decision.status).toBe("ready");
    expect(record.integration?.validationAudit.verified).toBe(true);
    expect(record.integration?.signals.changedPathOverlaps).toEqual([]);
    expect(record.usage).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      totalTokens: 70,
      costUsd: 0.07,
      available: true,
    });

    const output = fixtureOutput ?? mkdtempSync(join(tmpdir(), "orca-cross-package-output-"));
    if (!fixtureOutput) temporaryRoots.push(output);
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, "orca-sequence-v2.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  });
});
