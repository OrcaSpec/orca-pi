import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import {
  detectRepositoryState,
  ORCA_DIR,
  ORCA_SPEC_FILE,
  type ActiveState,
  type BrokenSpecState,
} from "../src/state";
import {
  BROKEN_SPEC_SECTION,
  STEWARD_SECTIONS,
  composeBrokenSpecNote,
  composeStewardPrompt,
} from "../src/steward";

function writeSpec(dir: string, fixture: string): void {
  mkdirSync(join(dir, ORCA_DIR), { recursive: true });
  writeFileSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), orcaspec.loadFixtureSource(fixture));
}

function activeStateFor(dir: string, fixture: string, requested: "advisory" | "enforce"): ActiveState {
  writeSpec(dir, fixture);
  const state = detectRepositoryState(dir, requested);
  if (state.kind !== "active") throw new Error(`expected active state, got ${state.kind}`);
  return state;
}

function brokenStateFor(dir: string, fixture: string): BrokenSpecState {
  writeSpec(dir, fixture);
  const state = detectRepositoryState(dir);
  if (state.kind !== "invalid_spec" && state.kind !== "unsupported_spec_version") {
    throw new Error(`expected a broken state, got ${state.kind}`);
  }
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
    expect(prompt).toContain("one explicit owner-specific assignment");
    expect(prompt).toContain("acyclic dependencies");
    expect(prompt).toContain("combined diff identity");
    expect(prompt).toContain("acknowledge");
  });

  it("reflects the advisory effective mode and declared steward instruction sources", () => {
    const prompt = composeStewardPrompt(activeStateFor(dir, "single-agent", "advisory"));
    expect(prompt).toContain("effective operating mode is 'advisory'");
    expect(prompt).toContain(".orca/steward/instructions.md");
  });
});

describe("composeBrokenSpecNote", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-broken-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("tells an invalid_spec session what is blocked, what still works, and where the problem is", () => {
    const state = brokenStateFor(dir, "duplicate-agent-id");
    const note = composeBrokenSpecNote(state);
    expect(note.startsWith(BROKEN_SPEC_SECTION)).toBe(true);
    expect(note).toContain("invalid_spec");
    expect(note).toContain(state.specPath);
    expect(note).toContain("BLOCKED");
    expect(note).toContain("orca_delegate is unavailable");
    expect(note).toContain("advisory and enforce modes alike");
    expect(note).toContain("read, grep, find, and ls");
    // The actual problem travels with the note, not just a pointer to /orca.
    expect(note).toContain(state.diagnostics[0].reason);
    expect(note).toContain(state.diagnostics[0].message);
  });

  it("names the found and supported versions for unsupported_spec_version", () => {
    const state = brokenStateFor(dir, "unsupported-spec-version");
    if (state.kind !== "unsupported_spec_version") throw new Error("wrong state");
    const note = composeBrokenSpecNote(state);
    expect(note).toContain("unsupported_spec_version");
    expect(note).toContain(`declares spec_version '${state.foundVersion}'`);
    expect(note).toContain(`supports '${state.supportedVersion}'`);
  });

  it("claims none of the active-governance sections, which cannot be stated truthfully", () => {
    // No validated document means no ownership map, discovery scope, or agent list.
    const note = composeBrokenSpecNote(brokenStateFor(dir, "duplicate-agent-id"));
    for (const section of STEWARD_SECTIONS) {
      expect(note, `omits ${section}`).not.toContain(section);
    }
  });

  it("stays short — a blocked session needs the block, not the full governance brief", () => {
    const note = composeBrokenSpecNote(brokenStateFor(dir, "duplicate-agent-id"));
    const active = composeStewardPrompt(activeStateFor(dir, "multi-owner", "enforce"));
    expect(note.length).toBeLessThan(active.length);
    expect(note.split("\n").length).toBeLessThanOrEqual(6);
  });
});
