import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStateRoot } from "./git-fixture";
import type { OrcaSpecDocument } from "orcaspec";
import {
  DEFAULT_RETENTION_DAYS,
  retentionDaysFor,
  retentionSweepLine,
  runRetentionSweep,
  sweepPreservedArtifacts,
} from "../src/retention";

/**
 * The one double in this file, standing in for the FILESYSTEM — a boundary the
 * extension does not own — so the listing/unlink race can be reproduced on demand.
 * Every other `node:fs` call passes through to the real thing, including the fixtures
 * below, and only the test that sets `race.enoent` sees anything unusual.
 */
const race = vi.hoisted(() => ({ enoent: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (!race.enoent) return actual.unlinkSync(path);
      throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${String(path)}'`), {
        code: "ENOENT",
      });
    },
  };
});

/**
 * Age-based evidence retention (hardening plan, Phase 6).
 *
 * The sweeper deletes files, so these tests are deliberately about REAL files with
 * REAL timestamps: every age is set with `utimesSync` on a file in a temp state root
 * and the window is compared against a `now` the test passes in. Nothing here mocks a
 * clock, because the thing under test is a `stat` of the filesystem.
 */

const DAY_MS = 86_400_000;

/** A wall clock the tests can compute ages against; a fixed instant, not a mock. */
const NOW = Date.parse("2026-08-05T12:00:00Z");

/** Write a file under `<stateRoot>/<dir>` whose mtime is `ageDays` old. */
function artifact(stateRoot: string, dir: string, name: string, ageDays: number): string {
  const directory = join(stateRoot, dir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, `contents of ${name}\n`);
  const when = new Date(NOW - ageDays * DAY_MS);
  utimesSync(path, when, when);
  return path;
}

/** A preserved cumulative evidence patch of the given age. */
function evidencePatch(stateRoot: string, id: string, ageDays: number): string {
  return artifact(stateRoot, "patches", `${id}.patch`, ageDays);
}

describe("a swept file is past the window and referenced by nothing", () => {
  it("removes an evidence patch older than the window and keeps a younger one", () => {
    const stateRoot = makeStateRoot();
    const aged = evidencePatch(stateRoot, "aged", 40);
    const young = evidencePatch(stateRoot, "young", 3);

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 30,
      referenced: [],
    });

    expect(sweep.removed, "only the aged patch is removed").toEqual([aged]);
    expect(existsSync(aged), "the aged patch is gone from disk").toBe(false);
    expect(existsSync(young), "the young patch survives").toBe(true);
    expect(sweep.failures, "a clean sweep reports no failure").toEqual([]);
  });

  it("keeps an aged patch a retained history entry still points at", () => {
    const stateRoot = makeStateRoot();
    const referenced = evidencePatch(stateRoot, "referenced", 400);
    const orphan = evidencePatch(stateRoot, "orphan", 400);

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 30,
      referenced: [referenced],
    });

    expect(sweep.removed, "age alone does not sweep a referenced patch").toEqual([orphan]);
    expect(existsSync(referenced), "the history pointer still resolves").toBe(true);
  });
});

describe("a window it cannot trust makes the sweep refuse rather than delete", () => {
  // The destructive direction is not symmetric: a window of `0`, a negative one, or a
  // `NaN` one puts the cutoff at or after `now`, which sweeps EVERY artifact including
  // the patch of the delegation that just finished. `NaN` is the sharpest — every
  // `mtimeMs > NaN` comparison is false, so nothing looks young. The schema refuses
  // these on the config path; this refuses them on the seam, because "delete
  // everything" must never be what a nonsense number means.
  const untrustworthy: [label: string, days: number][] = [
    ["zero", 0],
    ["negative", -1],
    ["not a number", Number.NaN],
    ["negative infinity", -Infinity],
  ];

  for (const [label, days] of untrustworthy) {
    it(`sweeps nothing and reports the ${label} window`, () => {
      const stateRoot = makeStateRoot();
      const ancient = evidencePatch(stateRoot, "ancient", 900);

      const sweep = sweepPreservedArtifacts({
        stateRoot,
        now: NOW,
        retainDays: days,
        referenced: [],
      });

      expect(sweep.removed, `a ${label} window deletes nothing`).toEqual([]);
      expect(existsSync(ancient), `even an ancient patch survives a ${label} window`).toBe(true);
      expect(sweep.failures.join(" "), `a ${label} window is reported, not silent`).toContain(
        "retention window",
      );
    });
  }

  it("sweeps nothing when the clock it was handed is not a number", () => {
    const stateRoot = makeStateRoot();
    const ancient = evidencePatch(stateRoot, "ancient", 900);

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: Number.NaN,
      retainDays: 30,
      referenced: [],
    });

    expect(sweep.removed, "an age it cannot compute is not an age past the window").toEqual([]);
    expect(existsSync(ancient)).toBe(true);
    expect(sweep.failures.length, "the refusal is reported").toBe(1);
  });

  it("honors a fractional window as a fraction of a day", () => {
    const stateRoot = makeStateRoot();
    const older = evidencePatch(stateRoot, "older", 1);
    const newer = artifact(stateRoot, "patches", "newer.patch", 0.1);

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 0.5,
      referenced: [],
    });

    expect(sweep.removed, "half a day is a usable window, not a nonsense one").toEqual([older]);
    expect(existsSync(newer)).toBe(true);
  });
});

describe("the sweep covers exactly the artifact kinds retention owns", () => {
  it("removes an aged evidence patch, reusable accepted patch, and validator log alike", () => {
    const stateRoot = makeStateRoot();
    const evidence = evidencePatch(stateRoot, "seq", 40);
    const accepted = artifact(stateRoot, "patches", "seq.accepted.patch", 40);
    const validatorLog = artifact(stateRoot, "validators", "seq.log", 40);

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 30,
      referenced: [],
    });

    expect(sweep.removed, "every expiring kind the taxonomy names is swept").toEqual(
      [accepted, evidence, validatorLog].sort(),
    );
  });

  it("leaves worktrees, unknown files, and unknown directories alone", () => {
    const stateRoot = makeStateRoot();
    // A stale checkout from a crash: reclaimed by the next staging, never by retention.
    const worktree = artifact(stateRoot, join("worktrees", "seq"), "tracked.txt", 900);
    // Not written by staging, so not retention's to expire whatever its name looks like.
    const stray = artifact(stateRoot, "patches", "notes.txt", 900);
    const elsewhere = artifact(stateRoot, "sessions", "seq.log", 900);

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 30,
      referenced: [],
    });

    expect(sweep.removed, "retention sweeps its own artifact kinds and nothing else").toEqual([]);
    expect(existsSync(worktree), "worktrees are out of scope").toBe(true);
    expect(existsSync(stray), "an unrecognized file in patches/ is not ours").toBe(true);
    expect(existsSync(elsewhere), "a directory retention does not own is not read").toBe(true);
  });
});

describe("a sweep that cannot finish reports and carries on", () => {
  const restore: string[] = [];
  afterEach(() => {
    race.enoent = false;
    // Give the permissions back so the temp directory can be cleaned up.
    for (const path of restore.splice(0)) chmodSync(path, 0o755);
  });

  it("records an unreadable directory as a failure and still sweeps the other kind", () => {
    const stateRoot = makeStateRoot();
    const validatorLog = artifact(stateRoot, "validators", "seq.log", 40);
    const unreachable = evidencePatch(stateRoot, "unreachable", 40);
    const patches = join(stateRoot, "patches");
    chmodSync(patches, 0o000);
    restore.push(patches);
    if (existsSync(unreachable)) return; // running as root: the mode is not enforced

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 30,
      referenced: [],
    });

    expect(sweep.failures.length, "the directory it could not read is reported").toBe(1);
    expect(sweep.failures[0]).toContain(patches);
    expect(sweep.removed, "one unreadable directory does not abandon the rest").toEqual([
      validatorLog,
    ]);
  });

  it("says nothing when a file is removed between the listing and the unlink", () => {
    const stateRoot = makeStateRoot();
    evidencePatch(stateRoot, "raced", 40);
    race.enoent = true;

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 30,
      referenced: [],
    });

    expect(sweep.removed, "a file that vanished was not removed by this sweep").toEqual([]);
    expect(sweep.failures, "already gone is the state the sweep wanted, not a failure").toEqual([]);
  });

  it("skips an artifact name that is not a regular file", () => {
    const stateRoot = makeStateRoot();
    const directory = join(stateRoot, "patches", "confusing.patch");
    mkdirSync(directory, { recursive: true });
    const when = new Date(NOW - 900 * DAY_MS);
    utimesSync(directory, when, when);

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 30,
      referenced: [],
    });

    expect(sweep.removed, "only regular files are swept").toEqual([]);
    expect(sweep.failures, "an unexpected directory is skipped, not reported").toEqual([]);
    expect(existsSync(directory)).toBe(true);
  });
});

describe("a held governance patch is exempt whatever its age", () => {
  it("keeps an ancient governance patch that nothing in history references", () => {
    const stateRoot = makeStateRoot();
    const held = artifact(stateRoot, "patches", "ancient.governance.patch", 900);

    const sweep = sweepPreservedArtifacts({
      stateRoot,
      now: NOW,
      retainDays: 30,
      referenced: [],
    });

    expect(sweep.removed, "an outstanding proposal is not evidence to expire").toEqual([]);
    expect(existsSync(held), "the held patch survives a sweep that could not see its hold").toBe(
      true,
    );
  });
});

describe("which window applies, and when there is no sweeping at all", () => {
  it("uses the default window when the repository declared no overlay", () => {
    expect(retentionDaysFor({ kind: "absent" })).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("uses the default window when an overlay configures no retention", () => {
    expect(
      retentionDaysFor({ kind: "loaded", overlay: { schemaVersion: 1, validations: {} } }),
      "declaring validators is not declaring a retention policy",
    ).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("uses the window the overlay declares", () => {
    expect(
      retentionDaysFor({
        kind: "loaded",
        overlay: { schemaVersion: 1, validations: {}, retention: { days: 7 } },
      }),
    ).toBe(7);
  });

  it("does not sweep at all while the overlay is unusable", () => {
    // The overlay being invalid already refuses the delegation (`runtime-overlay.ts`),
    // so nothing new accumulates; what must not happen is deleting evidence under a
    // window the user may have widened in the very file that failed to parse.
    expect(
      retentionDaysFor({ kind: "invalid", diagnostics: [] }),
      "a window Orca could not read is not a reason to delete anything",
    ).toBeUndefined();
  });
});

/**
 * The activation-time sweep: everything `index.ts` calls in one place, so the promise
 * that a sweep can never break a session start is pinned at the seam that makes it.
 */
describe("the sweep as activation runs it", () => {
  /** A document with one agent, so an overlay has something valid to name. */
  function document(): OrcaSpecDocument {
    return {
      spec_version: "0.1",
      repository: { id: "018f4f72-0000-7000-8000-0000000000aa" },
      administration: { approvers: [{ provider: "orca-local", principal: "test" }] },
      steward: { discovery: { read: { allow: ["**"], deny: [] } } },
      protected_denies: {},
      agents: [
        {
          id: "web",
          name: "web",
          description: "Owns apps/web/**.",
          ownership: ["apps/web/**"],
          permissions: { edit: { allow: ["apps/web/**"] } },
        },
      ],
    };
  }

  /** A repository whose `.orca/runtime.yaml` holds `source`, or none when omitted. */
  function repository(source?: string): string {
    const dir = makeStateRoot();
    if (source !== undefined) {
      mkdirSync(join(dir, ".orca"), { recursive: true });
      writeFileSync(join(dir, ".orca", "runtime.yaml"), source);
    }
    return dir;
  }

  function sweep(cwd: string, stateRoot: string, referenced: string[] = []) {
    return runRetentionSweep({ cwd, document: document(), stateRoot, now: NOW, referenced });
  }

  it("expires an artifact past the window the overlay declares", () => {
    const cwd = repository("schema_version: 1\nretention:\n  days: 5\n");
    const stateRoot = makeStateRoot();
    const expired = evidencePatch(stateRoot, "expired", 6);
    const withinWindow = evidencePatch(stateRoot, "within", 4);

    const result = sweep(cwd, stateRoot);

    expect(result?.removed, "the declared window is the one applied").toEqual([expired]);
    expect(existsSync(withinWindow)).toBe(true);
  });

  it("applies the default window when the repository has no overlay", () => {
    const cwd = repository();
    const stateRoot = makeStateRoot();
    const expired = evidencePatch(stateRoot, "expired", DEFAULT_RETENTION_DAYS + 1);
    const withinWindow = evidencePatch(stateRoot, "within", DEFAULT_RETENTION_DAYS - 1);

    const result = sweep(cwd, stateRoot);

    expect(result?.removed).toEqual([expired]);
    expect(existsSync(withinWindow)).toBe(true);
  });

  it("does not sweep while the overlay is invalid", () => {
    const cwd = repository("schema_version: 1\nretention:\n  days: 0\n");
    const stateRoot = makeStateRoot();
    const ancient = evidencePatch(stateRoot, "ancient", 900);

    const result = sweep(cwd, stateRoot);

    expect(result, "an unusable overlay means no sweep happened").toBeUndefined();
    expect(existsSync(ancient), "nothing is deleted under a window Orca could not read").toBe(true);
  });

  it("keeps an artifact the caller's reference set names, whatever its age", () => {
    const cwd = repository();
    const stateRoot = makeStateRoot();
    const referenced = evidencePatch(stateRoot, "referenced", 900);

    const result = sweep(cwd, stateRoot, [referenced]);

    expect(result?.removed).toEqual([]);
    expect(existsSync(referenced)).toBe(true);
  });

  it("reports rather than throws when the overlay itself cannot be read", () => {
    const cwd = repository("schema_version: 1\n");
    const overlay = join(cwd, ".orca", "runtime.yaml");
    chmodSync(overlay, 0o000);
    const stateRoot = makeStateRoot();
    const ancient = evidencePatch(stateRoot, "ancient", 900);

    let result: ReturnType<typeof sweep>;
    expect(() => {
      result = sweep(cwd, stateRoot);
    }, "activation must survive anything the sweep hits").not.toThrow();

    chmodSync(overlay, 0o644);
    if (existsSync(ancient)) {
      expect(result!.failures.length, "the reason is reported, not swallowed").toBe(1);
      expect(result!.removed).toEqual([]);
    }
  });
});

describe("what the sweep says on the status surface", () => {
  it("says nothing at all when it removed nothing and hit nothing", () => {
    expect(
      retentionSweepLine({ removed: [], failures: [] }),
      "housekeeping that found no work is not news",
    ).toBeUndefined();
    expect(retentionSweepLine(undefined), "a sweep that did not run says nothing").toBeUndefined();
  });

  it("reports the count in one line when it expired something", () => {
    const line = retentionSweepLine({
      removed: ["/state/patches/a.patch", "/state/validators/a.log"],
      failures: [],
    });

    expect(line).toBe("Retention: expired 2 preserved artifact(s) past the retention window.");
  });

  it("names what it could not do in the same one line", () => {
    const line = retentionSweepLine({
      removed: ["/state/patches/a.patch"],
      failures: ["/state/patches could not be listed (EACCES)"],
    });

    expect(line, "one line, both halves").toContain("expired 1 preserved artifact(s)");
    expect(line).toContain("1 could not be removed");
  });
});
