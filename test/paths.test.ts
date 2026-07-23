import { describe, expect, it } from "vitest";
import { matchScope, matchesAny, normalizeTarget, specificityRank } from "../src/paths";

describe("matchScope", () => {
  it("`**` matches anything", () => {
    expect(matchScope("a/b/c", "**")).toBe(true);
    expect(matchScope("x", "**")).toBe(true);
  });

  it("`D/**` matches D itself and anything under D, but not a sibling prefix", () => {
    expect(matchScope("apps/web", "apps/web/**")).toBe(true);
    expect(matchScope("apps/web/app.tsx", "apps/web/**")).toBe(true);
    expect(matchScope("apps/web-legacy/app.tsx", "apps/web/**")).toBe(false);
    expect(matchScope("apps/webbing", "apps/web/**")).toBe(false);
  });

  it("an exact scope matches only that exact path", () => {
    expect(matchScope("a/b.ts", "a/b.ts")).toBe(true);
    expect(matchScope("a/b.ts.bak", "a/b.ts")).toBe(false);
    expect(matchScope("a/b", "a/b.ts")).toBe(false);
  });

  it("matchesAny is true when any scope matches", () => {
    expect(matchesAny("infra/production/x", ["secrets/**", "infra/production/**"])).toBe(true);
    expect(matchesAny("infra/staging/x", ["secrets/**", "infra/production/**"])).toBe(false);
  });
});

describe("specificityRank", () => {
  it("orders exact above its containing recursive prefix, deeper above shallower", () => {
    const globAll = specificityRank("**");
    const shallow = specificityRank("apps/web/**");
    const deep = specificityRank("apps/web/components/**");
    const exact = specificityRank("apps/web/app.tsx");
    expect(globAll).toBeLessThan(shallow);
    expect(shallow).toBeLessThan(deep);
    // An exact path outranks the recursive prefix at the same segment depth.
    expect(specificityRank("apps/web")).toBeGreaterThan(specificityRank("apps/web/**"));
    expect(exact).toBeGreaterThan(deep);
  });
});

describe("normalizeTarget", () => {
  const root = "/repo";

  it("keeps a clean repository-relative path", () => {
    expect(normalizeTarget("apps/web/app.tsx", root)).toEqual({ ok: true, path: "apps/web/app.tsx" });
  });

  it("collapses `.` and redundant separators", () => {
    expect(normalizeTarget("./apps//web/./app.tsx", root)).toEqual({
      ok: true,
      path: "apps/web/app.tsx",
    });
  });

  it("rewrites an absolute path inside the repository to relative", () => {
    expect(normalizeTarget("/repo/apps/web/app.tsx", root)).toEqual({
      ok: true,
      path: "apps/web/app.tsx",
    });
  });

  it("rejects a `..` escape", () => {
    const result = normalizeTarget("../secrets/key", root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("escapes");
  });

  it("rejects an interior traversal that climbs out", () => {
    const result = normalizeTarget("apps/../../etc/passwd", root);
    expect(result.ok).toBe(false);
  });

  it("rejects an absolute path outside the repository", () => {
    const result = normalizeTarget("/etc/passwd", root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("escapes");
  });

  it("rejects an empty or whitespace-only path", () => {
    expect(normalizeTarget("", root).ok).toBe(false);
    expect(normalizeTarget("   ", root).ok).toBe(false);
  });

  it("rejects the repository root itself", () => {
    const result = normalizeTarget(".", root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("root");
  });
});
