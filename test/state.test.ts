import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import {
  detectRepositoryState,
  formatStatusLines,
  ORCA_DIR,
  ORCA_SPEC_FILE,
} from "../src/state";

function writeSpec(dir: string, source: string): void {
  mkdirSync(join(dir, ORCA_DIR), { recursive: true });
  writeFileSync(join(dir, ORCA_DIR, ORCA_SPEC_FILE), source);
}

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

  it("activates a valid spec with digest, agents, and effective mode", () => {
    writeSpec(dir, orcaspec.loadFixtureSource("single-agent"));
    const state = detectRepositoryState(dir, "advisory");
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.specPath).toBe(join(dir, ORCA_DIR, ORCA_SPEC_FILE));
      expect(state.digest.short).toMatch(/^sha256:[0-9a-f]{12}$/);
      expect(state.agents.length).toBeGreaterThan(0);
      expect(state.minimumMode).toBe("advisory");
      expect(state.effectiveMode).toBe("advisory");
    }
  });

  it("blocks an incomplete document as invalid_spec (missing sections)", () => {
    writeSpec(dir, "spec_version: '0.1'\n");
    const state = detectRepositoryState(dir);
    expect(state.kind).toBe("invalid_spec");
    if (state.kind === "invalid_spec") {
      expect(state.diagnostics.length).toBeGreaterThan(0);
      expect(formatStatusLines(state).join("\n")).toContain("Diagnostics");
    }
  });

  it("reports invalid_spec identically in advisory and enforce modes (no partial policy)", () => {
    writeSpec(dir, orcaspec.loadFixtureSource("duplicate-agent-id"));
    const advisory = detectRepositoryState(dir, "advisory");
    const enforce = detectRepositoryState(dir, "enforce");
    expect(advisory.kind).toBe("invalid_spec");
    expect(enforce.kind).toBe("invalid_spec");
    if (advisory.kind === "invalid_spec" && enforce.kind === "invalid_spec") {
      expect(enforce.diagnostics).toEqual(advisory.diagnostics);
    }
  });

  it("reports unsupported_spec_version identically in both modes", () => {
    writeSpec(dir, orcaspec.loadFixtureSource("unsupported-spec-version"));
    const advisory = detectRepositoryState(dir, "advisory");
    const enforce = detectRepositoryState(dir, "enforce");
    expect(advisory.kind).toBe("unsupported_spec_version");
    expect(enforce.kind).toBe("unsupported_spec_version");
    if (
      advisory.kind === "unsupported_spec_version" &&
      enforce.kind === "unsupported_spec_version"
    ) {
      expect(advisory.foundVersion).toBe("0.2");
      expect(advisory.supportedVersion).toBe("0.1");
      expect(enforce.diagnostics).toEqual(advisory.diagnostics);
    }
  });
});
