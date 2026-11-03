/**
 * Workflow-level tests against real git repositories.
 *
 * These drive `runPush` directly (test detection/execution is stubbed) so the
 * sync, safety, and push behaviour is exercised end to end without needing the
 * CLI layer. Each scenario asserts on the *remote* where it matters — that is
 * the only place "did the push really happen" can be answered honestly.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, UserFacingError } from "../../src/core/errors";
import { runPush } from "../../src/core/workflow";
import { createMemoryTestCache } from "../../src/test-cache";
import { type Fixture, withRepo } from "../helpers/fixture";
import { fakeTestPlan, makeDeps, options } from "../helpers/harness";

/** Sha of a branch as it exists on the bare remote. */
function remoteSha(repo: Fixture, branch = "main"): string {
  return (
    repo.git(["ls-remote", repo.remoteDir, `refs/heads/${branch}`]).stdout.split(/\s+/)[0] ?? ""
  );
}

/** Check out a new feature branch off main, commit to it, and publish it. */
function publishFeature(
  repo: Fixture,
  name = "feature",
  files: Record<string, string> = { "f.txt": "feature\n" },
) {
  repo.git(["checkout", "-q", "-b", name]);
  const sha = repo.commit(`${name} work`, files);
  repo.git(["push", "-q", "-u", "origin", name]);
  return sha;
}

describe("push pipeline", () => {
  test("up to date: runs tests, then pushes", async () => {
    await withRepo(async (repo) => {
      const local = repo.commit("local work", { "a.txt": "a" });
      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan });

      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.pushed).toBe(true);
      expect(result.rebased).toBe(false);
      expect(result.testsPassed).toBe(true);
      expect(h.testRuns).toBe(1);
      expect(remoteSha(repo)).toBe(local);
      expect(h.ui.text()).toContain("up to date with origin/main");
    });
  });

  test("failing tests block the push and leave the remote untouched", async () => {
    await withRepo(async (repo) => {
      const remoteBefore = remoteSha(repo);
      repo.commit("local work", { "a.txt": "a" });

      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan, testExitCode: 3 });
      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(3);
      expect(result.blocked).toBe("tests-failed");
      expect(result.pushed).toBe(false);
      expect(remoteSha(repo)).toBe(remoteBefore);
      expect(h.ui.text()).toContain("Tests failed");
    });
  });

  test("an interrupted suite reports the interruption and pushes nothing", async () => {
    await withRepo(async (repo) => {
      const remoteBefore = remoteSha(repo);
      repo.commit("local work", { "a.txt": "a" });

      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan, testExitCode: EXIT.interrupted });
      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.interrupted);
      expect(h.ui.text()).toContain("Tests interrupted");
      expect(remoteSha(repo)).toBe(remoteBefore);
    });
  });

  test("a missing test binary warns and skips instead of crashing", async () => {
    await withRepo(async (repo) => {
      repo.commit("local work", { "a.txt": "a" });
      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan, runnable: false });

      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.pushed).toBe(true);
      expect(h.testRuns).toBe(0);
      expect(h.ui.text()).toContain("not on PATH");
    });
  });

  test("--no-tests skips detection entirely", async () => {
    await withRepo(async (repo) => {
      repo.commit("local work", { "a.txt": "a" });
      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan, testExitCode: 1 });

      const result = await runPush(h.deps, options({ tests: false }));

      expect(result.exitCode).toBe(EXIT.ok);
      expect(h.testRuns).toBe(0);
      expect(result.pushed).toBe(true);
    });
  });

  test("--no-sync skips the sync even when behind", async () => {
    await withRepo(async (repo) => {
      repo.advanceRemote("main", "teammate work");
      repo.commit("my work", { "mine.txt": "mine" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ sync: false, syncPolicy: "rebase" }));

      expect(result.rebased).toBe(false);
      expect(h.ui.text()).toContain("--no-sync");
      // Non-fast-forward: git itself rejects it, and we report the failure.
      expect(result.pushed).toBe(false);
    });
  });

  test("sync policy off never compares or rebases", async () => {
    await withRepo(async (repo) => {
      repo.advanceRemote("main", "teammate work");
      const h = makeDeps(repo.dir);

      const result = await runPush(h.deps, options({ syncPolicy: "off" }));

      expect(result.rebased).toBe(false);
      expect(h.ui.text()).not.toContain("behind");
    });
  });

  test("a new branch with no upstream is published with --set-upstream", async () => {
    await withRepo(async (repo) => {
      repo.git(["checkout", "-q", "-b", "feature"]);
      const sha = repo.commit("feature work", { "f.txt": "f" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.pushed).toBe(true);
      expect(remoteSha(repo, "feature")).toBe(sha);
      // Upstream is now tracked.
      expect(repo.git(["rev-parse", "--abbrev-ref", "@{upstream}"]).stdout).toBe("origin/feature");
    });
  });
});

describe("sync=check (the default)", () => {
  test("behind main but merging cleanly: pushes as-is, history untouched", async () => {
    await withRepo(async (repo) => {
      const mine = publishFeature(repo);
      repo.advanceRemote("main", "teammate work");
      const next = repo.commit("more work", { "g.txt": "g" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.rebased).toBe(false);
      expect(result.pushed).toBe(true);
      expect(repo.git(["merge-base", "--is-ancestor", mine, "HEAD"]).exitCode).toBe(0);
      expect(remoteSha(repo, "feature")).toBe(next);
      expect(h.ui.text()).toContain("behind origin/main by 1 commit — merges cleanly");
      expect(h.ui.text()).not.toContain("--force-with-lease");
    });
  });

  test("a branch that no longer merges is blocked before tests or push", async () => {
    await withRepo(async (repo) => {
      publishFeature(repo, "feature", { "README.md": "feature version\n" });
      repo.advanceRemote("main", "conflicting", { "README.md": "main version\n" });
      const remoteBefore = remoteSha(repo, "feature");
      repo.commit("more", { "README.md": "feature version 2\n" });

      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan });
      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.blocked);
      expect(result.blocked).toBe("conflicts");
      expect(h.testRuns).toBe(0);
      expect(remoteSha(repo, "feature")).toBe(remoteBefore);
      expect(h.ui.text()).toContain("README.md");
      expect(h.ui.text()).toContain("git pull --rebase origin main");
      // The check is in memory: nothing to clean up afterwards.
      expect(repo.git(["status", "--porcelain"]).stdout).toBe("");
    });
  });

  test("pullpal.onConflict=warn lets a conflicting branch through", async () => {
    await withRepo(async (repo) => {
      publishFeature(repo, "feature", { "README.md": "feature version\n" });
      repo.advanceRemote("main", "conflicting", { "README.md": "main version\n" });
      const next = repo.commit("more", { "x.txt": "x" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ onConflict: "warn" }));

      expect(result.pushed).toBe(true);
      expect(remoteSha(repo, "feature")).toBe(next);
      expect(h.ui.text()).toContain("conflict with origin/main");
    });
  });
});

describe("sync=rebase", () => {
  test("behind the default branch: rebases, then force-pushes with a lease", async () => {
    await withRepo(async (repo) => {
      const teammate = repo.advanceRemote("main", "teammate work");
      repo.commit("my work", { "mine.txt": "mine" });
      const h = makeDeps(repo.dir);

      const result = await runPush(h.deps, options({ syncPolicy: "rebase" }));

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.rebased).toBe(true);
      expect(result.pushed).toBe(true);

      // Our commit now sits on top of the teammate's on the remote.
      expect(remoteSha(repo)).toBe(repo.sha("HEAD"));
      expect(repo.git(["log", "--oneline"]).stdout).toContain("my work");
      expect(repo.git(["merge-base", "--is-ancestor", teammate, "HEAD"]).exitCode).toBe(0);
      expect(h.ui.text()).toContain("--force-with-lease");
    });
  });

  test("dirty working tree is stashed across the rebase and restored", async () => {
    await withRepo(async (repo) => {
      repo.commit("tracked file", { "work.txt": "committed\n" });
      repo.advanceRemote("main", "teammate work");
      // Uncommitted edit to a tracked file — v0.1 died here.
      repo.writeFile("work.txt", "uncommitted edit\n");

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ syncPolicy: "rebase" }));

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.rebased).toBe(true);
      // The edit survived the rebase.
      expect(readFileSync(join(repo.dir, "work.txt"), "utf8")).toBe("uncommitted edit\n");
      expect(repo.git(["status", "--porcelain"]).stdout).toContain("work.txt");
      expect(h.ui.text()).toContain("stashed and restored");
    });
  });

  test("a predictable conflict is caught before any rebase starts", async () => {
    await withRepo(async (repo) => {
      const before = repo.commit("local edit", { "README.md": "local version\n" });
      repo.advanceRemote("main", "conflicting", { "README.md": "remote version\n" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ syncPolicy: "rebase" }));

      expect(result.blocked).toBe("conflicts");
      expect(result.rebased).toBe(false);
      expect(repo.sha("HEAD")).toBe(before);
    });
  });

  /**
   * A rebase replays commit by commit, so it can conflict where the overall
   * merge does not: here the branch changes a line and then changes it back.
   * merge-tree says "clean"; the rebase still stops at the first commit — and
   * must roll back completely.
   */
  test("a rebase that conflicts mid-way aborts cleanly and pushes nothing", async () => {
    await withRepo(async (repo) => {
      repo.commit("change", { "README.md": "local version\n" });
      const before = repo.commit("change back", { "README.md": "# fixture\n" });
      repo.advanceRemote("main", "conflicting", { "README.md": "remote version\n" });
      const remoteBefore = remoteSha(repo);

      const h = makeDeps(repo.dir);
      const error = await runPush(h.deps, options({ syncPolicy: "rebase" })).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(UserFacingError);
      const err = error as UserFacingError;
      expect(err.message).toContain("Could not rebase");
      expect(err.hint).toContain("rolled back");

      // The critical guarantee: the repo is exactly as it was.
      expect(repo.sha("HEAD")).toBe(before);
      expect(existsSync(join(repo.dir, ".git", "rebase-merge"))).toBe(false);
      expect(repo.git(["status", "--porcelain"]).stdout).toBe("");
      expect(remoteSha(repo)).toBe(remoteBefore);
    });
  });
});

describe("only the checked-out branch is synced", () => {
  /**
   * The bug from the review: on feature-a, `pull-pal origin feature-x` rebased
   * feature-a and pushed feature-x with --force-with-lease. The fetch had just
   * refreshed origin/feature-x, so the lease passed and a teammate's commits on
   * feature-x were overwritten.
   */
  test("pushing another branch never rebases HEAD or adds a lease", async () => {
    await withRepo(async (repo) => {
      repo.git(["checkout", "-q", "-b", "feature-x"]);
      repo.commit("x", { "x.txt": "x" });
      repo.git(["push", "-q", "-u", "origin", "feature-x"]);
      const teammate = repo.advanceRemote("feature-x", "teammate on feature-x");
      repo.git(["checkout", "-q", "main"]);
      const featureA = publishFeature(repo, "feature-a", { "a.txt": "a" });
      repo.advanceRemote("main", "main moved");
      repo.git(["fetch", "-q", "origin"]);
      repo.git(["branch", "-f", "feature-x", "feature-x@{1}"]); // local feature-x is stale

      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan, testExitCode: 1 });
      const result = await runPush(
        h.deps,
        options({ syncPolicy: "rebase", gitArgs: ["origin", "feature-x"] }),
      );

      expect(result.rebased).toBe(false);
      expect(repo.sha("HEAD")).toBe(featureA);
      // HEAD's tests say nothing about feature-x, so they did not run.
      expect(h.testRuns).toBe(0);
      expect(h.ui.text()).not.toContain("--force-with-lease");
      // Git rejected the stale push itself; the teammate's commit survives.
      expect(remoteSha(repo, "feature-x")).toBe(teammate);
      expect(h.ui.text()).toContain("not the checked-out branch");
    });
  });

  test("a long-lived branch is never rebased onto main", async () => {
    await withRepo(async (repo) => {
      repo.git(["checkout", "-q", "-b", "release/1.0"]);
      repo.commit("release fix", { "fix.txt": "fix" });
      repo.git(["push", "-q", "-u", "origin", "release/1.0"]);
      repo.advanceRemote("main", "main moved on");
      const before = repo.commit("another fix", { "fix2.txt": "fix" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ syncPolicy: "rebase" }));

      expect(result.rebased).toBe(false);
      expect(result.pushed).toBe(true);
      expect(repo.sha("HEAD")).toBe(before);
      expect(remoteSha(repo, "release/1.0")).toBe(before);
      expect(h.ui.text()).toContain("long-lived");
    });
  });

  test("branch.<name>.pullpalBase syncs a stacked branch with its parent", async () => {
    await withRepo(async (repo) => {
      publishFeature(repo, "feature-a", { "a.txt": "a" });
      repo.git(["checkout", "-q", "-b", "feature-b"]);
      repo.commit("b", { "b.txt": "b" });
      repo.git(["push", "-q", "-u", "origin", "feature-b"]);
      repo.git(["config", "branch.feature-b.pullpalBase", "feature-a"]);
      const parent = repo.advanceRemote("feature-a", "parent moved");

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ syncPolicy: "rebase" }));

      expect(result.rebased).toBe(true);
      expect(repo.git(["merge-base", "--is-ancestor", parent, "HEAD"]).exitCode).toBe(0);
      expect(h.ui.text()).toContain("origin/feature-a");
    });
  });
});

describe("tests run against exactly what is pushed", () => {
  test("uncommitted and untracked changes are invisible to the tests, then restored", async () => {
    await withRepo(async (repo) => {
      repo.commit("tracked", { "work.txt": "committed\n" });
      repo.writeFile("work.txt", "uncommitted\n");
      repo.writeFile("forgot-to-add.txt", "untracked\n");
      repo.git(["add", "work.txt"]); // a staged change, too

      let seen = null as { work: string; untracked: boolean } | null;
      const h = makeDeps(repo.dir, {
        testPlan: fakeTestPlan,
        duringTests: () => {
          seen = {
            work: readFileSync(join(repo.dir, "work.txt"), "utf8"),
            untracked: existsSync(join(repo.dir, "forgot-to-add.txt")),
          };
        },
      });
      const result = await runPush(h.deps, options());

      expect(result.pushed).toBe(true);
      expect(seen).toEqual({ work: "committed\n", untracked: false });
      // Everything is back, including what was staged.
      expect(readFileSync(join(repo.dir, "work.txt"), "utf8")).toBe("uncommitted\n");
      expect(existsSync(join(repo.dir, "forgot-to-add.txt"))).toBe(true);
      expect(repo.git(["diff", "--cached", "--name-only"]).stdout).toBe("work.txt");
      expect(repo.git(["stash", "list"]).stdout).toBe("");
    });
  });

  test("changes are restored even when the tests fail", async () => {
    await withRepo(async (repo) => {
      repo.writeFile("wip.txt", "wip\n");
      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan, testExitCode: 1 });

      const result = await runPush(h.deps, options());

      expect(result.blocked).toBe("tests-failed");
      expect(existsSync(join(repo.dir, "wip.txt"))).toBe(true);
      expect(repo.git(["stash", "list"]).stdout).toBe("");
    });
  });

  test("a restore that cannot apply stops the push and says where the work is", async () => {
    await withRepo(async (repo) => {
      const remoteBefore = remoteSha(repo);
      repo.commit("work", { "a.txt": "a" });
      repo.writeFile("output.txt", "my notes\n");

      // The suite writes a file with the same name as the stashed one.
      const h = makeDeps(repo.dir, {
        testPlan: fakeTestPlan,
        duringTests: () => repo.writeFile("output.txt", "test output\n"),
      });
      const error = await runPush(h.deps, options()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UserFacingError);
      expect((error as UserFacingError).message).toContain("Could not restore");
      expect((error as UserFacingError).hint).toContain("git stash list");
      expect(remoteSha(repo)).toBe(remoteBefore);
      // Nothing lost: the original is still in the stash.
      expect(repo.git(["stash", "list"]).stdout).toContain("pull-pal");
    });
  });
});

describe("test cache", () => {
  test("a commit that already passed is not tested again", async () => {
    await withRepo(async (repo) => {
      const testCache = createMemoryTestCache();
      repo.commit("work", { "a.txt": "a" });

      const first = makeDeps(repo.dir, { testPlan: fakeTestPlan, testCache });
      await runPush(first.deps, options({ dryRun: false }));
      const second = makeDeps(repo.dir, { testPlan: fakeTestPlan, testCache });
      const result = await runPush(second.deps, options());

      expect(first.testRuns).toBe(1);
      expect(second.testRuns).toBe(0);
      expect(result.testsPassed).toBe(true);
      expect(second.ui.text()).toContain("already passed for this exact commit");
    });
  });

  test("a new commit, --retest, or a failure means the suite runs again", async () => {
    await withRepo(async (repo) => {
      const testCache = createMemoryTestCache();
      repo.commit("work", { "a.txt": "a" });
      await runPush(makeDeps(repo.dir, { testPlan: fakeTestPlan, testCache }).deps, options());

      const retest = makeDeps(repo.dir, { testPlan: fakeTestPlan, testCache });
      await runPush(retest.deps, options({ useTestCache: false }));
      expect(retest.testRuns).toBe(1);

      repo.commit("more", { "b.txt": "b" });
      const failing = makeDeps(repo.dir, { testPlan: fakeTestPlan, testCache, testExitCode: 1 });
      await runPush(failing.deps, options());
      const again = makeDeps(repo.dir, { testPlan: fakeTestPlan, testCache, testExitCode: 1 });
      await runPush(again.deps, options());
      expect(failing.testRuns).toBe(1);
      expect(again.testRuns).toBe(1);
    });
  });
});

describe("divergence guard", () => {
  /**
   * The dangerous shape: we are behind the default branch (so pull-pal will
   * rebase and therefore force-push) *and* a teammate has pushed to our own
   * branch. Without the guard, that force-push silently destroys their commit —
   * and pull-pal's lease does not help: it is pinned to what this run fetched,
   * which already includes the teammate's commit.
   */
  function setUpDivergence(repo: Fixture) {
    repo.git(["checkout", "-q", "-b", "feature"]);
    repo.commit("first", { "f.txt": "1" });
    repo.git(["push", "-q", "-u", "origin", "feature"]);
    repo.advanceRemote("main", "unrelated main work"); // ⇒ a rebase gets planned
    const teammate = repo.advanceRemote("feature", "teammate on my branch");
    const mine = repo.commit("second", { "f.txt": "2" });
    return { teammate, mine };
  }

  test("blocks the force-push when the upstream holds commits we do not have", async () => {
    await withRepo(async (repo) => {
      const { teammate } = setUpDivergence(repo);

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ syncPolicy: "rebase" }));

      expect(result.exitCode).toBe(EXIT.blocked);
      expect(result.blocked).toBe("diverged-upstream");
      expect(result.pushed).toBe(false);
      expect(result.rebased).toBe(false);
      // The teammate's commit is still the tip of the remote branch.
      expect(remoteSha(repo, "feature")).toBe(teammate);
      expect(h.ui.text()).toContain("would destroy them");
    });
  });

  // A bare lease trusts refs/remotes/*, which the user may not have looked at,
  // so it is not the "I know what I am overwriting" that --force is.
  test("a bare --force-with-lease leaves the guard on", async () => {
    await withRepo(async (repo) => {
      const { teammate } = setUpDivergence(repo);

      const h = makeDeps(repo.dir);
      const result = await runPush(
        h.deps,
        options({ syncPolicy: "rebase", gitArgs: ["--force-with-lease"] }),
      );

      expect(result.blocked).toBe("diverged-upstream");
      expect(remoteSha(repo, "feature")).toBe(teammate);
    });
  });

  test("an explicit force flag takes ownership and proceeds", async () => {
    await withRepo(async (repo) => {
      setUpDivergence(repo);

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ syncPolicy: "rebase", gitArgs: ["--force"] }));

      expect(result.blocked).toBeNull();
      expect(result.pushed).toBe(true);
      expect(remoteSha(repo, "feature")).toBe(repo.sha("HEAD"));
    });
  });
});

describe("preflight", () => {
  test("refuses a detached HEAD", async () => {
    await withRepo(async (repo) => {
      repo.commit("second", { "b.txt": "b" });
      repo.git(["checkout", "-q", "--detach", "HEAD"]);

      const h = makeDeps(repo.dir);
      const error = await runPush(h.deps, options()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UserFacingError);
      expect((error as UserFacingError).message).toContain("detached");
      expect((error as UserFacingError).exitCode).toBe(EXIT.preflight);
    });
  });

  test("refuses when a rebase is already in progress", async () => {
    await withRepo(async (repo) => {
      repo.commit("local edit", { "README.md": "local\n" });
      repo.advanceRemote("main", "conflicting", { "README.md": "remote\n" });
      repo.git(["fetch", "origin"]);
      // Deliberately leave the repo mid-conflict.
      expect(repo.git(["rebase", "origin/main"]).exitCode).not.toBe(0);

      const h = makeDeps(repo.dir);
      const error = await runPush(h.deps, options()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UserFacingError);
      expect((error as UserFacingError).message).toContain("rebase is already in progress");

      repo.git(["rebase", "--abort"]);
    });
  });

  test("refuses a repository with no remotes", async () => {
    await withRepo(async (repo) => {
      repo.git(["remote", "remove", "origin"]);

      const h = makeDeps(repo.dir);
      const error = await runPush(h.deps, options()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UserFacingError);
      expect((error as UserFacingError).message).toContain("no remotes");
    });
  });
});

describe("dry run", () => {
  test("reports the plan and changes nothing", async () => {
    await withRepo(async (repo) => {
      const before = repo.sha("HEAD");
      repo.advanceRemote("main", "teammate work");
      const remoteBefore = remoteSha(repo);

      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan });
      const result = await runPush(h.deps, options({ dryRun: true, syncPolicy: "rebase" }));

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.rebased).toBe(false);
      expect(result.pushed).toBe(false);
      expect(h.testRuns).toBe(0);
      expect(repo.sha("HEAD")).toBe(before);
      expect(remoteSha(repo)).toBe(remoteBefore);

      const out = h.ui.text();
      expect(out).toContain("Dry run");
      expect(out).toContain("rebase onto origin/main");
      expect(out).toContain("stub-runner test");
    });
  });

  test("under the default policy the plan is a comparison, not a rebase", async () => {
    await withRepo(async (repo) => {
      publishFeature(repo);
      repo.advanceRemote("main", "teammate work");

      const h = makeDeps(repo.dir);
      await runPush(h.deps, options({ dryRun: true }));

      expect(h.ui.text()).toContain("compare with origin/main");
      expect(h.ui.text()).toContain("merges cleanly");
      expect(h.ui.text()).not.toContain("--force-with-lease");
    });
  });

  // The plan is only useful if it is the plan: a first push publishes the
  // branch, so --dry-run has to say so rather than printing a bare `git push`.
  test("reports --set-upstream for a branch that has never been pushed", async () => {
    await withRepo(async (repo) => {
      repo.git(["checkout", "-q", "-b", "brand-new"]);
      repo.commit("work", { "n.txt": "n" });

      const h = makeDeps(repo.dir);
      await runPush(h.deps, options({ dryRun: true }));

      expect(h.ui.text()).toContain("git push --set-upstream origin brand-new");
    });
  });
});

describe("--no-sync", () => {
  // Resolving the default branch falls back to `ls-remote` and then caches the
  // answer as origin/HEAD. With sync off neither may happen: the flag promises
  // no network, so the absence of that cached ref afterwards is the proof.
  test("never resolves the default branch over the network", async () => {
    await withRepo(async (repo) => {
      expect(repo.git(["remote", "set-head", "origin", "--delete"]).exitCode).toBe(0);
      repo.commit("local work", { "a.txt": "a" });
      const h = makeDeps(repo.dir);

      const result = await runPush(h.deps, options({ sync: false }));

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.pushed).toBe(true);
      const head = repo.git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
      expect(head.exitCode).not.toBe(0);
    });
  });
});

/**
 * pull-pal fetches into refs/pull-pal/* and never moves refs/remotes/*. Those
 * refs are what a bare --force-with-lease compares against; a fetch that moved
 * them would make every such lease agree with the remote, protecting nothing.
 */
describe("the user's remote-tracking refs are left alone (review #1, #4)", () => {
  test("a run compares against the fresh remote without moving origin/main", async () => {
    await withRepo(async (repo) => {
      publishFeature(repo);
      const stale = repo.sha("origin/main");
      const teammate = repo.advanceRemote("main", "teammate work");
      repo.commit("more", { "g.txt": "g" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options());

      expect(result.pushed).toBe(true);
      expect(h.ui.text()).toContain("behind origin/main by 1 commit");
      expect(repo.sha("refs/pull-pal/origin/main")).toBe(teammate);
      expect(repo.sha("origin/main")).toBe(stale);
    });
  });

  test("a bare --force-with-lease still refuses to overwrite a commit you never fetched", async () => {
    await withRepo(async (repo) => {
      publishFeature(repo);
      const teammate = repo.advanceRemote("feature", "teammate on my branch");
      repo.git(["commit", "-q", "--amend", "-m", "feature work, amended"]);

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ gitArgs: ["--force-with-lease"] }));

      // Exactly what plain `git push --force-with-lease` does: stale, rejected.
      expect(result.pushed).toBe(false);
      expect(remoteSha(repo, "feature")).toBe(teammate);
    });
  });

  test("sync policy off fetches nothing", async () => {
    await withRepo(async (repo) => {
      repo.advanceRemote("main", "teammate work");
      const h = makeDeps(repo.dir);

      await runPush(h.deps, options({ syncPolicy: "off" }));

      expect(h.ui.text()).not.toContain("Fetching");
      const copy = repo.git(["rev-parse", "--verify", "--quiet", "refs/pull-pal/origin/main"]);
      expect(copy.exitCode).not.toBe(0);
    });
  });
});

describe("where the push goes (review #11)", () => {
  function addFork(repo: Fixture): string {
    const forkDir = join(repo.remoteDir, "..", "fork.git");
    repo.git(["init", "-q", "--bare", forkDir]);
    repo.git(["remote", "add", "fork", forkDir]);
    repo.git(["push", "-q", "fork", "main"]);
    return forkDir;
  }

  const shaOn = (repo: Fixture, dir: string, branch: string) =>
    repo.git(["ls-remote", dir, `refs/heads/${branch}`]).stdout.split(/\s+/)[0] ?? "";

  test("remote.pushDefault publishes a new branch to that remote, not origin", async () => {
    await withRepo(async (repo) => {
      const forkDir = addFork(repo);
      repo.git(["config", "remote.pushDefault", "fork"]);
      repo.git(["checkout", "-q", "-b", "feature"]);
      const sha = repo.commit("feature work", { "f.txt": "f" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options());

      expect(result.pushed).toBe(true);
      expect(shaOn(repo, forkDir, "feature")).toBe(sha);
      expect(remoteSha(repo, "feature")).toBe("");
    });
  });

  test("branch.<name>.pushRemote wins over the upstream remote", async () => {
    await withRepo(async (repo) => {
      const forkDir = addFork(repo);
      publishFeature(repo); // upstream: origin/feature
      repo.git(["config", "branch.feature.pushRemote", "fork"]);
      const sha = repo.commit("more", { "g.txt": "g" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options());

      expect(result.pushed).toBe(true);
      expect(shaOn(repo, forkDir, "feature")).toBe(sha);
      expect(remoteSha(repo, "feature")).not.toBe(sha);
    });
  });

  test("--repo is honoured, not overridden by an added positional", async () => {
    await withRepo(async (repo) => {
      const forkDir = addFork(repo);
      repo.git(["checkout", "-q", "-b", "feature"]);
      const sha = repo.commit("feature work", { "f.txt": "f" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ gitArgs: ["--repo=fork"] }));

      expect(result.pushed).toBe(true);
      expect(shaOn(repo, forkDir, "feature")).toBe(sha);
      expect(remoteSha(repo, "feature")).toBe("");
    });
  });
});

describe("smaller review fixes", () => {
  // Review #12: git refused before rewriting anything, so there is no rebase to
  // continue — the old advice (`git rebase --continue`) failed.
  test("a rebase that never started is reported as such", async () => {
    await withRepo(async (repo) => {
      publishFeature(repo);
      repo.advanceRemote("main", "adds x", { "x.txt": "theirs\n" });
      repo.writeFile("x.txt", "mine, untracked\n");
      const before = repo.sha("HEAD");

      const h = makeDeps(repo.dir);
      const error = await runPush(h.deps, options({ syncPolicy: "rebase" })).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(UserFacingError);
      const hint = (error as UserFacingError).hint ?? "";
      expect(hint).toContain("could not start");
      expect(hint).not.toContain("rebase --continue");
      expect(repo.sha("HEAD")).toBe(before);
      expect(readFileSync(join(repo.dir, "x.txt"), "utf8")).toBe("mine, untracked\n");
      expect(existsSync(join(repo.dir, ".git", "rebase-merge"))).toBe(false);
    });
  });

  // Review #7: `git status` follows this setting, so untracked files looked clean.
  test("status.showUntrackedFiles=no does not hide an untracked file from the isolation", async () => {
    await withRepo(async (repo) => {
      repo.git(["config", "status.showUntrackedFiles", "no"]);
      repo.commit("work", { "a.txt": "a" });
      repo.writeFile("forgot-to-add.txt", "untracked\n");

      let visible: boolean | null = null;
      const h = makeDeps(repo.dir, {
        testPlan: fakeTestPlan,
        duringTests: () => {
          visible = existsSync(join(repo.dir, "forgot-to-add.txt"));
        },
      });
      await runPush(h.deps, options());

      expect(visible as boolean | null).toBe(false);
      expect(existsSync(join(repo.dir, "forgot-to-add.txt"))).toBe(true);
    });
  });

  test("a suite that finds no tests (pytest exit 5) does not block the push", async () => {
    await withRepo(async (repo) => {
      const sha = repo.commit("work", { "a.txt": "a" });
      const h = makeDeps(repo.dir, {
        testPlan: { ...fakeTestPlan, noTestsExitCode: 5 },
        testExitCode: 5,
      });

      const result = await runPush(h.deps, options());

      expect(result.pushed).toBe(true);
      expect(remoteSha(repo)).toBe(sha);
      expect(h.ui.text()).toContain("found no tests");
    });
  });

  test("refuses when a revert is in progress", async () => {
    await withRepo(async (repo) => {
      const first = repo.commit("edit", { "README.md": "one\n" });
      repo.commit("edit again", { "README.md": "two\n" });
      expect(repo.git(["revert", "--no-edit", first]).exitCode).not.toBe(0);

      const h = makeDeps(repo.dir);
      const error = await runPush(h.deps, options()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UserFacingError);
      expect((error as UserFacingError).message).toContain("revert is already in progress");
      repo.git(["revert", "--abort"]);
    });
  });

  // The cache used to be checked against the tree from before the rebase.
  test("a dry run that would rebase does not claim the suite will be skipped", async () => {
    await withRepo(async (repo) => {
      publishFeature(repo);
      repo.advanceRemote("main", "teammate");
      const cache = createMemoryTestCache();
      cache.record(repo.git(["rev-parse", "HEAD^{tree}"]).stdout, fakeTestPlan);

      const h = makeDeps(repo.dir, { testPlan: fakeTestPlan, testCache: cache });
      await runPush(h.deps, options({ syncPolicy: "rebase", dryRun: true }));

      expect(h.ui.text()).toContain("on the rebased commit");
      expect(h.ui.text()).not.toContain("would be skipped");
      expect(h.ui.text()).toContain("--force-with-lease=refs/heads/feature:");
    });
  });
});
