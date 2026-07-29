import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelegationRecord } from "../src/checkpoint";
import type { DelegationSessionConfig } from "../src/delegation";
import { createRealSessionFactory } from "../src/session-runner";

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

function usage(
  input: number,
  output: number,
  totalTokens: number,
  costUsd: number,
): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: costUsd,
    },
  };
}

function fakePiSession(options: {
  events?: AgentSessionEvent[];
  lifecycle?: string[];
  shutdownError?: Error;
  disposeError?: Error;
} = {}) {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const lifecycle = options.lifecycle ?? [];
  const unsubscribe = vi.fn();
  const session = {
    subscribe: vi.fn((nextListener: (event: AgentSessionEvent) => void) => {
      listener = nextListener;
      for (const event of options.events ?? []) nextListener(event);
      return unsubscribe;
    }),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(),
    extensionRunner: {
      emit: vi.fn(async () => {
        lifecycle.push("shutdown");
        if (options.shutdownError) throw options.shutdownError;
      }),
    },
    dispose: vi.fn(() => {
      lifecycle.push("dispose");
      if (options.disposeError) throw options.disposeError;
    }),
  };
  const createSession = vi.fn(async () => ({
    session: session as unknown as PiSession,
  })) as unknown as typeof createAgentSession;
  return {
    createSession,
    session,
    unsubscribe,
    emit(event: AgentSessionEvent) {
      if (!listener) throw new Error("Session listener was not registered");
      listener(event);
    },
  };
}

function messageEnd(usageBlock?: Usage): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      stopReason: "stop",
      timestamp: 0,
      ...(usageBlock ? { usage: usageBlock } : {}),
    },
  } as AgentSessionEvent;
}

function config(cwd: string): DelegationSessionConfig {
  return {
    cwd,
    owner: "runtime",
    targets: ["src/duration.py"],
    grantId: "grant-1",
    systemPrompt: "Work only on the assigned target.",
    contextFiles: [],
    tools: [] as ToolDefinition[],
    toolNames: [],
    model: undefined,
    thinkingLevel: "medium",
    kickoffPrompt: "Begin.",
    record: createDelegationRecord(),
    warnings: [],
    instructionDigests: [],
    contextDigests: [],
    assignment: {
      schemaVersion: "1.1",
      assignmentId: "step-runtime",
      owner: "runtime",
      task: "update duration behavior",
      targets: ["src/duration.py"],
      dependencies: [],
    },
    upstreamHandoffs: [],
    sequenceId: "sequence-1",
    stepId: "step-1",
    delegationId: "delegation-1",
    childSessionId: "child-1",
  };
}

describe("real delegated session observer isolation", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("loads only the hidden child observer and finalizes its evidence", async () => {
    directory = mkdtempSync(join(tmpdir(), "orca-pi-observer-"));
    const start = vi.fn();
    const setOutcome = vi.fn();
    const finish = vi.fn();
    const shutdown = vi.fn();
    const prepareDelegation = vi.fn(() => ({
      extension: {
        name: "child-observer",
        hidden: true,
        factory: (pi: ExtensionAPI) => {
          pi.on("session_shutdown", shutdown);
        },
      },
      start,
      setOutcome,
      finish,
    }));
    const factory = createRealSessionFactory(
      await ModelRuntime.create(),
      { prepareDelegation },
    );
    const session = await factory(config(directory));
    await session.finish?.({
      status: "completed",
      checkpointStatus: "completed",
      changedPaths: ["src/duration.py"],
      validationStatus: "passed",
      mutationViolations: [],
    });

    expect(prepareDelegation).toHaveBeenCalledWith({
      grantId: "grant-1",
      targetPaths: ["src/duration.py"],
      resolvedOwners: ["runtime"],
      sequenceId: "sequence-1",
      stepId: "step-1",
      delegationId: "delegation-1",
      childSessionId: "child-1",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(setOutcome).toHaveBeenCalledWith({
      status: "completed",
      checkpointStatus: "completed",
      changedPaths: ["src/duration.py"],
      validationStatus: "passed",
      mutationViolations: [],
    });
    expect(finish).toHaveBeenCalledOnce();
  });

  it("finalizes a started observer when child session creation fails", async () => {
    directory = mkdtempSync(join(tmpdir(), "orca-pi-observer-create-failure-"));
    const lifecycle: string[] = [];
    const creationError = new Error("child creation failed");
    const finish = vi.fn(() => lifecycle.push("observer_finish"));
    const createSession = vi.fn(async () => {
      lifecycle.push("create_session");
      throw creationError;
    }) as unknown as typeof createAgentSession;
    const factory = createRealSessionFactory(
      await ModelRuntime.create(),
      {
        prepareDelegation: () => ({
          extension: () => {},
          start: () => lifecycle.push("observer_start"),
          setOutcome: vi.fn(),
          finish,
        }),
      },
      { createAgentSession: createSession },
    );

    await expect(factory(config(directory))).rejects.toBe(creationError);
    expect(lifecycle).toEqual([
      "observer_start",
      "create_session",
      "observer_finish",
    ]);
    expect(finish).toHaveBeenCalledOnce();
  });

  it("finishes observer evidence and disposes in order when shutdown fails", async () => {
    directory = mkdtempSync(join(tmpdir(), "orca-pi-observer-shutdown-failure-"));
    const lifecycle: string[] = [];
    const shutdownError = new Error("shutdown failed");
    const fake = fakePiSession({ lifecycle, shutdownError });
    const setOutcome = vi.fn(() => lifecycle.push("set_outcome"));
    const finish = vi.fn(() => lifecycle.push("observer_finish"));
    const factory = createRealSessionFactory(
      await ModelRuntime.create(),
      {
        prepareDelegation: () => ({
          extension: () => {},
          start: vi.fn(),
          setOutcome,
          finish,
        }),
      },
      { createAgentSession: fake.createSession },
    );
    const session = await factory(config(directory));

    await expect(
      session.finish?.({
        status: "error",
        checkpointStatus: "failed",
        changedPaths: [],
        validationStatus: "not_run",
        mutationViolations: [],
      }),
    ).rejects.toBe(shutdownError);
    expect(lifecycle).toEqual([
      "set_outcome",
      "shutdown",
      "dispose",
      "observer_finish",
    ]);
    expect(fake.session.dispose).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("retains every exceptional cleanup error", async () => {
    directory = mkdtempSync(join(tmpdir(), "orca-pi-observer-cleanup-errors-"));
    const shutdownError = new Error("shutdown failed");
    const disposeError = new Error("dispose failed");
    const observerError = new Error("observer finish failed");
    const fake = fakePiSession({ shutdownError, disposeError });
    const factory = createRealSessionFactory(
      await ModelRuntime.create(),
      {
        prepareDelegation: () => ({
          extension: () => {},
          start: vi.fn(),
          setOutcome: vi.fn(),
          finish: () => {
            throw observerError;
          },
        }),
      },
      { createAgentSession: fake.createSession },
    );
    const session = await factory(config(directory));

    const finishPromise = session.finish?.({
      status: "error",
      checkpointStatus: "failed",
      changedPaths: [],
      validationStatus: "not_run",
      mutationViolations: [],
    });
    await expect(finishPromise).rejects.toMatchObject({
      errors: [shutdownError, disposeError, observerError],
    });
  });

  it("accumulates usage directly from assistant message-end events", async () => {
    directory = mkdtempSync(join(tmpdir(), "orca-pi-usage-"));
    const fake = fakePiSession();
    const factory = createRealSessionFactory(
      await ModelRuntime.create(),
      undefined,
      { createAgentSession: fake.createSession },
    );
    const session = await factory(config(directory));

    fake.emit(messageEnd(usage(11, 7, 18, 0.012)));
    fake.emit(messageEnd());
    fake.emit(messageEnd(usage(5, 3, 8, 0.004)));

    expect(session.usage?.()).toEqual({
      inputTokens: 16,
      outputTokens: 10,
      totalTokens: 26,
      costUsd: 0.016,
      available: true,
    });
  });

  it("reports usage unavailable when no message exposes it", async () => {
    directory = mkdtempSync(join(tmpdir(), "orca-pi-no-usage-"));
    const fake = fakePiSession({ events: [messageEnd()] });
    const factory = createRealSessionFactory(
      await ModelRuntime.create(),
      undefined,
      { createAgentSession: fake.createSession },
    );
    const session = await factory(config(directory));

    expect(session.usage?.()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      available: false,
    });
  });
});
