import { describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import type { OrcaSpecDocument } from "orcaspec";
import { classifyBrokenSpec, classifyDiscovery, classifyWrite } from "../src/governance";
import { loadSpec } from "../src/load";
import type {
  BrokenSpecState,
  InvalidSpecState,
  UnsupportedSpecVersionState,
} from "../src/state";

/**
 * Pure steward-governance decisions: the full enforce/advisory matrix over the
 * OrcaSpec fixtures, with no pi and no filesystem. The impure symlink/realpath
 * reduction lives in index.ts and is exercised in governance-handler.test.ts;
 * here the discovery target is supplied directly as { path, symlink }.
 */
describe("classifyWrite", () => {
  const doc = orcaspec.loadFixture("multi-owner");

  it("blocks a parent write into an owned scope in enforce mode, naming the owner and delegation", () => {
    const decision = classifyWrite(doc, "enforce", "apps/web/app.tsx");
    expect(decision.verdict).toBe("block");
    expect(decision.owner).toBe("web");
    expect(decision.reason).toContain("web");
    expect(decision.reason).toContain("orca_delegate");
  });

  it("routes a nested target to the most-specific owner", () => {
    const decision = classifyWrite(doc, "enforce", "apps/web/components/button.tsx");
    expect(decision.owner).toBe("design-system");
    expect(decision.verdict).toBe("block");
  });

  it("blocks writes into each distinct owned scope with the correct owner", () => {
    expect(classifyWrite(doc, "enforce", "services/billing/invoice.rb").owner).toBe("billing");
    expect(classifyWrite(doc, "enforce", "infra/main.tf").owner).toBe("infra");
  });

  it("flags (does not block) the same owned write in advisory mode", () => {
    const decision = classifyWrite(doc, "advisory", "apps/web/app.tsx");
    expect(decision.verdict).toBe("flag");
    expect(decision.owner).toBe("web");
    expect(decision.reason).toContain("orca_delegate");
  });

  it("fails an unowned write closed in enforce, flags it in advisory (ADR 0012)", () => {
    const enforce = classifyWrite(doc, "enforce", "scripts/deploy.rb");
    expect(enforce.verdict).toBe("block");
    expect(enforce.owner).toBeNull();
    expect(enforce.reason).toContain("not owned");
    expect(enforce.reason).toContain("0012");

    const advisory = classifyWrite(doc, "advisory", "scripts/deploy.rb");
    expect(advisory.verdict).toBe("flag");
    expect(advisory.owner).toBeNull();
  });

  it("treats a write outside the repository as a stewardship-boundary crossing", () => {
    const enforce = classifyWrite(doc, "enforce", null);
    expect(enforce.verdict).toBe("block");
    expect(enforce.reason).toContain("stewardship boundary");
    expect(classifyWrite(doc, "advisory", null).verdict).toBe("flag");
  });
});

describe("classifyDiscovery", () => {
  const doc = orcaspec.loadFixture("multi-owner"); // allow **, deny + protected read secrets/**

  it("allows an in-scope read", () => {
    const decision = classifyDiscovery(doc, "enforce", { path: "apps/web/app.tsx", symlink: false });
    expect(decision.verdict).toBe("allow");
  });

  it("allows the repository root (pathless call) under a ** discovery scope", () => {
    expect(classifyDiscovery(doc, "enforce", { path: "", symlink: false }).verdict).toBe("allow");
  });

  it("blocks a protected-deny read in BOTH modes (non-overridable, ADR 0015/0068)", () => {
    for (const mode of ["enforce", "advisory"] as const) {
      const decision = classifyDiscovery(doc, mode, { path: "secrets/prod.key", symlink: false });
      expect(decision.verdict).toBe("block");
      expect(decision.reason).toContain("protected deny");
    }
  });

  it("blocks a symlink read in enforce, flags it in advisory (ADR 0032)", () => {
    const enforce = classifyDiscovery(doc, "enforce", { path: "apps/web/app.tsx", symlink: true });
    expect(enforce.verdict).toBe("block");
    expect(enforce.reason).toContain("symbolic link");
    expect(classifyDiscovery(doc, "advisory", { path: "apps/web/app.tsx", symlink: true }).verdict).toBe(
      "flag",
    );
  });

  it("prefers the protected-deny verdict over the symlink verdict (both modes block)", () => {
    const decision = classifyDiscovery(doc, "advisory", { path: "secrets/prod.key", symlink: true });
    expect(decision.verdict).toBe("block");
    expect(decision.reason).toContain("protected deny");
  });

  it("blocks a read outside the repository (escaped target) in enforce, flags in advisory", () => {
    expect(classifyDiscovery(doc, "enforce", { path: null, symlink: false }).verdict).toBe("block");
    expect(classifyDiscovery(doc, "advisory", { path: null, symlink: false }).verdict).toBe("flag");
  });

  it("splits an out-of-scope (non-protected) read by mode: enforce blocks, advisory flags", () => {
    const narrow: OrcaSpecDocument = structuredClone(doc);
    narrow.steward.discovery.read = { allow: ["docs/**"], deny: [] };
    const enforce = classifyDiscovery(narrow, "enforce", { path: "apps/web/app.tsx", symlink: false });
    expect(enforce.verdict).toBe("block");
    expect(enforce.reason).toContain("discovery read scope");
    expect(
      classifyDiscovery(narrow, "advisory", { path: "apps/web/app.tsx", symlink: false }).verdict,
    ).toBe("flag");
  });

  it("treats an ordinary discovery deny by mode, distinct from a protected deny", () => {
    const doc2: OrcaSpecDocument = structuredClone(doc);
    doc2.steward.discovery.read = { allow: ["**"], deny: ["build/**"] };
    // build/** is an ordinary discovery deny (not in protected_denies): mode-split.
    expect(classifyDiscovery(doc2, "enforce", { path: "build/out.js", symlink: false }).verdict).toBe(
      "block",
    );
    expect(classifyDiscovery(doc2, "advisory", { path: "build/out.js", symlink: false }).verdict).toBe(
      "flag",
    );
    // secrets/** remains a protected deny: blocked in both modes.
    expect(classifyDiscovery(doc2, "advisory", { path: "secrets/x", symlink: false }).verdict).toBe(
      "block",
    );
  });
});

/**
 * A real broken state, built from an OrcaSpec fixture through the real loader —
 * no filesystem, no hand-written diagnostics. `cwd`/`specPath` are the two fields
 * `detectRepositoryState` adds around the load outcome.
 */
function invalidSpecStateFor(fixture: string): InvalidSpecState {
  const outcome = loadSpec(orcaspec.loadFixtureSource(fixture));
  if (outcome.kind !== "invalid_spec") throw new Error(`fixture ${fixture} is ${outcome.kind}`);
  return { ...outcome, kind: "invalid_spec", cwd: "/repo", specPath: "/repo/.orca/orca.yaml" };
}

function unsupportedVersionStateFor(fixture: string): UnsupportedSpecVersionState {
  const outcome = loadSpec(orcaspec.loadFixtureSource(fixture));
  if (outcome.kind !== "unsupported_spec_version") {
    throw new Error(`fixture ${fixture} is ${outcome.kind}`);
  }
  return {
    ...outcome,
    kind: "unsupported_spec_version",
    cwd: "/repo",
    specPath: "/repo/.orca/orca.yaml",
  };
}

describe("classifyBrokenSpec", () => {
  // --- invalid_spec: writes fail closed in both modes ----------------------

  it("blocks write and edit in invalid_spec, carrying the spec path and a diagnostic", () => {
    const state = invalidSpecStateFor("duplicate-agent-id");
    for (const tool of ["write", "edit"] as const) {
      const decision = classifyBrokenSpec(state, tool, null);
      expect(decision.verdict, `${tool} verdict`).toBe("block");
      expect(decision.owner, `${tool} owner`).toBeNull();
      expect(decision.reason, `${tool} names the state`).toContain("invalid_spec");
      expect(decision.reason, `${tool} names the spec file`).toContain("/repo/.orca/orca.yaml");
      expect(decision.reason, `${tool} carries a diagnostic`).toContain(
        state.diagnostics[0].message,
      );
      expect(decision.reason, `${tool} carries a diagnostic code`).toContain(
        state.diagnostics[0].reason,
      );
    }
  });

  // --- unsupported_spec_version: names found vs supported version ----------

  it("blocks a write in unsupported_spec_version, naming the found and supported versions", () => {
    const state = unsupportedVersionStateFor("unsupported-spec-version");
    const decision = classifyBrokenSpec(state, "write", null);
    expect(decision.verdict).toBe("block");
    expect(decision.reason).toContain("unsupported_spec_version");
    // Both versions appear in their correct ROLES: naming them in the wrong order
    // would send the reader to fix the wrong end of the mismatch.
    expect(decision.reason).toContain(`declares spec_version '${state.foundVersion}'`);
    expect(decision.reason).toContain(`supports '${state.supportedVersion}'`);
    expect(state.foundVersion).not.toBe(state.supportedVersion);
    expect(decision.reason).toContain(state.diagnostics[0].message);
  });

  // --- discovery reads stay available so the spec can be diagnosed ----------

  it("allows every discovery tool in both broken states so the user can diagnose", () => {
    const states = [
      invalidSpecStateFor("duplicate-agent-id"),
      unsupportedVersionStateFor("unsupported-spec-version"),
    ];
    for (const state of states) {
      for (const tool of ["read", "grep", "find", "ls"] as const) {
        const decision = classifyBrokenSpec(state, tool, { path: "src/app.ts", symlink: false });
        expect(decision.verdict, `${state.kind} ${tool} verdict`).toBe("allow");
        expect(decision.reason, `${state.kind} ${tool} reason`).toBe("");
        expect(decision.owner, `${state.kind} ${tool} owner`).toBeNull();
      }
    }
  });

  it("blocks any tool outside the four discovery tools (allowlist, not a write denylist)", () => {
    // Discovery is allowlisted, so a governed tool introduced later fails closed
    // here by default instead of passing through unnoticed.
    const state = invalidSpecStateFor("duplicate-agent-id");
    expect(classifyBrokenSpec(state, "bash" as never, null).verdict).toBe("block");
  });

  // --- decided edges of the diagnostics payload ----------------------------

  it("still blocks when the state carries no diagnostics at all", () => {
    // The loader always reports at least one, but failing closed must not depend
    // on that: no diagnostics is not a reason to allow the write.
    const state: InvalidSpecState = { ...invalidSpecStateFor("duplicate-agent-id"), diagnostics: [] };
    const decision = classifyBrokenSpec(state, "write", null);
    expect(decision.verdict).toBe("block");
    expect(decision.reason).toContain("none were reported");
  });

  it("truncates a long diagnostic list and points at /orca for the rest", () => {
    const one = invalidSpecStateFor("duplicate-agent-id").diagnostics[0];
    const state: InvalidSpecState = {
      ...invalidSpecStateFor("duplicate-agent-id"),
      diagnostics: Array.from({ length: 9 }, (_, index) => ({ ...one, message: `problem ${index}` })),
    };
    const decision = classifyBrokenSpec(state, "write", null);
    expect(decision.verdict).toBe("block");
    expect(decision.reason).toContain("Spec diagnostics (9):");
    expect(decision.reason).toContain("problem 0");
    expect(decision.reason).toContain("problem 4");
    expect(decision.reason).not.toContain("problem 5");
    expect(decision.reason).toContain("and 4 more");
  });
});

/**
 * A broken state built from arbitrary source text, so a test can choose what the
 * unusable document declares. Runs through the real loader and the real salvage,
 * exactly as `detectRepositoryState` does.
 */
function brokenStateFor(source: string): BrokenSpecState {
  const outcome = loadSpec(source);
  const around = { cwd: "/repo", specPath: "/repo/.orca/orca.yaml" };
  if (outcome.kind === "invalid_spec") return { ...outcome, kind: "invalid_spec", ...around };
  if (outcome.kind === "unsupported_spec_version") {
    return { ...outcome, kind: "unsupported_spec_version", ...around };
  }
  throw new Error("source validates; a broken-spec case must not");
}

/** The multi-owner fixture (protected read deny `secrets/**`) broken far from its protections. */
function brokenElsewhere(): string {
  return `${orcaspec.loadFixtureSource("multi-owner")}\nnot_a_section:\n  anything: true\n`;
}

const BOTH_MODES = ["advisory", "enforce"] as const;
const DISCOVERY = ["read", "grep", "find", "ls"] as const;

describe("classifyBrokenSpec with salvaged read protections", () => {
  // --- a protected path stays refused while the spec is broken ---------------

  it("refuses a read of a salvaged protected path with every discovery tool, in both modes", () => {
    // The requested mode is not even an input here: a protected deny is
    // non-overridable (ADR 0015, 0068), and a broken spec cannot weaken it.
    const state = brokenStateFor(brokenElsewhere());
    for (const tool of DISCOVERY) {
      const decision = classifyBrokenSpec(state, tool, { path: "secrets/aws.json", symlink: false });
      expect(decision.verdict, `${tool} verdict`).toBe("block");
      expect(decision.owner, `${tool} owner`).toBeNull();
      expect(decision.reason, `${tool} names the path`).toContain("secrets/aws.json");
      expect(decision.reason, `${tool} names the salvaged scope`).toContain("secrets/**");
    }
  });

  it("still lets every other discovery read through, so the document can be diagnosed", () => {
    const state = brokenStateFor(brokenElsewhere());
    for (const tool of DISCOVERY) {
      const decision = classifyBrokenSpec(state, tool, {
        path: ".orca/orca.yaml",
        symlink: false,
      });
      expect(decision.verdict, `${tool} verdict`).toBe("allow");
      expect(decision.reason, `${tool} reason`).toBe("");
    }
  });

  it("matches a salvaged scope exactly as the healthy path matches the same scope", () => {
    // A pattern must mean the same thing broken or healthy, so both paths run the
    // same `matchesAny`: `secrets/**` covers the directory itself and everything under it.
    const state = brokenStateFor(brokenElsewhere());
    const healthy = orcaspec.loadFixture("multi-owner");
    for (const path of ["secrets", "secrets/aws.json", "secrets/nested/deep.pem"]) {
      const broken = classifyBrokenSpec(state, "read", { path, symlink: false });
      expect(broken.verdict, `${path}: refused while broken`).toBe("block");
      expect(
        classifyDiscovery(healthy, "enforce", { path, symlink: false }).verdict,
        `${path}: refused while healthy`,
      ).toBe("block");
    }
    // And a sibling that merely shares a prefix is not under the scope either way.
    expect(classifyBrokenSpec(state, "read", { path: "secrets-old/x", symlink: false }).verdict).toBe(
      "allow",
    );
  });

  it("refuses a protected path a symlink resolved onto, not the link that reached it", () => {
    // Discovery stays open while broken, so symlink traversal alone is allowed — but
    // the resolved target is what the salvaged set is checked against, so a link
    // cannot launder a read of a protected path.
    const state = brokenStateFor(brokenElsewhere());
    expect(classifyBrokenSpec(state, "read", { path: "secrets/aws.json", symlink: true }).verdict).toBe(
      "block",
    );
    expect(classifyBrokenSpec(state, "read", { path: "docs/readme.md", symlink: true }).verdict).toBe(
      "allow",
    );
  });

  it("refuses the repository root itself when the salvaged set covers everything", () => {
    const state = brokenStateFor(
      'spec_version: "0.1"\nprotected_denies:\n  read:\n    - "**"\n',
    );
    expect(classifyBrokenSpec(state, "ls", { path: "", symlink: false }).verdict).toBe("block");
  });

  it("allows a read that escaped the repository, which no repository-relative scope can cover", () => {
    // Decided: the broken regime does not police the stewardship boundary for reads
    // (they are open for diagnosis), and salvage only ADDS refusals. A target outside
    // the repository is not under a repository-relative protected deny.
    const state = brokenStateFor(brokenElsewhere());
    expect(classifyBrokenSpec(state, "read", { path: null, symlink: false }).verdict).toBe("allow");
  });

  // --- a lapsed set leaves reads open, and never pretends otherwise ----------

  it("leaves reads open when the protections themselves could not be salvaged", () => {
    const state = brokenStateFor('spec_version: "0.1"\nprotected_denies: 3\n');
    for (const tool of DISCOVERY) {
      const decision = classifyBrokenSpec(state, tool, { path: "secrets/aws.json", symlink: false });
      expect(decision.verdict, `${tool} verdict`).toBe("allow");
    }
  });

  // --- nothing else from the document takes effect ---------------------------

  it("blocks a write the unusable document's own grant would have allowed", () => {
    // The salvage boundary: protections are honored, authority never is. `infra/**`
    // is the infra agent's ownership and edit grant in this very document.
    const state = brokenStateFor(brokenElsewhere());
    for (const mode of BOTH_MODES) {
      for (const tool of ["write", "edit"] as const) {
        const decision = classifyBrokenSpec(state, tool, {
          path: "infra/main.tf",
          symlink: false,
        });
        expect(decision.verdict, `${mode} ${tool} on a granted path`).toBe("block");
        expect(decision.owner, `${mode} ${tool} owner`).toBeNull();
      }
    }
  });

  it("blocks a write into a salvaged protected path as a broken-spec block, not a read refusal", () => {
    const state = brokenStateFor(brokenElsewhere());
    const decision = classifyBrokenSpec(state, "write", { path: "secrets/aws.json", symlink: false });
    expect(decision.verdict).toBe("block");
    expect(decision.reason, "the write block explains the broken spec").toContain("fails closed");
  });

  // --- every block says which regime is in effect ---------------------------

  it("states the enforced salvaged set in the read refusal and in the write block alike", () => {
    const state = brokenStateFor(brokenElsewhere());
    const refusal = classifyBrokenSpec(state, "read", { path: "secrets/aws.json", symlink: false });
    const write = classifyBrokenSpec(state, "write", null);
    for (const [label, reason] of [["read refusal", refusal.reason], ["write block", write.reason]]) {
      expect(reason, `${label}: names the regime`).toContain("ENFORCING 1");
      expect(reason, `${label}: names the scope`).toContain("secrets/**");
      expect(reason, `${label}: states the salvage boundary`).toContain(
        "no grants, modes, or validators",
      );
    }
  });

  it("states the lapse in the write block when protections could not be salvaged", () => {
    const state = brokenStateFor('spec_version: "0.1"\nprotected_denies: 3\n');
    const reason = classifyBrokenSpec(state, "write", null).reason;
    expect(reason).toContain("LAPSED");
    expect(reason).toContain("unrestricted");
  });

  it("refuses a discovery call that supplies no target at all while a set is enforced", () => {
    // Decided: null means "this call has no discovery target" — what a write passes.
    // A discovery tool arriving without one is a caller bug, and while there is
    // something to protect the safe answer is to refuse rather than to read blind.
    const enforcing = brokenStateFor(brokenElsewhere());
    expect(classifyBrokenSpec(enforcing, "read", null).verdict).toBe("block");
    // With no salvaged set there is nothing to protect, so diagnosis stays open.
    const lapsedState = brokenStateFor('spec_version: "0.1"\nprotected_denies: 3\n');
    expect(classifyBrokenSpec(lapsedState, "read", null).verdict).toBe("allow");
  });

  it("says protections are simply not declared when the document declares none", () => {
    const state = invalidSpecStateFor("duplicate-agent-id"); // declares `read: []`
    const reason = classifyBrokenSpec(state, "write", null).reason;
    expect(reason).toContain("none are declared");
    expect(reason, "nothing was lost, so nothing lapsed").not.toContain("LAPSED");
  });
});
