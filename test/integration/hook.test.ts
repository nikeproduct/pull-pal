/**
 * The pre-push hook, exercised through real `git push` invocations.
 *
 * This is the suite v0.1 most needed and did not have: every one of its hook
 * defects (URL-as-refspec, rebasing inside the hook, double test runs, hooks
 * installed where git never looks) is only observable when git itself drives
 * the hook.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/core/errors";
import { withRepo } from "../helpers/fixture";
import type { Fixture } from "../helpers/fixture";

/**
 * Count how many times the stubbed suite ran, via an append-only marker file.
 * It lives *outside* the work tree: pull-pal sets untracked files aside while the
 * tests run, and a marker inside the repo would be one of them.
 */
function testRunCount(repo: Fixture): number {
  const marker = join(repo.dir, "..", "testruns.txt");
  if (!existsSync(marker)) return 0;
  return readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean).length;
}

/** A test command that records each run and succeeds; works in sh and cmd. */
const RECORDING_PASS = "echo run >> ../testruns.txt";
const RECORDING_FAIL = "echo run >> ../testruns.txt && exit 1";

/** Publish a feature branch off main, so the default-branch check applies to it. */
function onFeatureBranch(repo: Fixture, files: Record<string, string> = { "f.txt": "f\n" }) {
  repo.git(["checkout", "-q", "-b", "feature"]);
  repo.commit("feature work", files);
  repo.git(["push", "-q", "-u", "origin", "feature"]);
}

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
   * Being behind main is not a reason to block: on an active repository it is
   * true of nearly every push, and CI tests the merge result anyway.
   */
  test("behind main but merging cleanly: the push goes through untouched", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.tests", "off"]);
      onFeatureBranch(repo);
      repo.advanceRemote("main", "teammate");
      const sha = repo.commit("mine", { "mine.txt": "mine" });

      const push = repo.git(["push", "origin", "feature"]);

      expect(push.exitCode).toBe(0);
      expect(remoteSha(repo, "feature")).toBe(sha);
      expect(push.stderr).not.toContain("Push blocked");
    });
  });

  /**
   * The defining v0.1 failure was rebasing inside the hook after git had already
   * resolved the pre-rebase sha. The gate never rewrites anything: it refuses.
   */
  test("a branch that no longer merges with main is blocked, history untouched", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.tests", "off"]);
      onFeatureBranch(repo, { "README.md": "feature version\n" });
      repo.advanceRemote("main", "teammate", { "README.md": "main version\n" });
      const remoteBefore = remoteSha(repo, "feature");
      const localBefore = repo.commit("mine", { "mine.txt": "mine" });

      const push = repo.git(["push", "origin", "feature"]);

      expect(push.exitCode).not.toBe(0);
      expect(push.stderr).toContain("Push blocked");
      expect(push.stderr).toContain("README.md");
      expect(push.stderr).toContain("--no-verify");
      expect(repo.sha("HEAD")).toBe(localBefore);
      expect(remoteSha(repo, "feature")).toBe(remoteBefore);
      expect(repo.git(["status", "--porcelain"]).stdout).toBe("");
    });
  });

  test("with pullpal.sync=rebase the hook points at pull-pal, which rebases", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.tests", "off"]);
      repo.git(["config", "pullpal.sync", "rebase"]);
      onFeatureBranch(repo);
      const teammate = repo.advanceRemote("main", "teammate");
      repo.commit("mine", { "mine.txt": "mine" });

      const push = repo.git(["push", "origin", "feature"]);
      expect(push.exitCode).toBe(0);
      expect(push.stderr).toContain("Run pull-pal to rebase");

      const r = await repo.runPullPal([]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(repo.git(["merge-base", "--is-ancestor", teammate, "HEAD"]).exitCode).toBe(0);
      expect(remoteSha(repo, "feature")).toBe(repo.sha("HEAD"));
    });
  });

  test("a push of a branch other than the checked-out one skips the checks", async () => {
    await withRepo(async (repo) => {
      repo.git(["branch", "other"]);
      repo.commit("main moves on", { "m.txt": "m" });
      repo.git(["checkout", "-q", "other"]);
      const otherSha = repo.commit("other work", { "o.txt": "o" });
      repo.git(["checkout", "-q", "main"]);

      await install(repo);
      repo.git(["config", "pullpal.testCommand", RECORDING_FAIL]);

      // Testing main's working tree would say nothing about "other".
      const push = repo.git(["push", "origin", "other"]);

      expect(push.exitCode).toBe(0);
      expect(testRunCount(repo)).toBe(0);
      expect(remoteSha(repo, "other")).toBe(otherSha);
      expect(push.stderr).toContain("checks only the checked-out branch");
    });
  });

  test("the tests see the commit being pushed, not uncommitted files", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      // Records what the suite could see; works under sh and cmd alike.
      repo.git([
        "config",
        "pullpal.testCommand",
        "git ls-files --others --exclude-standard > ../seen-by-tests.txt",
      ]);
      repo.commit("work", { "a.txt": "a" });
      repo.writeFile("not-added.txt", "forgot to git add this\n");

      const push = repo.git(["push", "origin", "main"]);

      expect(push.exitCode).toBe(0);
      expect(readFileSync(join(repo.dir, "..", "seen-by-tests.txt"), "utf8").trim()).toBe("");
      expect(existsSync(join(repo.dir, "not-added.txt"))).toBe(true);
      expect(repo.git(["stash", "list"]).stdout).toBe("");
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

      // A second remote whose main conflicts with ours, while origin stays current.
      const otherDir = join(repo.dir, "..", "other.git");
      expect(repo.git(["clone", "--quiet", "--bare", repo.remoteDir, otherDir]).exitCode).toBe(0);
      expect(repo.git(["remote", "add", "other", otherDir]).exitCode).toBe(0);
      const scratch = join(repo.dir, "..", "other-work");
      expect(repo.git(["clone", "--quiet", otherDir, scratch]).exitCode).toBe(0);
      repo.git(["-C", scratch, "config", "user.email", "test@pull-pal.dev"]);
      repo.git(["-C", scratch, "config", "user.name", "Pull Pal Test"]);
      repo.git(["-C", scratch, "config", "commit.gpgsign", "false"]);
      writeFileSync(join(scratch, "README.md"), "theirs\n");
      expect(repo.git(["-C", scratch, "commit", "-qam", "conflicting"]).exitCode).toBe(0);
      expect(repo.git(["-C", scratch, "push", "--quiet", "origin", "main"]).exitCode).toBe(0);

      repo.commit("mine", { "README.md": "ours\n" });
      const push = repo.git(["push", "other", "main"]);

      expect(push.exitCode).not.toBe(0);
      expect(push.stderr).toContain("Push blocked");
      expect(push.stderr).toContain("other/main");
    });
  });

  test("pullpal.onConflict=warn lets a conflicting push through", async () => {
    await withRepo(async (repo) => {
      await install(repo);
      repo.git(["config", "pullpal.tests", "off"]);
      repo.git(["config", "pullpal.onConflict", "warn"]);
      onFeatureBranch(repo, { "README.md": "feature version\n" });
      repo.advanceRemote("main", "teammate", { "README.md": "main version\n" });
      const sha = repo.commit("mine", { "mine.txt": "mine" });

      const push = repo.git(["push", "origin", "feature"]);

      expect(push.exitCode).toBe(0);
      expect(push.stderr).toContain("conflict with origin/main");
      expect(remoteSha(repo, "feature")).toBe(sha);
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
