/**
 * Workflow-level tests against real git repositories.
 *
 * These drive `runPush` directly (test detection/execution is stubbed) so the
 * sync, safety, and push behaviour is exercised end to end without needing the
 * CLI layer. Each scenario asserts on the *remote* where it matters — that is
 * the only place "did the push really happen" can be answered honestly.
 */

import { describe, expect, test } from "bun:test";
import { EXIT, UserFacingError } from "../../src/core/errors";
import { runPush } from "../../src/core/workflow";
import { type makeRepo, withRepo } from "../helpers/fixture";
import { fakeTestPlan, makeDeps, options } from "../helpers/harness";

/** Sha of a branch as it exists on the bare remote. */
function remoteSha(repo: ReturnType<typeof makeRepo>, branch = "main"): string {
  return (
    repo.git(["ls-remote", repo.remoteDir, `refs/heads/${branch}`]).stdout.split(/\s+/)[0] ?? ""
  );
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

  test("behind the default branch: rebases, then force-pushes with a lease", async () => {
    await withRepo(async (repo) => {
      const teammate = repo.advanceRemote("main", "teammate work");
      repo.commit("my work", { "mine.txt": "mine" });
      const h = makeDeps(repo.dir);

      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.rebased).toBe(true);
      expect(result.pushed).toBe(true);

      // Our commit now sits on top of the teammate's on the remote.
      const pushed = remoteSha(repo);
      expect(pushed).toBe(repo.sha("HEAD"));
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
      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.ok);
      expect(result.rebased).toBe(true);
      // The edit survived the rebase.
      expect(await Bun.file(`${repo.dir}/work.txt`).text()).toBe("uncommitted edit\n");
      expect(repo.git(["status", "--porcelain"]).stdout).toContain("work.txt");
      expect(h.ui.text()).toContain("stashed and restored");
    });
  });

  test("rebase conflict: aborts cleanly, leaves no mid-rebase state, pushes nothing", async () => {
    await withRepo(async (repo) => {
      const before = repo.commit("local edit", { "README.md": "local version\n" });
      repo.advanceRemote("main", "conflicting", { "README.md": "remote version\n" });
      const remoteBefore = remoteSha(repo);

      const h = makeDeps(repo.dir);
      const error = await runPush(h.deps, options()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UserFacingError);
      const err = error as UserFacingError;
      expect(err.message).toContain("Could not rebase");
      expect(err.hint).toContain("rolled back");

      // The critical guarantee: the repo is exactly as it was.
      expect(repo.sha("HEAD")).toBe(before);
      expect(repo.git(["rev-parse", "--git-path", "rebase-merge"]).exitCode).toBe(0);
      expect(repo.git(["status", "--porcelain"]).stdout).toBe("");
      expect(remoteSha(repo)).toBe(remoteBefore);
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

  test("--no-sync skips the rebase even when behind", async () => {
    await withRepo(async (repo) => {
      repo.advanceRemote("main", "teammate work");
      repo.commit("my work", { "mine.txt": "mine" });

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ sync: false }));

      expect(result.rebased).toBe(false);
      expect(h.ui.text()).toContain("--no-sync");
      // Non-fast-forward: git itself rejects it, and we report the failure.
      expect(result.pushed).toBe(false);
    });
  });

  test("sync policy off fetches but never rebases", async () => {
    await withRepo(async (repo) => {
      repo.advanceRemote("main", "teammate work");
      const h = makeDeps(repo.dir);

      const result = await runPush(h.deps, options({ syncPolicy: "off" }));

      expect(result.rebased).toBe(false);
      expect(h.ui.text()).toContain("disabled");
      // The fetch still happened, so we know about the teammate's commit.
      expect(repo.git(["rev-parse", "origin/main"]).stdout).not.toBe(repo.sha("HEAD"));
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

describe("divergence guard", () => {
  /**
   * The dangerous shape: we are behind the default branch (so pull-pal will
   * rebase and therefore force-push) *and* a teammate has pushed to our own
   * branch. Without the guard, that force-push silently destroys their commit —
   * and --force-with-lease does not help, because this run already fetched.
   */
  function setUpDivergence(repo: ReturnType<typeof makeRepo>) {
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
      const result = await runPush(h.deps, options());

      expect(result.exitCode).toBe(EXIT.blocked);
      expect(result.blocked).toBe("diverged-upstream");
      expect(result.pushed).toBe(false);
      expect(result.rebased).toBe(false);
      // The teammate's commit is still the tip of the remote branch.
      expect(remoteSha(repo, "feature")).toBe(teammate);
      expect(h.ui.text()).toContain("would destroy them");
    });
  });

  test("an explicit force flag takes ownership and proceeds", async () => {
    await withRepo(async (repo) => {
      setUpDivergence(repo);

      const h = makeDeps(repo.dir);
      const result = await runPush(h.deps, options({ gitArgs: ["--force"] }));

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
      const result = await runPush(h.deps, options({ dryRun: true }));

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
