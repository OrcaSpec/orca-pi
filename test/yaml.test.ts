import { describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import { parseRestrictedYaml } from "../src/yaml";
import { loadSpec } from "../src/load";
import type { Diagnostic } from "../src/diagnostics";

/**
 * Restricted-YAML profile per ADR 0025: aliases, anchors, custom tags, merge
 * keys, duplicate keys, and multiple documents are all rejected with an
 * actionable `yaml.*` diagnostic (never a crash) before structural validation.
 */

function reasons(source: string): string[] {
  const result = parseRestrictedYaml(source);
  expect(result.ok).toBe(false);
  const diagnostics: Diagnostic[] = result.ok ? [] : result.diagnostics;
  return diagnostics.map((d) => d.reason);
}

describe("restricted YAML violations", () => {
  it("rejects anchors and aliases", () => {
    const source = ['base: &ref "0.1"', "copy: *ref", ""].join("\n");
    const found = reasons(source);
    expect(found).toContain("yaml.alias");
    expect(found).toContain("yaml.anchor");
    for (const r of found) expect(r.startsWith("yaml.")).toBe(true);
  });

  it("rejects multiple documents", () => {
    expect(reasons("a: 1\n---\nb: 2\n")).toContain("yaml.multiple_documents");
  });

  it("rejects merge keys", () => {
    const source = ["defaults: { a: 1 }", "merged:", "  <<: { b: 2 }", ""].join("\n");
    expect(reasons(source)).toContain("yaml.merge_key");
  });

  it("rejects custom tags", () => {
    expect(reasons("value: !custom 5\n")).toContain("yaml.custom_tag");
  });

  it("rejects duplicate mapping keys", () => {
    expect(reasons("id: a\nid: b\n")).toContain("yaml.duplicate_key");
  });

  it("rejects an empty document", () => {
    expect(reasons("\n")).toContain("yaml.empty");
  });

  it("surfaces a YAML-profile violation as invalid_spec through loadSpec", () => {
    const source = ['spec_version: &v "0.1"', "repository:", "  id: *v", ""].join("\n");
    const outcome = loadSpec(source);
    expect(outcome.kind).toBe("invalid_spec");
    if (outcome.kind === "invalid_spec") {
      expect(outcome.diagnostics.every((d) => d.phase === "yaml")).toBe(true);
    }
  });

  it("accepts a clean valid fixture", () => {
    const result = parseRestrictedYaml(orcaspec.loadFixtureSource("minimal"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveProperty("spec_version", "0.1");
    }
  });
});
