import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import { DEFAULT_MODE, stricterMode, type OperatingMode } from "../src/mode";
import { detectRepositoryState, ORCA_DIR, ORCA_SPEC_FILE } from "../src/state";

/**
 * Effective mode = stricter of repository.minimum_mode and requested mode
 * (ADR 0063), with an absent minimum defaulting to advisory. The full
 * minimum × requested matrix must resolve to stricter-wins in every cell.
 */

const MODES: OperatingMode[] = ["advisory", "enforce"];

describe("stricterMode", () => {
  const cases: Array<[OperatingMode, OperatingMode, OperatingMode]> = [
    ["advisory", "advisory", "advisory"],
    ["advisory", "enforce", "enforce"],
    ["enforce", "advisory", "enforce"],
    ["enforce", "enforce", "enforce"],
  ];
  for (const [minimum, requested, effective] of cases) {
    it(`min=${minimum} × requested=${requested} → ${effective}`, () => {
      expect(stricterMode(minimum, requested)).toBe(effective);
    });
  }

  it("defaults to advisory", () => {
    expect(DEFAULT_MODE).toBe("advisory");
  });
});

describe("effective mode through detectRepositoryState", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orca-pi-mode-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function activate(fixture: string, requested: OperatingMode) {
    mkdirSync(join(dir, ORCA_DIR), { recursive: true });
    writeFileSync(
      join(dir, ORCA_DIR, ORCA_SPEC_FILE),
      orcaspec.loadFixtureSource(fixture),
    );
    return detectRepositoryState(dir, requested);
  }

  // `minimal` omits minimum_mode (defaults advisory); `enforce-minimum` sets
  // enforce. Together they cover the {absent→advisory, enforce} minimum axis.
  const byMinimum: Array<[string, OperatingMode]> = [
    ["minimal", "advisory"],
    ["enforce-minimum", "enforce"],
  ];

  for (const [fixture, minimum] of byMinimum) {
    for (const requested of MODES) {
      const expected = stricterMode(minimum, requested);
      it(`${fixture} (min ${minimum}) requested ${requested} → effective ${expected}`, () => {
        const state = activate(fixture, requested);
        expect(state.kind).toBe("active");
        if (state.kind === "active") {
          expect(state.minimumMode).toBe(minimum);
          expect(state.requestedMode).toBe(requested);
          expect(state.effectiveMode).toBe(expected);
        }
      });
    }
  }

  it("an enforce minimum cannot be downgraded by an advisory request", () => {
    const state = activate("enforce-minimum", "advisory");
    expect(state.kind).toBe("active");
    if (state.kind === "active") expect(state.effectiveMode).toBe("enforce");
  });
});
