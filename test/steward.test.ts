import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import { detectRepositoryState, ORCA_DIR, ORCA_SPEC_FILE, type ActiveState } from "../src/state";
import { STEWARD_SECTIONS, composeStewardPrompt } from "../src/steward";

function activeStateFor(dir: string, fixture: string, requested: "advisory" | "enforce"): ActiveState {
  mkdirSync(join(dir, ORCA_DIR), { recursive: true });
  writeFileSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), orcaspec.loadFixtureSource(fixture));
  const state = detectRepositoryState(dir, requested);
  if (state.kind !== "active") throw new Error(`expected active state, got ${state.kind}`);
  return state;
}

describe("composeStewardPrompt", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-steward-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits every steward section in root-first order (ADR 0051)", () => {
    const prompt = composeStewardPrompt(activeStateFor(dir, "multi-owner", "enforce"));
    const indices = STEWARD_SECTIONS.map((heading) => prompt.indexOf(heading));
    expect(indices.every((index) => index >= 0)).toBe(true);
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
    // Harness invariants come first; the delegation directive interprets the task last.
    expect(indices[0]).toBe(Math.min(...indices));
  });

  it("states the steward role, no-write invariant, effective mode, and four states", () => {
    const prompt = composeStewardPrompt(activeStateFor(dir, "multi-owner", "enforce"));
    expect(prompt).toContain("repository steward");
    expect(prompt).toContain("implicit write authority");
    expect(prompt).toContain("effective operating mode is 'enforce'");
    expect(prompt).toContain("unmanaged");
    expect(prompt).toContain("invalid_spec");
    expect(prompt).toContain("unsupported_spec_version");
  });

  it("summarizes the discovery scope and delegation directive", () => {
    const prompt = composeStewardPrompt(activeStateFor(dir, "multi-owner", "enforce"));
    expect(prompt).toContain("orca_delegate");
    expect(prompt).toContain("Never write into a domain agent's owned scope");
    // Discovery allow/deny surfaced from steward.discovery.read + protected denies.
    expect(prompt).toContain("secrets/**");
    // Domain agents and their ownership are listed.
    expect(prompt).toContain("web");
    expect(prompt).toContain("apps/web/**");
    // Steward has no orca_checkpoint.
    expect(prompt).toContain("do not have orca_checkpoint");
  });

  it("reflects the advisory effective mode and declared steward instruction sources", () => {
    const prompt = composeStewardPrompt(activeStateFor(dir, "single-agent", "advisory"));
    expect(prompt).toContain("effective operating mode is 'advisory'");
    expect(prompt).toContain(".orca/steward/instructions.md");
  });
});
