import { describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import { describeProtectionSalvage, salvageProtectedDenies } from "../src/salvage";

/**
 * Best-effort salvage of `protected_denies.read` from an UNUSABLE OrcaSpec
 * document (Phase 4). Sources are real fixture text broken in one specific way,
 * so each test names the damage it survives — or does not.
 *
 * The multi-owner fixture is the base for the "broken elsewhere" cases because it
 * is the one valid fixture that actually declares a protected read deny
 * (`secrets/**`); the hand-written snippets below isolate the protections section
 * itself, whose damage is the thing that makes protections lapse.
 *
 * Two decisions recorded here rather than coded, because neither needs handling:
 * a salvaged scope containing a NUL byte is kept verbatim (a tool-supplied path
 * can never contain one — `normalizeTarget` rejects it — so such a scope matches
 * nothing and refuses nothing extra), and a scope outside the MVP path grammar is
 * likewise kept verbatim (`matchScope` then matches it only against itself).
 */
function healthySource(): string {
  return orcaspec.loadFixtureSource("multi-owner");
}

/** Broken by a semantic rule (duplicate agent id) far away from the protections. */
function duplicateAgentId(): string {
  return `${healthySource()}
  - id: web
    name: Web Duplicate
    description: Reuses the web id for a different scope.
    ownership:
      - apps/duplicate/**
    permissions:
      edit:
        allow:
          - apps/duplicate/**
        deny: []
`;
}

/** Broken structurally (an unknown top-level section) far away from the protections. */
function unknownTopLevelSection(): string {
  return `${healthySource()}\nnot_a_section:\n  anything: true\n`;
}

/** A protections section, plus whatever else the case needs. */
function withProtections(body: string): string {
  return `spec_version: "0.1"\nprotected_denies:\n${body}`;
}

describe("salvaging protected read denies from an unusable document", () => {
  // --- damage OUTSIDE the protections section: the set survives --------------

  it("extracts the declared protected read denies from a document broken outside its protections", () => {
    const salvage = salvageProtectedDenies(duplicateAgentId());
    expect(salvage.kind).toBe("enforcing");
    expect(salvage.read).toEqual(["secrets/**"]);
  });

  it("extracts them from a structurally broken document too (an unknown top-level section)", () => {
    const salvage = salvageProtectedDenies(unknownTopLevelSection());
    expect(salvage.kind).toBe("enforcing");
    expect(salvage.read).toEqual(["secrets/**"]);
  });

  it("extracts them from a document whose only fault is an unsupported spec_version", () => {
    // unsupported_spec_version documents are usually structurally perfect, and take
    // exactly the same salvage path as invalid_spec ones.
    const salvage = salvageProtectedDenies(healthySource().replace('"0.1"', '"0.2"'));
    expect(salvage.kind).toBe("enforcing");
    expect(salvage.read).toEqual(["secrets/**"]);
  });

  it("reads through restricted-YAML violations the strict loader rejects the document for", () => {
    // A custom tag makes the document invalid_spec, but the protections are still
    // perfectly legible, and a deny that can be read is a deny that can be enforced.
    const salvage = salvageProtectedDenies(
      `${healthySource()}\nnot_a_section: !!str tagged\n`,
    );
    expect(salvage.kind).toBe("enforcing");
    expect(salvage.read).toEqual(["secrets/**"]);
  });

  it("follows one level of alias, so protections written as `*base` are still enforced", () => {
    const salvage = salvageProtectedDenies(
      'spec_version: "0.1"\nbase: &b\n  read:\n    - secrets/**\nprotected_denies: *b\n',
    );
    expect(salvage.kind).toBe("enforcing");
    expect(salvage.read).toEqual(["secrets/**"]);
  });

  // --- ambiguous documents are read at their most restrictive ----------------

  it("unions every occurrence when a duplicate key makes the document ambiguous", () => {
    // Restricted YAML forbids duplicate keys, so which one "wins" is undefined.
    // Salvage only ever ADDS refusals, so honoring both is the fail-closed reading.
    const both = salvageProtectedDenies(
      'spec_version: "0.1"\nprotected_denies:\n  read:\n    - a/**\n  read:\n    - b/**\n',
    );
    expect(both.kind).toBe("enforcing");
    expect(both.read).toEqual(["a/**", "b/**"]);
  });

  it("unions across multiple `---` documents for the same reason", () => {
    const salvage = salvageProtectedDenies(
      'spec_version: "0.1"\nprotected_denies:\n  read:\n    - a/**\n---\nprotected_denies:\n  read:\n    - b/**\n',
    );
    expect(salvage.kind).toBe("enforcing");
    expect(salvage.read).toEqual(["a/**", "b/**"]);
  });

  // --- per-entry salvage: one bad entry does not poison its siblings ---------

  it("drops individually unreadable entries, keeps the rest, and says how many it dropped", () => {
    const salvage = salvageProtectedDenies(
      withProtections('  read:\n    - secrets/**\n    - 42\n    - null\n    - ""\n'),
    );
    expect(salvage.kind).toBe("enforcing");
    expect(salvage.read).toEqual(["secrets/**"]);
    expect(salvage.diagnostics.map((d) => d.reason)).toEqual(["salvage.entries_dropped"]);
    expect(salvage.diagnostics[0].message, "names the dropped count").toContain("3");
    expect(salvage.diagnostics[0].phase).toBe("salvage");
  });

  // --- nothing declared is NOT a lapse --------------------------------------

  it("reports none declared for an empty protections list, with no diagnostic", () => {
    const salvage = salvageProtectedDenies(withProtections("  read: []\n  write: []\n"));
    expect(salvage.kind).toBe("none_declared");
    expect(salvage.read).toEqual([]);
    expect(salvage.diagnostics).toEqual([]);
  });

  it("reports none declared when the document has no protections section at all", () => {
    const salvage = salvageProtectedDenies('spec_version: "0.1"\nagents: []\n');
    expect(salvage.kind).toBe("none_declared");
  });

  it("reports none declared for an explicitly empty section or read key", () => {
    // `protected_denies:` with nothing after it declares nothing — the same reading
    // the healthy path gives an absent section.
    expect(salvageProtectedDenies('spec_version: "0.1"\nprotected_denies:\n').kind).toBe(
      "none_declared",
    );
    expect(salvageProtectedDenies(withProtections("  read:\n")).kind).toBe("none_declared");
  });

  it("ignores a protections section nested under another key", () => {
    // Only the document's own top-level protections govern; a `read` list living
    // somewhere else in the tree is not the spec's protections section.
    const salvage = salvageProtectedDenies(
      'spec_version: "0.1"\nsteward:\n  protected_denies:\n    read:\n      - secrets/**\n',
    );
    expect(salvage.kind).toBe("none_declared");
    expect(salvage.read).toEqual([]);
  });

  // --- damage INSIDE the protections section: the set lapses, and says so ----

  it("lapses when the protections section is the wrong type, naming what is wrong", () => {
    for (const [label, body] of [
      ["a scalar where a mapping belongs", 'spec_version: "0.1"\nprotected_denies: 3\n'],
      ["a list where a mapping belongs", 'spec_version: "0.1"\nprotected_denies:\n  - secrets/**\n'],
      ["a scalar where the read list belongs", withProtections("  read: secrets/**\n")],
      ["a mapping where the read list belongs", withProtections("  read:\n    a: b\n")],
    ] as const) {
      const salvage = salvageProtectedDenies(body);
      expect(salvage.kind, `${label}: lapses`).toBe("lapsed");
      expect(salvage.read, `${label}: refuses nothing`).toEqual([]);
      expect(salvage.diagnostics.map((d) => d.reason), `${label}: diagnostic`).toEqual([
        "salvage.protections_lapsed",
      ]);
      expect(
        salvage.diagnostics[0].message,
        `${label}: states the lapse in the words the user reads`,
      ).toContain("could not be salvaged");
      expect(salvage.diagnostics[0].message, `${label}: warns reads are open`).toContain(
        "Discovery reads stay open",
      );
    }
  });

  it("lapses when no entry in the read list is readable as a path scope", () => {
    const salvage = salvageProtectedDenies(withProtections("  read:\n    - 42\n    - true\n"));
    expect(salvage.kind).toBe("lapsed");
    expect(salvage.diagnostics[0].message).toContain("2 unreadable entries");
  });

  it("lapses when protections are declared through a merge key", () => {
    // `<<` is not honored (ADR 0025) and cannot be read structurally, so a document
    // that declares protections this way must be told they are not in effect.
    const salvage = salvageProtectedDenies(
      'spec_version: "0.1"\nbase: &b\n  read: [secrets/**]\nprotected_denies:\n  <<: *b\n',
    );
    expect(salvage.kind).toBe("lapsed");
    expect(salvage.diagnostics[0].message).toContain("merge key");
  });

  it("lapses rather than claiming none are declared when YAML errors hid the answer", () => {
    // The dangerous failure mode: garbage in, "this document declares no
    // protections" out. Nothing salvaged from an unparseable document is a LAPSE.
    for (const [label, source] of [
      ["empty file", ""],
      ["whitespace only", "   \n\n"],
      ["syntax garbage", ":\n:::\n\t- [\n"],
      ["tab indentation", "protected_denies:\n\tread:\n\t\t- secrets/**\n"],
      ["a scalar document", "just a string\n"],
      ["a list document", "- a\n- b\n"],
    ] as const) {
      const salvage = salvageProtectedDenies(source);
      expect(salvage.kind, `${label}: lapses`).toBe("lapsed");
      expect(salvage.diagnostics.length, `${label}: says so`).toBe(1);
    }
  });

  it("keeps enforcing what it could read when only part of the section is damaged", () => {
    const salvage = salvageProtectedDenies(
      'spec_version: "0.1"\nprotected_denies:\n  read:\n    - secrets/**\nprotected_denies: 3\n',
    );
    expect(salvage.kind).toBe("enforcing");
    expect(salvage.read).toEqual(["secrets/**"]);
    expect(salvage.diagnostics[0].message).toContain("could not be salvaged");
  });

  // --- the salvage boundary: protections and nothing else -------------------

  it("recovers only read scopes from a document full of grants, modes, and agents", () => {
    // The binding boundary: an invalid document yields protections, never authority.
    const salvage = salvageProtectedDenies(duplicateAgentId());
    expect(Object.keys(salvage).sort()).toEqual(["diagnostics", "kind", "read"]);
    expect(salvage.read).toEqual(["secrets/**"]);
    // The source it came from declares plenty that is NOT recovered.
    expect(duplicateAgentId()).toContain("minimum_mode: enforce");
    expect(duplicateAgentId()).toContain("ownership:");
    expect(JSON.stringify(salvage)).not.toContain("enforce");
    expect(JSON.stringify(salvage)).not.toContain("ownership");
  });

  it("does not salvage protected WRITE denies, which would add nothing", () => {
    // Every write is already blocked while the spec is broken, so a salvaged write
    // deny could not narrow anything; only the read list is recovered.
    const salvage = salvageProtectedDenies(duplicateAgentId());
    expect(healthySource(), "the source declares a protected write deny").toContain(
      "infra/production/**",
    );
    expect(JSON.stringify(salvage)).not.toContain("infra/production");
  });
});

describe("describing which read-protection regime is in effect", () => {
  it("names the count and the scopes when enforcing a salvaged set", () => {
    const line = describeProtectionSalvage(
      salvageProtectedDenies(withProtections("  read:\n    - secrets/**\n    - .env\n")),
    );
    expect(line).toContain("ENFORCING 2");
    expect(line).toContain("secrets/**");
    expect(line).toContain(".env");
    expect(line, "states the salvage boundary").toContain("no grants, modes, or validators");
  });

  it("summarizes a long salvaged set instead of printing all of it", () => {
    const many = Array.from({ length: 9 }, (_, i) => `    - dir${i}/**`).join("\n");
    const line = describeProtectionSalvage(salvageProtectedDenies(withProtections(`  read:\n${many}\n`)));
    expect(line).toContain("ENFORCING 9");
    expect(line).toContain("dir4/**");
    expect(line).not.toContain("dir5/**");
    expect(line).toContain("and 4 more");
  });

  it("says protections lapsed, and that reads are unrestricted, when nothing was salvaged", () => {
    const line = describeProtectionSalvage(salvageProtectedDenies("protected_denies: 3\n"));
    expect(line).toContain("LAPSED");
    expect(line).toContain("unrestricted");
  });

  it("distinguishes a document that declares no protections from one that lost them", () => {
    const line = describeProtectionSalvage(salvageProtectedDenies(withProtections("  read: []\n")));
    expect(line).toContain("none are declared");
    expect(line, "a document with nothing to lose has not lapsed").not.toContain("LAPSED");
  });
});
