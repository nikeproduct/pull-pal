/**
 * The pre-push hook, exercised through real `git push` invocations.
 *
 * This is the suite v0.1 most needed and did not have: every one of its hook
 * defects (URL-as-refspec, rebasing inside the hook, double test runs, hooks
 * installed where git never looks) is only observable when git itself drives
 * the hook.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/core/errors";
import { withRepo } from "../helpers/fixture";
import type { Fixture } from "../helpers/fixture";

/** Count how many times the stubbed suite ran, via an append-only marker file. */
function testRunCount(repo: Fixture): number {
  const marker = join(repo.dir, "testruns.txt");
  if (!existsSync(marker)) return 0;
  return readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean).length;
}

/** A test command that records each run and succeeds; works in sh and cmd. */
const RECORDING_PASS = "echo run >> testruns.txt";
const RECORDING_FAIL = "echo run >> testruns.txt && exit 1";

function remoteSha(repo: Fixture, branch = "main"): string {
  return (
    repo.git(["ls-remote", repo.remoteDir, `refs/heads/${branch}`]).stdout.split(/\s+/)[0] ?? ""
  );
}

async function install(repo: Fixture) {
  const r = await repo.runPullPal(["setup"]);
  expect(r.exitCode).toBe(EXIT.ok);
  return r;
}

describe("gate behaviour under real git push", () => {
  test("an up-to-date branch passes the gate and git completes the push", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.testCommand", RECORDING_PASS]);
      const sha = repo.commit("work", { "a.txt": "a" });

      const push = repo.git(["push", "origin", "main"]);

      expect(push.exitCode).toBe(0);
      expect(remoteSha(repo)).toBe(sha);
      expect(testRunCount(repo)).toBe(1);
    });
  });

  /**
   * The defining v0.1 failure. It rebased inside the hook and then pushed, but
   * git had already resolved the pre-rebase sha, so the user ended up rebased
   * and *not* pushed. The gate refuses instead, and leaves history alone.
   */
  test("being behind blocks the push and does not touch local history", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.tests", "off"]);
      repo.advanceRemote("main", "teammate");
      const localBefore = repo.commit("mine", { "mine.txt": "mine" });
      const remoteBefore = remoteSha(repo);

      const push = repo.git(["push", "origin", "main"]);

      expect(push.exitCode).not.toBe(0);
      expect(push.stderr).toContain("Push blocked");
      expect(push.stderr).toContain("Run pull-pal");
      // No rebase happened, and nothing reached the remote.
      expect(repo.sha("HEAD")).toBe(localBefore);
      expect(remoteSha(repo)).toBe(remoteBefore);
      expect(repo.git(["rev-parse", "--git-path", "rebase-merge"]).exitCode).toBe(0);
    });
  });

  test("the blocked push is resolved by running pull-pal, exactly as instructed", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.tests", "off"]);
      repo.advanceRemote("main", "teammate");
      repo.commit("mine", { "mine.txt": "mine" });

      expect(repo.git(["push", "origin", "main"]).exitCode).not.toBe(0);

      const r = await repo.runPullPal([]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(remoteSha(repo)).toBe(repo.sha("HEAD"));
    });
  });

  test("failing tests block the push", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.testCommand", RECORDING_FAIL]);
      const remoteBefore = remoteSha(repo);
      repo.commit("work", { "a.txt": "a" });

      const push = repo.git(["push", "origin", "main"]);

      expect(push.exitCode).not.toBe(0);
      expect(push.stderr).toContain("Tests failed");
      expect(push.stderr).toContain("--no-verify");
      expect(remoteSha(repo)).toBe(remoteBefore);
    });
  });

  test("--no-verify bypasses the gate, as advertised", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.testCommand", RECORDING_FAIL]);
      const sha = repo.commit("work", { "a.txt": "a" });

      expect(repo.git(["push", "--no-verify", "origin", "main"]).exitCode).toBe(0);
      expect(remoteSha(repo)).toBe(sha);
      expect(testRunCount(repo)).toBe(0);
    });
  });

  // Defect 8: hook + direct use double-ran fetch and the whole suite.
  test("pull-pal's own push does not re-trigger the hook", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.testCommand", RECORDING_PASS]);
      repo.commit("work", { "a.txt": "a" });

      const r = await repo.runPullPal([]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(testRunCount(repo)).toBe(1);
    });
  });

  test("branch deletions skip the gate entirely", async () => {
    await withRepo(async (repo) => {
      repo.git(["checkout", "-q", "-b", "doomed"]);
      repo.commit("temp", { "t.txt": "t" });
      repo.git(["push", "-q", "-u", "origin", "doomed"]);
      repo.git(["checkout", "-q", "main"]);

      await install(repo);
      repo.git(["config", "pullpal.testCommand", RECORDING_FAIL]);

      // Deleting a remote branch must not be gated by tests.
      const push = repo.git(["push", "origin", "--delete", "doomed"]);

      expect(push.exitCode).toBe(0);
      expect(testRunCount(repo)).toBe(0);
      expect(remoteSha(repo, "doomed")).toBe("");
    });
  });

  // Defect 20: git's ref list arrives on stdin; a test runner must not eat it.
  test("git's ref lines never reach the test runner", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      // Echo whatever stdin holds into a file; it must be empty.
      repo.git(["config", "pullpal.testCommand", "cat > stdin-capture.txt"]);
      repo.commit("work", { "a.txt": "a" });

      const push = repo.git(["push", "origin", "main"]);
      expect(push.exitCode).toBe(0);

      const capture = join(repo.dir, "stdin-capture.txt");
      const captured = existsSync(capture) ? readFileSync(capture, "utf8").trim() : "";
      expect(captured).toBe("");
    });
  });

  test("the gate checks the remote git is actually pushing to", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.tests", "off"]);

      // A second remote whose main is ahead of ours, while origin stays current.
      const otherDir = join(repo.dir, "..", "other.git");
      expect(repo.git(["clone", "--quiet", "--bare", repo.remoteDir, otherDir]).exitCode).toBe(0);
      expect(repo.git(["remote", "add", "other", otherDir]).exitCode).toBe(0);
      const scratch = join(repo.dir, "..", "other-work");
      expect(repo.git(["clone", "--quiet", otherDir, scratch]).exitCode).toBe(0);
      repo.git(["-C", scratch, "config", "user.email", "test@pull-pal.dev"]);
      repo.git(["-C", scratch, "config", "user.name", "Pull Pal Test"]);
      repo.git(["-C", scratch, "config", "commit.gpgsign", "false"]);
      expect(repo.git(["-C", scratch, "commit", "--allow-empty", "-m", "ahead"]).exitCode).toBe(0);
      expect(repo.git(["-C", scratch, "push", "--quiet", "origin", "main"]).exitCode).toBe(0);

      repo.commit("mine", { "mine.txt": "mine" });
      const push = repo.git(["push", "other", "main"]);

      expect(push.exitCode).not.toBe(0);
      expect(push.stderr).toContain("Push blocked");
      expect(push.stderr).toContain("other/main");
    });
  });

  test("pullpal.hookGate=warn lets an out-of-date push through", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.tests", "off"]);
      repo.git(["config", "pullpal.hookGate", "warn"]);
      repo.advanceRemote("main", "teammate");
      repo.commit("mine", { "mine.txt": "mine" });

      const push = repo.git(["push", "origin", "main"]);

      // The gate warned but allowed it; git then rejects it as non-fast-forward,
      // which is git's own correct behaviour, not pull-pal blocking.
      expect(push.stderr).toContain("Run pull-pal to rebase");
    });
  });
});

describe("setup and remove-hook", () => {
  test("setup writes an executable hook and remove-hook takes it away", async () => {
    await withRepo(async (repo) => {
      const hookPath = join(repo.dir, ".git", "hooks", "pre-push");

      await install(repo);
      expect(existsSync(hookPath)).toBe(true);
      expect(readFileSync(hookPath, "utf8")).toContain("pull-pal hook");

      const removed = await repo.runPullPal(["remove-hook"]);
      expect(removed.exitCode).toBe(EXIT.ok);
      expect(existsSync(hookPath)).toBe(false);
    });
  });

  test("setup is idempotent", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      const second = await repo.runPullPal(["setup"]);
      expect(second.exitCode).toBe(EXIT.ok);
      expect(second.stderr).toContain("already installed");
    });
  });

  test("remove-hook on a repo with no hook is a no-op, not an error", async () => {
    await withRepo(async (repo) => {
      const r = await repo.runPullPal(["remove-hook"]);
      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stderr).toContain("nothing to remove");
    });
  });

  test("a foreign pre-push hook is never overwritten or deleted", async () => {
    await withRepo(async (repo) => {
      const hookPath = join(repo.dir, ".git", "hooks", "pre-push");
      const original = "#!/bin/sh\necho someone elses hook\n";
      repo.writeFile(".git/hooks/pre-push", original);

      const setup = await repo.runPullPal(["setup"]);
      expect(setup.exitCode).not.toBe(EXIT.ok);
      expect(setup.stderr).toContain("not written by pull-pal");
      expect(readFileSync(hookPath, "utf8")).toBe(original);

      const remove = await repo.runPullPal(["remove-hook"]);
      expect(remove.exitCode).not.toBe(EXIT.ok);
      expect(existsSync(hookPath)).toBe(true);
    });
  });

  // Defect 10: v0.1 wrote to .git/hooks unconditionally, so husky/lefthook repos
  // reported success while installing a hook git would never run.
  test("core.hooksPath is honoured", async () => {
    await withRepo(async (repo) => {
      repo.git(["config", "core.hooksPath", ".githooks"]);

      const r = await repo.runPullPal(["setup"]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(existsSync(join(repo.dir, ".githooks", "pre-push"))).toBe(true);
      expect(existsSync(join(repo.dir, ".git", "hooks", "pre-push"))).toBe(false);
    });
  });

  // Defect 10: in a linked worktree `.git` is a *file*, which crashed v0.1.
  test("setup works inside a linked worktree", async () => {
    await withRepo(async (repo) => {
      const wt = join(repo.dir, "..", "wt");
      expect(repo.git(["worktree", "add", "-q", "-b", "side", wt]).exitCode).toBe(0);

      const proc = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "..", "..", "src", "index.ts"), "setup"],
        { cwd: wt, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      );
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(exitCode).toBe(EXIT.ok);
      expect(stderr).toContain("hook installed");
      repo.git(["worktree", "remove", "--force", wt]);
    });
  });

  test("doctor reports hook status", async () => {
    await withRepo(async (repo) => {
      const before = await repo.runPullPal(["doctor"]);
      expect(before.stdout).toContain("not installed");

      await install(repo);

      const after = await repo.runPullPal(["doctor"]);
      expect(after.stdout).toContain("pre-push");
      expect(after.stdout).toContain("installed (v2)");
    });
  });
});
