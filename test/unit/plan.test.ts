import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LONG_LIVED,
  chooseTarget,
  decideSync,
  isLongLived,
  planPush,
  preflight,
  pushPositionals,
  resolveRemote,
  scopeOfPush,
  scopeOfRefs,
  userOverridesGuard,
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
  const remotes = ["origin", "upstream", "fork"];

  test("prefers an explicit positional remote", () => {
    expect(resolveRemote(["upstream", "my-branch"], remotes, { upstreamRemote: "origin" })).toBe(
      "upstream",
    );
  });

  test("ignores positionals that are not remotes (e.g. a branch name)", () => {
    expect(resolveRemote(["my-branch"], ["origin"])).toBe("origin");
  });

  test("ignores flags that happen to share a remote's name", () => {
    expect(resolveRemote(["--origin"], remotes, { upstreamRemote: "upstream" })).toBe("upstream");
  });

  test.each([["--repo=upstream"], ["--repo upstream"]])("honours %s", (flag) => {
    const args = flag.split(" ");
    expect(resolveRemote(args, remotes, { pushRemote: "fork", upstreamRemote: "origin" })).toBe(
      "upstream",
    );
  });

  test("the repository argument beats --repo, as in git", () => {
    expect(resolveRemote(["--repo=upstream", "fork"], remotes)).toBe("fork");
  });

  // Fork workflow: fetch from the organisation's repo, push to your own.
  test("branch.<name>.pushRemote beats remote.pushDefault and the upstream remote", () => {
    expect(
      resolveRemote([], remotes, {
        pushRemote: "fork",
        pushDefault: "upstream",
        upstreamRemote: "origin",
      }),
    ).toBe("fork");
  });

  test("remote.pushDefault beats the upstream remote", () => {
    expect(resolveRemote([], remotes, { pushDefault: "fork", upstreamRemote: "origin" })).toBe(
      "fork",
    );
  });

  test("falls back to the branch's upstream remote", () => {
    expect(resolveRemote([], ["origin", "fork"], { upstreamRemote: "fork" })).toBe("fork");
  });

  test("ignores a configured remote that does not exist", () => {
    expect(resolveRemote([], ["origin", "fork"], { pushDefault: "gone" })).toBe("origin");
  });

  test("uses the only remote when there is exactly one", () => {
    expect(resolveRemote([], ["fork"])).toBe("fork");
  });

  test("prefers origin when several remotes exist and nothing else decides", () => {
    expect(resolveRemote([], ["alpha", "origin", "zeta"])).toBe("origin");
  });

  test("falls back to the first remote when origin is absent", () => {
    expect(resolveRemote([], ["alpha", "zeta"])).toBe("alpha");
  });

  test("defaults to origin when there are no remotes at all", () => {
    expect(resolveRemote([], [])).toBe("origin");
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

  test("detects a +refspec", () => {
    expect(userPassedForce(["origin", "+feature"])).toBe(true);
  });
});

describe("userOverridesGuard", () => {
  test.each([["--force"], ["-f"], ["--force-with-lease=feature:abc123"]])("%s does", (flag) => {
    expect(userOverridesGuard([flag])).toBe(true);
  });

  test("so does a +refspec", () => {
    expect(userOverridesGuard(["origin", "+HEAD:feature"])).toBe(true);
  });

  // A bare lease trusts refs/remotes/*, which the user may not have looked at.
  test.each([["--force-with-lease"], ["--force-with-lease=feature"], ["--force-if-includes"]])(
    "%s does not",
    (flag) => {
      expect(userOverridesGuard([flag])).toBe(false);
    },
  );
});

describe("pushPositionals", () => {
  test("repository first, then refspecs; flags are not positionals", () => {
    expect(pushPositionals(["--tags", "origin", "--atomic", "main"])).toEqual(["origin", "main"]);
  });

  test("a value given to -o as its own argument is not a refspec", () => {
    expect(pushPositionals(["-o", "ci.skip", "origin", "main"])).toEqual(["origin", "main"]);
  });

  test("everything after -- is positional", () => {
    expect(pushPositionals(["--", "--weird-branch"])).toEqual(["--weird-branch"]);
  });
});

describe("scopeOfPush", () => {
  const scope = (gitArgs: string[], upstream: string | null = "origin/feature") =>
    scopeOfPush({ gitArgs, branch: "feature", upstream, remote: "origin" });

  test("no refspec: git pushes the current branch, so everything applies", () => {
    expect(scope([])).toMatchObject({ testsHead: true, syncsHead: true });
    expect(scope(["origin"])).toMatchObject({ testsHead: true, syncsHead: true });
  });

  test.each([["feature"], ["HEAD"], ["refs/heads/feature"], ["+feature"], ["feature:feature"]])(
    "%s names the current branch",
    (spec) => {
      expect(scope(["origin", spec])).toMatchObject({ testsHead: true, syncsHead: true });
    },
  );

  test("HEAD to the upstream's own name still syncs", () => {
    const s = scopeOfPush({
      gitArgs: ["origin", "HEAD:refs/heads/remote-name"],
      branch: "local-name",
      upstream: "origin/remote-name",
      remote: "origin",
    });
    expect(s).toMatchObject({ testsHead: true, syncsHead: true });
  });

  // The v0.2 review bug: pushing another branch borrowed HEAD's rebase and lease.
  test("another branch is neither tested nor synced", () => {
    expect(scope(["origin", "feature-x"])).toEqual({
      testsHead: false,
      syncsHead: false,
      description: "feature-x",
    });
  });

  test("HEAD pushed to a different remote branch is tested but not synced", () => {
    expect(scope(["origin", "HEAD:refs/heads/elsewhere"])).toMatchObject({
      testsHead: true,
      syncsHead: false,
    });
  });

  test("a mix of the current branch and another is neither", () => {
    expect(scope(["origin", "feature", "feature-x"])).toMatchObject({
      testsHead: false,
      syncsHead: false,
    });
  });

  test.each([["--all"], ["--mirror"], ["--tags"], ["--delete"], ["-d"]])(
    "%s pushes more than HEAD",
    (flag) => {
      expect(scope([flag, "origin", "feature"])).toMatchObject({
        testsHead: false,
        syncsHead: false,
      });
    },
  );
});

describe("scopeOfRefs", () => {
  const ref = (name: string, commit: string, remote = name) => ({
    localRef: `refs/heads/${name}`,
    remoteRef: `refs/heads/${remote}`,
    commit,
  });

  test("the current branch to its own name: tested and synced", () => {
    expect(scopeOfRefs([ref("feature", "abc")], "feature", "abc")).toMatchObject({
      testsHead: true,
      syncsHead: true,
    });
  });

  test("another branch at a different commit: neither", () => {
    expect(scopeOfRefs([ref("other", "def")], "feature", "abc")).toMatchObject({
      testsHead: false,
      syncsHead: false,
    });
  });

  // --follow-tags: a tag travels with the branch, and may point at an older commit.
  test("tags alongside the branch are set aside", () => {
    const tag = { localRef: "refs/tags/v1", remoteRef: "refs/tags/v1", commit: "old" };
    expect(scopeOfRefs([ref("feature", "abc"), tag], "feature", "abc")).toMatchObject({
      testsHead: true,
      syncsHead: true,
    });
  });

  test("a push of only tags checks nothing", () => {
    const tag = { localRef: "refs/tags/v1", remoteRef: "refs/tags/v1", commit: "abc" };
    expect(scopeOfRefs([tag], "feature", "abc")).toMatchObject({
      testsHead: false,
      syncsHead: false,
    });
  });

  // `git push origin HEAD` hands the hook "HEAD" as the local ref.
  test("HEAD as the local ref is the current branch", () => {
    const head = { localRef: "HEAD", remoteRef: "refs/heads/feature", commit: "abc" };
    expect(scopeOfRefs([head], "feature", "abc")).toMatchObject({
      testsHead: true,
      syncsHead: true,
    });
  });

  test("an upstream branch with another name still syncs", () => {
    const pushed = [ref("feature", "abc", "jo/feature")];
    expect(scopeOfRefs(pushed, "feature", "abc", "jo/feature")).toMatchObject({
      testsHead: true,
      syncsHead: true,
    });
  });

  test("HEAD pushed to an unrelated branch is tested, not synced", () => {
    const head = { localRef: "HEAD", remoteRef: "refs/heads/other", commit: "abc" };
    expect(scopeOfRefs([head], "feature", "abc")).toMatchObject({
      testsHead: true,
      syncsHead: false,
    });
  });
});

describe("isLongLived", () => {
  test.each([
    ["release/1.0", true],
    ["release-2024", true],
    ["hotfix/urgent", true],
    ["develop", true],
    ["main", true],
    ["feature/release-notes", false],
    ["my-develop-fix", false],
  ])("%s → %p", (branch, expected) => {
    expect(isLongLived(branch, DEFAULT_LONG_LIVED)).toBe(expected);
  });
});

describe("chooseTarget", () => {
  const choose = (over: {
    branch?: string;
    sync?: Parameters<typeof syncState>[0];
    policy?: SyncPolicy;
    enabled?: boolean;
    longLived?: string[];
  }) =>
    chooseTarget({
      branch: over.branch ?? "feature",
      sync: syncState(over.sync),
      policy: over.policy ?? "check",
      enabled: over.enabled ?? true,
      longLived: over.longLived ?? DEFAULT_LONG_LIVED,
    });

  test("a feature branch is compared with the default branch", () => {
    expect(choose({}).ref).toBe("origin/main");
  });

  test("--no-sync: nothing to compare", () => {
    const t = choose({ enabled: false });
    expect(t.ref).toBeNull();
    expect(t.reason).toContain("--no-sync");
  });

  test("policy off: nothing to compare", () => {
    expect(choose({ policy: "off" }).reason).toContain("disabled");
  });

  // The v0.2 review bug: release/1.0 was rebased onto main and force-pushed.
  test("a long-lived branch is never compared with the default branch", () => {
    const t = choose({ branch: "release/1.0", sync: { upstream: "origin/release/1.0" } });
    expect(t.ref).toBeNull();
    expect(t.reason).toContain("long-lived");
  });

  test("the default branch itself compares with its own upstream", () => {
    expect(choose({ branch: "main", sync: { upstream: "origin/main" } }).ref).toBe("origin/main");
  });

  test("a configured base wins — stacked branches, branches off develop", () => {
    expect(choose({ sync: { configuredBase: "feature-a" } }).ref).toBe("origin/feature-a");
    expect(choose({ branch: "release/1.0", sync: { configuredBase: "develop" } }).ref).toBe(
      "origin/develop",
    );
  });

  test("pullpal.longLived replaces the defaults", () => {
    expect(choose({ branch: "release/1.0", longLived: [] }).ref).toBe("origin/main");
    expect(choose({ branch: "team/shared", longLived: ["team/*"] }).ref).toBeNull();
  });

  // Defect 21: an undeterminable default branch must never read as success.
  test("warns rather than claiming success when the default branch is unknown", () => {
    const t = choose({ sync: { defaultBranch: null } });
    expect(t.ref).toBeNull();
    expect(t.warning).toContain("Could not determine the default branch");
  });

  test("upstream policy compares with the upstream, or nothing", () => {
    expect(choose({ policy: "upstream" }).ref).toBe("origin/feature");
    expect(choose({ policy: "upstream", sync: { upstream: null } }).reason).toContain(
      "no upstream",
    );
  });
});

describe("decideSync", () => {
  const decide = (over: {
    base?: Parameters<typeof baseState>[0];
    sync?: Parameters<typeof syncState>[0];
    target?: string | null;
    behind?: number | null;
    conflicts?: string[] | null;
    policy?: SyncPolicy;
    forced?: boolean;
    onConflict?: "block" | "warn";
  }) => {
    const ref = over.target === undefined ? "origin/main" : over.target;
    return decideSync({
      base: baseState(over.base),
      sync: syncState(over.sync),
      target: { ref, reason: ref ? "default branch" : "no target" },
      comparison: ref
        ? {
            behind: over.behind === undefined ? 0 : over.behind,
            conflicts: over.conflicts === undefined ? [] : over.conflicts,
          }
        : null,
      policy: over.policy ?? "check",
      forced: over.forced ?? false,
      onConflict: over.onConflict ?? "block",
    });
  };

  test("no target: nothing to do, and the reason is carried through", () => {
    const d = decide({ target: null });
    expect(d.action).toBe("none");
    expect(d.reason).toBe("no target");
  });

  test("up to date", () => {
    const d = decide({ behind: 0 });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("up to date with origin/main");
  });

  test("warns when the comparison itself could not be computed", () => {
    const d = decide({ behind: null });
    expect(d.action).toBe("none");
    expect(d.warning).toContain("Could not compare");
  });

  describe("check (the default)", () => {
    test("behind but merging cleanly: reported, never rewritten, never blocked", () => {
      const d = decide({ behind: 3 });
      expect(d.action).toBe("none");
      expect(d.block).toBeUndefined();
      expect(d.reason).toBe("behind origin/main by 3 commits — merges cleanly");
    });

    test("uses singular wording for a single commit", () => {
      expect(decide({ behind: 1 }).reason).toContain("by 1 commit —");
    });

    test("conflicts block, naming the files and the fix", () => {
      const d = decide({ behind: 2, conflicts: ["a.ts", "b.ts"] });
      expect(d.block?.kind).toBe("conflicts");
      expect(d.block?.reason).toContain("2 files conflict with origin/main: a.ts, b.ts");
      // pull-pal's fetch leaves origin/main alone, so the fix has to fetch too.
      expect(d.block?.hint).toContain("git pull --rebase origin main");
      expect(d.block?.hint).toContain("git pull --no-rebase origin main");
    });

    test("a long conflict list is summarised", () => {
      const files = ["1", "2", "3", "4", "5", "6", "7"];
      expect(decide({ behind: 1, conflicts: files }).block?.reason).toContain("and 2 more");
    });

    test("pullpal.onConflict=warn turns the block into a warning", () => {
      const d = decide({ behind: 2, conflicts: ["a.ts"], onConflict: "warn" });
      expect(d.block).toBeUndefined();
      expect(d.warning).toContain("1 file conflict");
    });

    test("an unavailable conflict check is said out loud, not passed off as clean", () => {
      const d = decide({ behind: 2, conflicts: null });
      expect(d.block).toBeUndefined();
      expect(d.warning).toContain("git 2.38");
    });

    test("behind its own upstream: warns that git will reject the push", () => {
      const d = decide({ target: "origin/feature", behind: 1, sync: { aheadUpstream: 2 } });
      expect(d.warning).toContain("git pull --rebase");
    });

    test("behind its own upstream with nothing to push: no warning", () => {
      const d = decide({ target: "origin/feature", behind: 1, sync: { aheadUpstream: 0 } });
      expect(d.warning).toBeUndefined();
    });
  });

  describe("rebase", () => {
    test("rebases onto the target when behind and clean", () => {
      const d = decide({ policy: "rebase", behind: 3 });
      expect(d.action).toBe("rebase");
      expect(d.onto).toBe("origin/main");
    });

    test("never attempts a rebase that would conflict", () => {
      const d = decide({ policy: "rebase", behind: 3, conflicts: ["a.ts"] });
      expect(d.action).toBe("none");
      expect(d.block?.kind).toBe("conflicts");
    });

    test("still tries when the conflict check is unavailable — the rebase aborts safely", () => {
      expect(decide({ policy: "rebase", behind: 3, conflicts: null }).action).toBe("rebase");
    });

    test("does nothing when up to date", () => {
      expect(decide({ policy: "rebase", behind: 0 }).action).toBe("none");
    });

    test("announces that a dirty tree will be stashed", () => {
      const d = decide({ policy: "rebase", base: { dirty: true }, behind: 1 });
      expect(d.warning).toContain("stashed and restored");
    });

    test("upstream policy rebases onto the upstream", () => {
      const d = decide({ policy: "upstream", target: "origin/feature", behind: 2 });
      expect(d.action).toBe("rebase");
      expect(d.onto).toBe("origin/feature");
    });
  });

  describe("divergence guard", () => {
    test("blocks when the upstream holds commits we do not have", () => {
      const d = decide({
        policy: "rebase",
        behind: 2,
        sync: { behindUpstream: 1, aheadUpstream: 3 },
      });
      expect(d.block?.kind).toBe("diverged");
      expect(d.block?.reason).toContain("origin/feature has 1 commit you do not have");
      expect(d.block?.hint).toContain("git pull --rebase origin feature");
      expect(d.block?.hint).toContain("--force");
    });

    test("does not block when the user forced deliberately", () => {
      const d = decide({
        policy: "rebase",
        behind: 2,
        sync: { behindUpstream: 1, aheadUpstream: 3 },
        forced: true,
      });
      expect(d.block).toBeUndefined();
    });

    test("does not block when the rebase target is that same upstream", () => {
      const d = decide({
        policy: "upstream",
        target: "origin/feature",
        behind: 1,
        sync: { behindUpstream: 1, aheadUpstream: 3 },
      });
      expect(d.action).toBe("rebase");
      expect(d.block).toBeUndefined();
    });

    test("does not block when the upstream has nothing new", () => {
      expect(decide({ policy: "rebase", behind: 2 }).block).toBeUndefined();
    });

    // Only force-pushes destroy history; the check policy never force-pushes.
    test("never applies when nothing is rebased", () => {
      const d = decide({ behind: 2, sync: { behindUpstream: 5, aheadUpstream: 1 } });
      expect(d.block).toBeUndefined();
    });

    test("does not block a branch with no upstream at all", () => {
      const d = decide({
        policy: "rebase",
        behind: 1,
        sync: { upstream: null, behindUpstream: null },
      });
      expect(d.block).toBeUndefined();
    });
  });
});

describe("planPush", () => {
  test("keeps --set-upstream ahead of a user-supplied -- separator", () => {
    const p = planPush({
      gitArgs: ["--"],
      didRebase: false,
      setUpstream: { remote: "origin", branch: "feature" },
    });
    expect(p.args).toEqual(["--set-upstream", "origin", "feature", "--"]);
  });

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

  // pull-pal leaves refs/remotes/* alone, so a bare lease would compare against
  // a ref it never refreshed. The lease names what pull-pal actually checked.
  test("pins the lease to the commit pull-pal fetched", () => {
    const p = planPush({
      gitArgs: [],
      didRebase: true,
      setUpstream: null,
      lease: { branch: "feature", expect: "abc123" },
    });
    expect(p.args).toEqual(["--force-with-lease=refs/heads/feature:abc123"]);
  });

  test("a branch not yet on the remote must still not exist when pushed", () => {
    const p = planPush({
      gitArgs: [],
      didRebase: true,
      setUpstream: null,
      lease: { branch: "feature", expect: null },
    });
    expect(p.args).toEqual(["--force-with-lease=refs/heads/feature:"]);
  });

  test("no lease without a rebase", () => {
    const p = planPush({
      gitArgs: [],
      didRebase: false,
      setUpstream: null,
      lease: { branch: "feature", expect: "abc123" },
    });
    expect(p.args).toEqual([]);
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

  test("an option value is not mistaken for a refspec", () => {
    const p = planPush({
      gitArgs: ["-o", "ci.skip"],
      didRebase: false,
      setUpstream: { remote: "origin", branch: "feature" },
    });
    expect(p.args).toEqual(["-o", "ci.skip", "--set-upstream", "origin", "feature"]);
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
