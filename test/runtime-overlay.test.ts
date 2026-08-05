import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DomainAgent, OrcaSpecDocument } from "orcaspec";
import {
  loadRuntimeOverlay,
  overlayPathFor,
  readRuntimeOverlay,
  type RuntimeOverlayResult,
} from "../src/runtime-overlay";

/**
 * The runtime overlay loader (`.orca/runtime.yaml`, staged-promotion plan Phase 4).
 *
 * The overlay decides which programs gate a promotion, so the loader's job is to
 * produce either a value the runner can trust completely or a diagnostic — never a
 * partially-understood configuration. These tests are that specification: what a
 * usable overlay normalizes to, and what every malformed shape is DECIDED to be.
 * Nothing here reaches for a double: the loader is pure over source text.
 */

function agent(id: string, ownership: string): DomainAgent {
  return {
    id,
    name: id,
    description: `Owns ${ownership}.`,
    ownership: [ownership],
    permissions: { edit: { allow: [ownership] } },
  };
}

/** A document declaring exactly two agents, so `unknown agent` has something to miss. */
function document(): OrcaSpecDocument {
  return {
    spec_version: "0.1",
    repository: { id: "018f4f72-0000-7000-8000-0000000000aa" },
    administration: { approvers: [{ provider: "orca-local", principal: "test" }] },
    steward: { discovery: { read: { allow: ["**"], deny: [] } } },
    protected_denies: {},
    agents: [agent("web", "apps/web/**"), agent("billing", "services/billing/**")],
  };
}

function load(source: string): RuntimeOverlayResult {
  return loadRuntimeOverlay(source, document());
}

function reasonsOf(result: RuntimeOverlayResult): string[] {
  return result.kind === "invalid" ? result.diagnostics.map((d) => d.reason) : [];
}

describe("a usable overlay normalizes to exactly what the runner needs", () => {
  it("loads an overlay that declares no validators at all", () => {
    const result = load("schema_version: 1\n");

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.overlay.schemaVersion).toBe(1);
    expect(result.overlay.validations).toEqual({});
  });

  it("carries a declared retention window through, and reports none when absent", () => {
    const configured = load("schema_version: 1\nretention:\n  days: 7\n");
    const silent = load("schema_version: 1\n");

    expect(configured.kind).toBe("loaded");
    if (configured.kind !== "loaded") return;
    expect(configured.overlay.retention, "a declared window is the user's number").toEqual({
      days: 7,
    });
    expect(silent.kind).toBe("loaded");
    if (silent.kind !== "loaded") return;
    expect(
      silent.overlay.retention,
      "an absent section is absent, not a window the loader invented",
    ).toBeUndefined();
  });

  it("loads a retention window alongside validators", () => {
    const result = load(
      [
        "schema_version: 1",
        "retention:",
        "  days: 90",
        "validations:",
        "  web:",
        "    - program: npm",
        "      timeout_seconds: 30",
      ].join("\n"),
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.overlay.retention).toEqual({ days: 90 });
    expect(result.overlay.validations.web.length, "retention does not disturb validators").toBe(1);
  });

  it("defaults the optional fields: no args, and the checkout root as cwd", () => {
    const result = load(
      ["schema_version: 1", "validations:", "  web:", "    - program: ./bin/test", "      timeout_seconds: 30"].join("\n"),
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.overlay.validations.web).toEqual([
      { program: "./bin/test", args: [], cwd: "", timeoutSeconds: 30 },
    ]);
  });

  it("keeps every agent's validators in declaration order", () => {
    const result = load(
      [
        "schema_version: 1",
        "validations:",
        "  web:",
        "    - program: first",
        "      timeout_seconds: 1",
        "    - program: second",
        "      args: [--ci, --bail]",
        "      timeout_seconds: 2",
        "  billing:",
        "    - program: third",
        "      timeout_seconds: 3",
      ].join("\n"),
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.overlay.validations.web.map((v) => v.program)).toEqual(["first", "second"]);
    expect(result.overlay.validations.web[1].args).toEqual(["--ci", "--bail"]);
    expect(result.overlay.validations.billing.map((v) => v.program)).toEqual(["third"]);
  });

  it("accepts a fractional timeout, so a fast check can be given a tight budget", () => {
    const result = load(
      ["schema_version: 1", "validations:", "  web:", "    - program: quick", "      timeout_seconds: 0.5"].join("\n"),
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.overlay.validations.web[0].timeoutSeconds).toBe(0.5);
  });

  it("declares an agent with an empty validator list as validating nothing", () => {
    const result = load(["schema_version: 1", "validations:", "  web: []"].join("\n"));

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.overlay.validations).toEqual({ web: [] });
  });

  // --- cwd normalization: every spelling of the same directory ---------------

  const equivalentRoots = ['""', '"."', '"./"'];
  for (const spelling of equivalentRoots) {
    it(`treats cwd ${spelling} as the checkout root`, () => {
      const result = load(
        [
          "schema_version: 1",
          "validations:",
          "  web:",
          "    - program: t",
          `      cwd: ${spelling}`,
          "      timeout_seconds: 1",
        ].join("\n"),
      );

      expect(result.kind).toBe("loaded");
      if (result.kind !== "loaded") return;
      expect(result.overlay.validations.web[0].cwd).toBe("");
    });
  }

  it("normalizes a relative cwd to a clean POSIX path inside the checkout", () => {
    const result = load(
      [
        "schema_version: 1",
        "validations:",
        "  web:",
        "    - program: t",
        '      cwd: "./apps/./web/"',
        "      timeout_seconds: 1",
      ].join("\n"),
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.overlay.validations.web[0].cwd).toBe("apps/web");
  });
});

describe("an unusable overlay is refused with an actionable diagnostic", () => {
  /**
   * The malformed-input battery. Every row is a shape a user could really write,
   * and every row is a DECISION: the overlay is refused with this reason code
   * rather than crashing, silently defaulting, or being partially honored.
   */
  const battery: Array<{ name: string; source: string; reason: string }> = [
    // Restricted YAML — the same profile, and the same codes, as the spec loader.
    { name: "an empty file", source: "", reason: "yaml.empty" },
    { name: "a file with only a comment", source: "# nothing yet\n", reason: "yaml.empty" },
    { name: "unparseable YAML", source: "schema_version: 1\n  bad: [indent\n", reason: "yaml.parse_error" },
    {
      name: "two documents in one file",
      source: "schema_version: 1\n---\nschema_version: 1\n",
      reason: "yaml.multiple_documents",
    },
    {
      name: "a duplicated key",
      source: "schema_version: 1\nvalidations: {}\nvalidations: {}\n",
      reason: "yaml.duplicate_key",
    },
    {
      name: "a YAML anchor",
      source: "schema_version: 1\nvalidations: &shared {}\n",
      reason: "yaml.anchor",
    },
    {
      name: "a YAML alias",
      source: "schema_version: 1\nvalidations: {}\nother: *shared\n",
      reason: "yaml.alias",
    },
    // Shape: the root, and the version.
    { name: "a scalar where the overlay should be", source: "just a string\n", reason: "overlay.invalid_type" },
    { name: "a sequence where the overlay should be", source: "[]\n", reason: "overlay.invalid_type" },
    { name: "no schema_version", source: "validations: {}\n", reason: "overlay.missing_required" },
    { name: "a future schema_version", source: "schema_version: 2\n", reason: "overlay.unsupported_schema_version" },
    { name: "a schema_version of zero", source: "schema_version: 0\n", reason: "overlay.unsupported_schema_version" },
    { name: "a quoted schema_version", source: 'schema_version: "1"\n', reason: "overlay.invalid_type" },
    {
      name: "an unknown top-level field",
      source: "schema_version: 1\nvalidation: {}\n",
      reason: "overlay.unknown_field",
    },
    // Shape: the validations mapping.
    {
      name: "validations as a sequence",
      source: "schema_version: 1\nvalidations: []\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "an agent's validators as a mapping",
      source: "schema_version: 1\nvalidations:\n  web: {}\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a validator that is a bare string",
      source: "schema_version: 1\nvalidations:\n  web:\n    - npm test\n",
      reason: "overlay.invalid_type",
    },
    // Shape: one declaration's fields.
    {
      name: "a declaration with no program",
      source: "schema_version: 1\nvalidations:\n  web:\n    - timeout_seconds: 5\n",
      reason: "overlay.missing_required",
    },
    {
      name: "a declaration with no timeout",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n",
      reason: "overlay.missing_required",
    },
    {
      name: "a misspelled field name",
      source:
        "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      timeout_second: 5\n      timeout_seconds: 5\n",
      reason: "overlay.unknown_field",
    },
    {
      name: "an empty program",
      source: 'schema_version: 1\nvalidations:\n  web:\n    - program: ""\n      timeout_seconds: 5\n',
      reason: "overlay.invalid_type",
    },
    {
      name: "a numeric program",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: 7\n      timeout_seconds: 5\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a NUL byte in the program",
      source: 'schema_version: 1\nvalidations:\n  web:\n    - program: "no\\0pe"\n      timeout_seconds: 5\n',
      reason: "overlay.invalid_program",
    },
    {
      name: "args that are not a sequence",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      args: --ci\n      timeout_seconds: 5\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a non-string argument",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      args: [1]\n      timeout_seconds: 5\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a NUL byte in an argument",
      source:
        'schema_version: 1\nvalidations:\n  web:\n    - program: t\n      args: ["a\\0b"]\n      timeout_seconds: 5\n',
      reason: "overlay.invalid_argument",
    },
    {
      name: "a zero timeout",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      timeout_seconds: 0\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a negative timeout",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      timeout_seconds: -5\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a timeout beyond the maximum",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      timeout_seconds: 86400\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a quoted timeout",
      source: 'schema_version: 1\nvalidations:\n  web:\n    - program: t\n      timeout_seconds: "5"\n',
      reason: "overlay.invalid_type",
    },
    // Shape: the retention window (hardening plan, Phase 6). Retention is configured
    // in the same closed schema as everything else, so a misspelled or nonsensical
    // window is refused exactly as a misspelled timeout is — and, like every other
    // unusable overlay, it blocks the delegation rather than being quietly ignored.
    {
      name: "a retention section that configures nothing",
      source: "schema_version: 1\nretention: {}\n",
      reason: "overlay.missing_required",
    },
    {
      name: "a misspelled retention field",
      source: "schema_version: 1\nretention:\n  day: 7\n",
      reason: "overlay.unknown_field",
    },
    {
      name: "an unknown field beside a valid window",
      source: "schema_version: 1\nretention:\n  days: 7\n  sweep: false\n",
      reason: "overlay.unknown_field",
    },
    {
      name: "a retention window of zero days",
      source: "schema_version: 1\nretention:\n  days: 0\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a negative retention window",
      source: "schema_version: 1\nretention:\n  days: -7\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a fractional retention window",
      source: "schema_version: 1\nretention:\n  days: 1.5\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "a quoted retention window",
      source: 'schema_version: 1\nretention:\n  days: "7"\n',
      reason: "overlay.invalid_type",
    },
    {
      name: "a retention window beyond the maximum",
      source: "schema_version: 1\nretention:\n  days: 100000\n",
      reason: "overlay.invalid_type",
    },
    {
      name: "retention as a scalar",
      source: "schema_version: 1\nretention: 7\n",
      reason: "overlay.invalid_type",
    },
    // Meaning: the overlay against the document that will run, and the checkout.
    {
      name: "validators for an agent the document does not declare",
      source: "schema_version: 1\nvalidations:\n  mobile:\n    - program: t\n      timeout_seconds: 5\n",
      reason: "overlay.unknown_agent",
    },
    {
      name: "an absolute cwd",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      cwd: /etc\n      timeout_seconds: 5\n",
      reason: "overlay.invalid_cwd",
    },
    {
      name: "a cwd that climbs out of the checkout",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      cwd: ../elsewhere\n      timeout_seconds: 5\n",
      reason: "overlay.invalid_cwd",
    },
    {
      name: "a cwd that climbs out through a real directory",
      source:
        "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      cwd: apps/../../elsewhere\n      timeout_seconds: 5\n",
      reason: "overlay.invalid_cwd",
    },
    {
      name: "a Windows-style absolute cwd",
      source: 'schema_version: 1\nvalidations:\n  web:\n    - program: t\n      cwd: "C:\\\\build"\n      timeout_seconds: 5\n',
      reason: "overlay.invalid_cwd",
    },
    {
      name: "a numeric cwd",
      source: "schema_version: 1\nvalidations:\n  web:\n    - program: t\n      cwd: 7\n      timeout_seconds: 5\n",
      reason: "overlay.invalid_type",
    },
  ];

  for (const { name, source, reason } of battery) {
    it(`refuses ${name} with ${reason}`, () => {
      const result = load(source);

      expect(result.kind, `${name} must not load`).toBe("invalid");
      expect(reasonsOf(result), `${name} must report ${reason}`).toContain(reason);
    });
  }

  it("names the overlay, not the OrcaSpec document, when its YAML is broken", () => {
    const result = load("schema_version: 1\n  bad: [indent\n");

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    // A user sent to fix `.orca/orca.yaml` for a `.orca/runtime.yaml` problem would
    // find nothing wrong with it.
    expect(result.diagnostics[0].message).toContain("The Orca runtime overlay");
    expect(result.diagnostics[0].message).not.toContain("OrcaSpec");
  });

  it("reports every problem in one pass rather than only the first", () => {
    const result = load(
      [
        "schema_version: 1",
        "validations:",
        "  web:",
        "    - program: t",
        "      nonsense: 1",
        "      timeout_seconds: 5",
        "  billing:",
        "    - timeout_seconds: 5",
      ].join("\n"),
    );

    expect(reasonsOf(result).sort()).toEqual([
      "overlay.missing_required",
      "overlay.unknown_field",
    ]);
  });

  it("anchors each diagnostic at the offending declaration", () => {
    const result = load(
      [
        "schema_version: 1",
        "validations:",
        "  web:",
        "    - program: fine",
        "      timeout_seconds: 5",
        "    - program: t",
        "      cwd: /absolute",
        "      timeout_seconds: 5",
      ].join("\n"),
    );

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.diagnostics[0].pointer).toBe("/validations/web/1/cwd");
    expect(result.diagnostics[0].path).toBe("validations.web[1].cwd");
  });
});

describe("reading the overlay off a repository", () => {
  function withTempDir(body: (dir: string) => void): void {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "orca-overlay-")));
    try {
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reports absent when the repository has no overlay", () => {
    withTempDir((dir) => {
      expect(readRuntimeOverlay(dir, document()).kind).toBe("absent");
    });
  });

  it("reports absent when the repository has an `.orca` directory but no overlay", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".orca"));
      expect(readRuntimeOverlay(dir, document()).kind).toBe("absent");
    });
  });

  it("reports absent when the overlay path is a directory, matching the spec loader", () => {
    withTempDir((dir) => {
      mkdirSync(overlayPathFor(dir), { recursive: true });
      expect(readRuntimeOverlay(dir, document()).kind).toBe("absent");
    });
  });

  it("loads the overlay a repository does have", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".orca"));
      writeFileSync(
        overlayPathFor(dir),
        ["schema_version: 1", "validations:", "  web:", "    - program: npm", "      args: [test]", "      timeout_seconds: 60"].join("\n"),
      );

      const result = readRuntimeOverlay(dir, document());

      expect(result.kind).toBe("loaded");
      if (result.kind !== "loaded") return;
      expect(result.overlay.validations.web[0]).toEqual({
        program: "npm",
        args: ["test"],
        cwd: "",
        timeoutSeconds: 60,
      });
    });
  });
});
