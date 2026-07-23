import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryState } from "../src/state";
import type { DelegationProgress } from "../src/delegation";
import {
  inflightFromProgress,
  progressLine,
  statusWidgetLines,
  Surface,
  type InflightDelegation,
} from "../src/surface";

/**
 * The single UI seam (PRD "Commands and status"). Every surface routes through
 * {@link Surface}, so a fake capturing ctx proves (a) UI calls happen exactly
 * where expected and (b) a headless run performs ZERO UI calls while still
 * behaving (headless stdout only in plain modes, never in json/rpc).
 */

function fakeCtx(hasUI: boolean, mode = "tui") {
  const calls = {
    notify: [] as Array<[string, string | undefined]>,
    setStatus: [] as Array<[string, string | undefined]>,
    setWidget: [] as Array<[string, string[] | undefined]>,
  };
  const ui = {
    notify: (m: string, t?: "info" | "warning" | "error") => calls.notify.push([m, t]),
    setStatus: (k: string, v: string | undefined) => calls.setStatus.push([k, v]),
    setWidget: (k: string, c: string[] | undefined) => calls.setWidget.push([k, c]),
  };
  return { ctx: { hasUI, mode, ui }, calls };
}

const active = { kind: "active", effectiveMode: "enforce" } as unknown as RepositoryState;
const unmanaged = { kind: "unmanaged" } as unknown as RepositoryState;

describe("Surface seam", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes notify/status/widget to ctx.ui when UI is present", () => {
    const { ctx, calls } = fakeCtx(true);
    const surface = new Surface(ctx);
    surface.notify("hello", "warning");
    surface.status("orca: enforce");
    surface.widget(["line one", "line two"]);
    expect(calls.notify).toEqual([["hello", "warning"]]);
    expect(calls.setStatus).toEqual([["orca", "orca: enforce"]]);
    expect(calls.setWidget).toEqual([["orca", ["line one", "line two"]]]);
  });

  it("performs ZERO UI calls when headless, logging notify to stdout in plain modes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, calls } = fakeCtx(false, "print");
    const surface = new Surface(ctx);
    surface.notify("headline");
    surface.status("orca: enforce");
    surface.widget(["x"]);
    expect(calls.notify).toEqual([]);
    expect(calls.setStatus).toEqual([]);
    expect(calls.setWidget).toEqual([]);
    expect(log).toHaveBeenCalledWith("headline");
  });

  it("does not pollute stdout in json/rpc modes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const mode of ["json", "rpc"]) {
      const { ctx } = fakeCtx(false, mode);
      new Surface(ctx).notify("nope");
    }
    expect(log).not.toHaveBeenCalled();
  });
});

describe("progress rendering", () => {
  const events: DelegationProgress[] = [
    { kind: "sequence_start", owners: ["billing", "web"], total: 2 },
    { kind: "step_start", owner: "billing", index: 1, total: 2 },
    { kind: "step_activity", owner: "billing", index: 1, total: 2, note: "running bash" },
    { kind: "step_end", owner: "billing", index: 1, total: 2, status: "completed", changedPaths: 3 },
    { kind: "sequence_end", total: 2, completed: 2, allCompleted: true },
  ];

  it("produces a readable one-liner per event kind", () => {
    const lines = events.map(progressLine);
    expect(lines[0]).toContain("2 owner(s)");
    expect(lines[1]).toContain("[1/2] billing");
    expect(lines[2]).toContain("running bash");
    expect(lines[3]).toContain("completed");
    expect(lines[3]).toContain("3 changed");
    expect(lines[4]).toContain("2/2 completed");
  });

  it("tracks the in-flight delegation across the event stream", () => {
    let inflight: InflightDelegation | undefined;
    const snapshots = events.map((event) => {
      inflight = inflightFromProgress(inflight, event);
      return inflight;
    });
    expect(snapshots[0]).toBeUndefined(); // sequence_start clears
    expect(snapshots[1]).toEqual({ owner: "billing", index: 1, total: 2, status: "running" });
    expect(snapshots[3]).toEqual({ owner: "billing", index: 1, total: 2, status: "completed" });
    expect(snapshots[4]).toBeUndefined(); // sequence_end clears
  });
});

describe("statusWidgetLines", () => {
  it("shows governance, mode, counts, and the in-flight delegation", () => {
    const lines = statusWidgetLines({
      state: active,
      violationCount: 2,
      historyCount: 5,
      inflight: { owner: "web", index: 2, total: 3, status: "running" },
    });
    const text = lines.join("\n");
    expect(text).toContain("Effective mode: enforce");
    expect(text).toContain("Governance events: 2");
    expect(text).toContain("Delegations recorded: 5");
    expect(text).toContain("In-flight: web (step 2/3) — running");
  });

  it("omits the mode and in-flight lines when unmanaged and idle", () => {
    const text = statusWidgetLines({ state: unmanaged, violationCount: 0, historyCount: 0 }).join("\n");
    expect(text).not.toContain("Effective mode");
    expect(text).not.toContain("In-flight");
  });
});
