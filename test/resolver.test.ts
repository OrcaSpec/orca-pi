import { describe, expect, it } from "vitest";
import * as orcaspec from "orcaspec";
import type { DomainAgent, OrcaSpecDocument } from "orcaspec";
import { compileGrant, resolve, type Resolution } from "../src/resolver";

/** Project a Resolution onto the exact normative vector `expected` shape. */
function toVectorExpected(resolution: Resolution) {
  return {
    perTarget: resolution.perTarget,
    delegations: resolution.delegations,
    unownedPaths: resolution.unownedPaths,
  };
}

// ---- Vector conformance (normative) -------------------------------------------------

describe("resolver vector conformance", () => {
  const vectors = orcaspec.loadAllVectors();

  it("ships at least the six bootstrap vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
  });

  // Data-driven so new upstream vectors auto-enroll without editing this file.
  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    "reproduces %s exactly",
    (_name, vector) => {
      const document = orcaspec.loadFixture(vector.specRef);
      const resolution = resolve(document, vector.targets);
      expect(toVectorExpected(resolution)).toEqual(vector.expected);
    },
  );
});

// ---- Synthetic document helpers -----------------------------------------------------

function agent(id: string, partial: Partial<DomainAgent> & Pick<DomainAgent, "ownership">): DomainAgent {
  return {
    id,
    name: id,
    description: `${id} agent`,
    ownership: partial.ownership,
    permissions: partial.permissions ?? {},
  };
}

function doc(
  agents: DomainAgent[],
  protectedDenies: OrcaSpecDocument["protected_denies"] = {},
): OrcaSpecDocument {
  return {
    spec_version: "0.1",
    repository: { id: "018f4f72-0000-7000-8000-000000000099" },
    administration: { approvers: [{ provider: "orca-local", principal: "test" }] },
    steward: { discovery: { read: { allow: ["**"], deny: [] } } },
    protected_denies: protectedDenies,
    agents,
  };
}

// ---- Table-driven unit tests --------------------------------------------------------

describe("most-specific-owner selection across three levels of nesting", () => {
  const spec = doc([
    agent("outer", { ownership: ["a/**"], permissions: { edit: { allow: ["a/**"] } } }),
    agent("middle", { ownership: ["a/b/**"], permissions: { edit: { allow: ["a/b/**"] } } }),
    agent("inner", { ownership: ["a/b/c/**"], permissions: { edit: { allow: ["a/b/c/**"] } } }),
  ]);

  it.each([
    ["a/z.ts", "outer"],
    ["a/b/y.ts", "middle"],
    ["a/b/c/x.ts", "inner"],
  ])("routes %s to %s", (path, owner) => {
    const resolution = resolve(spec, [path]);
    expect(resolution.perTarget[0]).toMatchObject({ owner, unowned: false });
  });

  it("records the less-specific matches it trimmed", () => {
    const resolution = resolve(spec, ["a/b/c/x.ts"]);
    const others = resolution.reasoning[0].otherMatches.map((match) => match.owner).sort();
    expect(others).toEqual(["middle", "outer"]);
    expect(resolution.reasoning[0].matchedScope).toBe("a/b/c/**");
  });
});

describe("authority intersection", () => {
  it("permissions narrower than ownership: an owned path with no write authority is not writable", () => {
    const spec = doc([
      agent("svc", {
        ownership: ["src/**"],
        // No edit; write.allow covers only part of the owned tree.
        permissions: { write: { allow: ["src/lib/**"] } },
      }),
    ]);
    const resolution = resolve(spec, ["src/lib/a.ts", "src/app/b.ts"]);
    expect(resolution.perTarget).toEqual([
      { path: "src/lib/a.ts", owner: "svc", unowned: false, writable: true },
      { path: "src/app/b.ts", owner: "svc", unowned: false, writable: false },
    ]);
    expect(resolution.reasoning[1].noWriteAuthority).toBe(true);
  });

  it("ownership narrower than permissions: a cross-domain read never leaks into write.allow", () => {
    const spec = doc([
      agent("web", {
        ownership: ["apps/web/**"],
        permissions: { read: { allow: ["docs/shared/**"] }, edit: { allow: ["apps/web/**"] } },
      }),
    ]);
    const { grant } = resolve(spec, ["apps/web/a.tsx"]).delegations[0];
    expect(grant.read.allow).toEqual(["apps/web/**", "docs/shared/**"]);
    expect(grant.write.allow).toEqual(["apps/web/**"]);
  });
});

describe("edit-shorthand expansion and read/write independence", () => {
  it("expands edit into both read and write while a read-only scope stays read-only", () => {
    const grant = compileGrant(
      agent("billing", {
        ownership: ["services/billing/**"],
        permissions: {
          read: { allow: ["docs/shared/**"] },
          edit: { allow: ["services/billing/**"] },
        },
      }),
      {},
    );
    expect(grant.read.allow).toEqual(["docs/shared/**", "services/billing/**"]);
    expect(grant.write.allow).toEqual(["services/billing/**"]);
  });

  it("sorts and de-duplicates a scope that appears in several permission fields", () => {
    const grant = compileGrant(
      agent("dup", {
        ownership: ["z/**"],
        permissions: {
          read: { allow: ["z/**", "a/**"] },
          edit: { allow: ["z/**", "a/**"] },
        },
      }),
      {},
    );
    expect(grant.read.allow).toEqual(["a/**", "z/**"]);
    expect(grant.write.allow).toEqual(["a/**", "z/**"]);
  });
});

describe("deny precedence", () => {
  it("agent write-deny beats allow and is classified as an agent deny", () => {
    const spec = doc([
      agent("billing", {
        ownership: ["services/billing/**"],
        permissions: {
          edit: { allow: ["services/billing/**"] },
          write: { deny: ["services/billing/generated/**"] },
        },
      }),
    ]);
    const resolution = resolve(spec, ["services/billing/generated/schema.rb"]);
    expect(resolution.perTarget[0].writable).toBe(false);
    expect(resolution.reasoning[0].writeDeny).toEqual({
      scope: "services/billing/generated/**",
      source: "agent",
    });
  });

  it("protected write-deny inside an owned, edit-permitted scope wins and is classified protected", () => {
    const spec = doc(
      [agent("infra", { ownership: ["infra/**"], permissions: { edit: { allow: ["infra/**"] } } })],
      { write: ["infra/production/**"] },
    );
    const resolution = resolve(spec, ["infra/staging/x.sh", "infra/production/x.sh"]);
    expect(resolution.perTarget.map((target) => target.writable)).toEqual([true, false]);
    expect(resolution.reasoning[1].writeDeny).toEqual({
      scope: "infra/production/**",
      source: "protected",
    });
  });

  it("prefers the protected deny when both a protected and an agent deny match", () => {
    const spec = doc(
      [
        agent("infra", {
          ownership: ["infra/**"],
          permissions: {
            edit: { allow: ["infra/**"] },
            write: { deny: ["infra/production/**"] },
          },
        }),
      ],
      { write: ["infra/**"] },
    );
    const resolution = resolve(spec, ["infra/production/x.sh"]);
    expect(resolution.reasoning[0].writeDeny?.source).toBe("protected");
  });
});

describe("unowned targets", () => {
  it("flags unowned targets distinctly while owned siblings still route", () => {
    const spec = doc([
      agent("web", { ownership: ["apps/web/**"], permissions: { edit: { allow: ["apps/web/**"] } } }),
    ]);
    const resolution = resolve(spec, ["scripts/deploy.rb", "apps/web/app.tsx"]);
    expect(resolution.perTarget).toEqual([
      { path: "scripts/deploy.rb", owner: null, unowned: true, writable: false },
      { path: "apps/web/app.tsx", owner: "web", unowned: false, writable: true },
    ]);
    expect(resolution.unownedPaths).toEqual(["scripts/deploy.rb"]);
    expect(resolution.delegations.map((delegation) => delegation.owner)).toEqual(["web"]);
  });
});

describe("delegation grouping", () => {
  it("emits one delegation per owner ordered by owner id, targets in input order", () => {
    const spec = doc([
      agent("web", { ownership: ["apps/web/**"], permissions: { edit: { allow: ["apps/web/**"] } } }),
      agent("api", { ownership: ["services/api/**"], permissions: { edit: { allow: ["services/api/**"] } } }),
    ]);
    const resolution = resolve(spec, [
      "apps/web/one.tsx",
      "services/api/two.rb",
      "apps/web/three.tsx",
    ]);
    expect(resolution.delegations.map((delegation) => delegation.owner)).toEqual(["api", "web"]);
    const web = resolution.delegations.find((delegation) => delegation.owner === "web")!;
    expect(web.targets).toEqual(["apps/web/one.tsx", "apps/web/three.tsx"]);
  });
});
