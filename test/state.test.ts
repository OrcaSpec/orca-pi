import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectRepositoryState,
  formatStatusLines,
  ORCA_DIR,
  ORCA_SPEC_FILE,
} from "../src/state";

describe("detectRepositoryState", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns unmanaged for a directory without .orca/orca.yaml", () => {
    const state = detectRepositoryState(dir);
    expect(state.kind).toBe("unmanaged");
    expect(state.cwd).toBe(dir);
    expect(formatStatusLines(state)[0]).toContain("unmanaged");
  });

  it("stays unmanaged when .orca exists but holds no orca.yaml", () => {
    mkdirSync(join(dir, ORCA_DIR));
    writeFileSync(join(dir, ORCA_DIR, "notes.txt"), "not a spec");
    expect(detectRepositoryState(dir).kind).toBe("unmanaged");
  });

  it("does not treat a .orca/orca.yaml directory as a managed repository", () => {
    mkdirSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), { recursive: true });
    expect(detectRepositoryState(dir).kind).toBe("unmanaged");
  });

  it("detects a present spec file (placeholder pending Phase 3 validation)", () => {
    mkdirSync(join(dir, ORCA_DIR));
    writeFileSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), "spec_version: '0.1'\n");
    const state = detectRepositoryState(dir);
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.specPath).toBe(join(dir, ORCA_DIR, ORCA_SPEC_FILE));
    }
  });
});
