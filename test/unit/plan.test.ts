import { describe, expect, test } from "bun:test";
import {
  decideSync,
  planPush,
  preflight,
  resolveRemote,
  userPassedForce,
} from "../../src/core/plan";
import type { SyncPolicy } from "../../src/core/types";
import { baseState, syncState } from "../helpers/states";

describe("preflight", () => {
  test("passes on a healthy repo", () => {
    expect(preflight(baseState())).toBeNull();
  });

  test("rejects when not in a git repository", () => {
    const f = preflight(baseState({ isRepo: false }));
    expect(f?.reason).toContain("Not inside a git repository");
  });

  test("rejects an unborn branch before anything else", () => {
    const f = preflight(baseState({ unborn: true }));
    expect(f?.reason).toContain("no commits yet");
  });

  test.each([
    ["rebase", "A rebase is already in progress."],
    ["merge", "A merge is already in progress."],
    ["cherry-pick", "A cherry-pick is already in progress."],
  ] as const)("rejects when a %s is in progress", (op, expected) => {
    const f = preflight(baseState({ operationInProgress: op }));
    expect(f?.reason).toBe(expected);
    expect(f?.hint).toContain("--abort");
  });

  test("rejects a detached HEAD", () => {
    const f = preflight(baseState({ detached: true, branch: null }));
    expect(f?.reason).toContain("detached");
  });

  test("rejects a repo with no remotes", () => {
    const f = preflight(baseState({ remotes: [] }));
    expect(f?.reason).toContain("no remotes");
  });

  test("checks operation-in-progress before detached HEAD", () => {
    // Mid-rebase HEAD is detached; the useful message is about the rebase.
    const f = preflight(baseState({ detached: true, operationInProgress: "rebase" }));
    expect(f?.reason).toContain("rebase");
  });
});

describe("resolveRemote", () => {
  test("prefers an explicit positional remote", () => {
    expect(resolveRemote(["upstream", "my-branch"], ["origin", "upstream"], "origin")).toBe(
      "upstream",
    );
  });

  test("ignores positionals that are not remotes (e.g. a branch name)", () => {
    expect(resolveRemote(["my-branch"], ["origin"], null)).toBe("origin");
  });

  test("ignores flags that happen to share a remote's name", () => {
    expect(resolveRemote(["--origin"], ["origin", "upstream"], "upstream")).toBe("upstream");
  });

  test("falls back to the branch's upstream remote", () => {
    expect(resolveRemote([], ["origin", "fork"], "fork")).toBe("fork");
  });

  test("uses the only remote when there is exactly one", () => {
    expect(resolveRemote([], ["fork"], null)).toBe("fork");
  });

  test("prefers origin when several remotes exist and nothing else decides", () => {
    expect(resolveRemote([], ["alpha", "origin", "zeta"], null)).toBe("origin");
  });

  test("falls back to the first remote when origin is absent", () => {
    expect(resolveRemote([], ["alpha", "zeta"], null)).toBe("alpha");
  });

  test("defaults to origin when there are no remotes at all", () => {
    expect(resolveRemote([], [], null)).toBe("origin");
  });
});

describe("userPassedForce", () => {
  test.each([
    ["--force"],
    ["-f"],
    ["--force-with-lease"],
    ["--force-with-lease=origin/main"],
    ["--force-if-includes"],
  ])("detects %s", (flag) => {
    expect(userPassedForce([flag])).toBe(true);
  });

  test("is false for ordinary args", () => {
    expect(userPassedForce(["origin", "main", "--tags"])).toBe(false);
  });

  test("does not match unrelated flags that merely start with --force-ish text", () => {
    expect(userPassedForce(["--forceful"])).toBe(false);
  });
});

describe("decideSync", () => {
  const decide = (over: {
    base?: Parameters<typeof baseState>[0];
    sync?: Parameters<typeof syncState>[0];
    policy?: SyncPolicy;
    enabled?: boolean;
    forced?: boolean;
  }) =>
    decideSync({
      base: baseState(over.base),
      sync: syncState(over.sync),
      policy: over.policy ?? "default",
      enabled: over.enabled ?? true,
      forced: over.forced ?? false,
    });

  test("--no-sync does nothing and says so", () => {
    const d = decide({ enabled: false });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("--no-sync");
  });

  test("policy off does nothing", () => {
    const d = decide({ policy: "off" });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("disabled");
  });

  test("rebases onto the default branch when behind it", () => {
    const d = decide({ sync: { behindDefault: 3 } });
    expect(d.action).toBe("rebase");
    expect(d.onto).toBe("origin/main");
    expect(d.reason).toContain("3 commits");
  });

  test("uses singular wording for a single commit", () => {
    const d = decide({ sync: { behindDefault: 1 } });
    expect(d.reason).toContain("1 commit");
    expect(d.reason).not.toContain("commits");
  });

  test("does nothing when already up to date", () => {
    const d = decide({ sync: { behindDefault: 0 } });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("up to date with origin/main");
  });

  // Defect 21: an undeterminable default branch must never read as success.
  test("warns rather than claiming success when the default branch is unknown", () => {
    const d = decide({ sync: { defaultBranch: null } });
    expect(d.action).toBe("none");
    expect(d.warning).toContain("Could not determine the default branch");
    expect(d.reason).not.toContain("up to date");
  });

  test("warns when the comparison itself could not be computed", () => {
    const d = decide({ sync: { behindDefault: null } });
    expect(d.action).toBe("none");
    expect(d.warning).toContain("Could not compare");
  });

  test("upstream policy rebases onto the upstream", () => {
    const d = decide({ policy: "upstream", sync: { behindUpstream: 2, aheadUpstream: 1 } });
    expect(d.action).toBe("rebase");
    expect(d.onto).toBe("origin/feature");
  });

  test("upstream policy does nothing when the branch has no upstream", () => {
    const d = decide({ policy: "upstream", sync: { upstream: null } });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("no upstream");
  });

  test("upstream policy ignores the default branch entirely", () => {
    const d = decide({
      policy: "upstream",
      sync: { behindDefault: 99, behindUpstream: 0 },
    });
    expect(d.action).toBe("none");
  });

  test("announces that a dirty tree will be stashed", () => {
    const d = decide({ base: { dirty: true }, sync: { behindDefault: 1 } });
    expect(d.action).toBe("rebase");
    expect(d.warning).toContain("stashed and restored");
  });

  describe("divergence guard", () => {
    test("blocks when the upstream holds commits we do not have", () => {
      const d = decide({ sync: { behindDefault: 2, behindUpstream: 1, aheadUpstream: 3 } });
      expect(d.block?.reason).toContain("origin/feature has 1 commit you do not have");
      expect(d.block?.hint).toContain("git pull --rebase");
    });

    test("does not block when the user forced deliberately", () => {
      const d = decide({
        sync: { behindDefault: 2, behindUpstream: 1, aheadUpstream: 3 },
        forced: true,
      });
      expect(d.block).toBeUndefined();
    });

    test("does not block when the rebase target is that same upstream", () => {
      const d = decide({
        policy: "upstream",
        sync: { behindUpstream: 1, aheadUpstream: 3 },
      });
      expect(d.action).toBe("rebase");
      expect(d.block).toBeUndefined();
    });

    test("does not block when the upstream has nothing new", () => {
      const d = decide({ sync: { behindDefault: 2, behindUpstream: 0 } });
      expect(d.block).toBeUndefined();
    });

    // Only force-pushes destroy history. An ordinary push that is merely behind
    // is rejected by git itself, clearly — pull-pal must not pre-empt that.
    test("does not block an ordinary push that is merely behind its upstream", () => {
      const d = decide({ sync: { behindDefault: 0, behindUpstream: 2, aheadUpstream: 0 } });
      expect(d.action).toBe("none");
      expect(d.block).toBeUndefined();
    });

    test("does not block when sync is off, even if the upstream moved", () => {
      const d = decide({ policy: "off", sync: { behindUpstream: 5, aheadUpstream: 1 } });
      expect(d.block).toBeUndefined();
    });

    test("does not block a branch with no upstream at all", () => {
      const d = decide({ sync: { upstream: null, behindUpstream: null, behindDefault: 1 } });
      expect(d.block).toBeUndefined();
    });
  });
});

describe("planPush", () => {
  test("passes args through untouched when no rebase happened", () => {
    const p = planPush({
      gitArgs: ["origin", "feature"],
      didRebase: false,
      setUpstream: null,
    });
    expect(p.args).toEqual(["origin", "feature"]);
    expect(p.forceLeaseAdded).toBe(false);
  });

  test("adds --force-with-lease after a rebase, never bare --force", () => {
    const p = planPush({ gitArgs: [], didRebase: true, setUpstream: null });
    expect(p.args).toEqual(["--force-with-lease"]);
    expect(p.forceLeaseAdded).toBe(true);
  });

  test("never adds a lease when the user already forced", () => {
    const p = planPush({ gitArgs: ["--force"], didRebase: true, setUpstream: null });
    expect(p.args).toEqual(["--force"]);
    expect(p.forceLeaseAdded).toBe(false);
  });

  test("respects a user-supplied lease of their own", () => {
    const p = planPush({
      gitArgs: ["--force-with-lease=origin/x"],
      didRebase: true,
      setUpstream: null,
    });
    expect(p.args).toEqual(["--force-with-lease=origin/x"]);
  });

  test("publishes a new branch with --set-upstream", () => {
    const p = planPush({
      gitArgs: [],
      didRebase: false,
      setUpstream: { remote: "origin", branch: "feature" },
    });
    expect(p.args).toEqual(["--set-upstream", "origin", "feature"]);
  });

  test("leaves an explicit refspec alone rather than adding --set-upstream", () => {
    const p = planPush({
      gitArgs: ["origin", "feature"],
      didRebase: false,
      setUpstream: { remote: "origin", branch: "feature" },
    });
    expect(p.args).toEqual(["origin", "feature"]);
  });

  test("keeps flag-only args compatible with --set-upstream", () => {
    const p = planPush({
      gitArgs: ["--tags"],
      didRebase: false,
      setUpstream: { remote: "origin", branch: "feature" },
    });
    expect(p.args).toEqual(["--tags", "--set-upstream", "origin", "feature"]);
  });

  test("combines a lease with --set-upstream when a new branch was rebased", () => {
    const p = planPush({
      gitArgs: [],
      didRebase: true,
      setUpstream: { remote: "origin", branch: "feature" },
    });
    expect(p.args).toEqual(["--force-with-lease", "--set-upstream", "origin", "feature"]);
  });
});
