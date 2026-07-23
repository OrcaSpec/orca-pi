import { describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import { loadSpec } from "../src/load";
import type { Diagnostic } from "../src/diagnostics";

/**
 * Fixture conformance, driven table-style off the OrcaSpec loader so new upstream
 * fixtures auto-enroll: every valid fixture must load to `valid`, and every
 * invalid fixture must produce the state its `expected.json` annotation implies,
 * carrying a diagnostic whose reason code (and pointer, where the annotation
 * gives one) matches.
 */

function diagnosticsOf(outcome: ReturnType<typeof loadSpec>): Diagnostic[] {
  return "diagnostics" in outcome ? outcome.diagnostics : [];
}

describe("valid fixtures activate", () => {
  const valid = orcaspec.listValidFixtures();

  it("covers the full valid fixture set", () => {
    expect(valid.length).toBe(8);
  });

  for (const name of valid) {
    it(`loads ${name} to a valid outcome`, () => {
      const outcome = loadSpec(orcaspec.loadFixtureSource(name));
      expect(outcome.kind).toBe("valid");
      if (outcome.kind === "valid") {
        expect(outcome.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(outcome.document.spec_version).toBe("0.1");
      }
    });
  }
});

describe("invalid fixtures are rejected with the annotated diagnostic", () => {
  const invalid = orcaspec.listInvalidFixtures();

  it("covers the full invalid fixture set", () => {
    expect(invalid.length).toBe(11);
  });

  for (const name of invalid) {
    const expected = orcaspec.loadExpected(name);

    it(`rejects ${name} with ${expected.reason}`, () => {
      const outcome = loadSpec(orcaspec.loadFixtureSource(name));

      // unsupported_spec_version is its own state; every other invalid fixture
      // (structural or semantic) maps to invalid_spec.
      if (expected.reason === "semantic.unsupported_spec_version") {
        expect(outcome.kind).toBe("unsupported_spec_version");
      } else {
        expect(outcome.kind).toBe("invalid_spec");
      }

      const match = diagnosticsOf(outcome).find((d) => d.reason === expected.reason);
      expect(
        match,
        `expected a diagnostic with reason ${expected.reason} for ${name}`,
      ).toBeTruthy();

      if (expected.pointer !== undefined) {
        expect(match?.pointer).toBe(expected.pointer);
      }
      // The phase in our diagnostic aligns with the fixture's declared phase.
      expect(match?.phase).toBe(expected.phase);
    });
  }
});

describe("unsupported version is distinct from invalid_spec", () => {
  it("maps a well-formed unsupported version to unsupported_spec_version", () => {
    const outcome = loadSpec(orcaspec.loadFixtureSource("unsupported-spec-version"));
    expect(outcome.kind).toBe("unsupported_spec_version");
    if (outcome.kind === "unsupported_spec_version") {
      expect(outcome.foundVersion).toBe("0.2");
      expect(outcome.supportedVersion).toBe("0.1");
      expect(outcome.diagnostics[0]?.reason).toBe("semantic.unsupported_spec_version");
    }
  });

  it("maps a malformed version to invalid_spec (structural), not unsupported", () => {
    const outcome = loadSpec(orcaspec.loadFixtureSource("malformed-spec-version"));
    expect(outcome.kind).toBe("invalid_spec");
    expect(diagnosticsOf(outcome).some((d) => d.reason === "structural.invalid_spec_version_format")).toBe(true);
  });
});

describe("semantic diagnostics carry aligned detail", () => {
  it("duplicate agent id anchors on the later agent with the id in detail", () => {
    const outcome = loadSpec(orcaspec.loadFixtureSource("duplicate-agent-id"));
    const match = diagnosticsOf(outcome).find((d) => d.reason === "semantic.duplicate_agent_id");
    expect(match?.pointer).toBe("/agents/1/id");
    expect(match?.detail).toMatchObject({ id: "billing" });
  });

  it("ownership conflict names both agents and the shared scope", () => {
    const outcome = loadSpec(orcaspec.loadFixtureSource("equal-ownership-scope"));
    const match = diagnosticsOf(outcome).find((d) => d.reason === "semantic.ownership_conflict");
    expect(match?.pointer).toBe("/agents/1/ownership/0");
    expect(match?.detail).toMatchObject({
      scope: "services/billing/**",
      agents: ["billing-core", "billing-legacy"],
    });
  });
});
