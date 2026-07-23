import { describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";

// Exercises the OrcaSpec git dependency end-to-end: the extension must be able
// to consume the versioned spec package's schema, fixtures, and vectors.
describe("orcaspec dependency integration", () => {
  it("reports SPEC_VERSION 0.1", () => {
    expect(orcaspec.SPEC_VERSION).toBe("0.1");
  });

  it("exposes 8 valid and 11 invalid fixtures", () => {
    expect(orcaspec.listValidFixtures()).toHaveLength(8);
    expect(orcaspec.listInvalidFixtures()).toHaveLength(11);
  });

  it("loads the 0.1 JSON Schema as draft 2020-12", () => {
    const schema = orcaspec.loadSchema();
    expect(String(schema["$schema"])).toContain("2020-12");
  });

  it("parses a valid fixture into the six top-level sections", () => {
    const name = orcaspec.listValidFixtures()[0];
    const doc = orcaspec.loadFixture(name);
    expect(doc.spec_version).toBe("0.1");
    for (const section of [
      "repository",
      "administration",
      "steward",
      "protected_denies",
      "agents",
    ] as const) {
      expect(doc).toHaveProperty(section);
    }
  });

  it("annotates every invalid fixture with an expected failure reason", () => {
    for (const name of orcaspec.listInvalidFixtures()) {
      const expected = orcaspec.loadExpected(name);
      expect(expected.valid).toBe(false);
      expect(expected.reason).toBeTruthy();
      expect(["structural", "semantic"]).toContain(expected.phase);
    }
  });

  it("loads a resolution vector with its expected delegations", () => {
    const vectors = orcaspec.listVectors();
    expect(vectors.length).toBeGreaterThan(0);
    const vector = orcaspec.loadVector(vectors[0]);
    expect(Array.isArray(vector.targets)).toBe(true);
    expect(vector.expected).toHaveProperty("delegations");
    expect(vector.expected).toHaveProperty("perTarget");
  });
});
