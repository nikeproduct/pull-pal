/**
 * End-to-end tests: the real CLI process, against real repositories.
 *
 * These are the only tests that exercise argument parsing, config loading, the
 * reporter, and the error boundary together — i.e. what a user actually runs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/core/errors";
import { type makeRepo, withRepo } from "../helpers/fixture";

describe("informational commands", () => {
  test("--version prints just the version", async () => {
    await withRepo(async (repo) => {
      const r = await repo.runPullPal(["--version"]);
      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  test("--help exits 0 and documents the flags", async () => {
    await withRepo(async (repo) => {
      const r = await repo.runPullPal(["--help"]);
      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stdout).toContain("--no-sync");
      expect(r.stdout).toContain("Usage:");
    });
  });

  test("doctor reports the repo without changing it", async () => {
    await withRepo(async (repo) => {
      const before = repo.sha("HEAD");
      const r = await repo.runPullPal(["doctor"]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stdout).toContain("Repository");
      expect(r.stdout).toContain("branch          main");
      expect(r.stdout).toContain("default branch  origin/main");
      expect(repo.sha("HEAD")).toBe(before);
    });
  });

  // It used to resolve an unknown default branch with ls-remote and then cache
  // it as origin/HEAD: a network call and a ref write from a diagnostic.
  test("doctor makes no network calls and writes no refs", async () => {
    await withRepo(async (repo) => {
      expect(repo.git(["remote", "set-head", "origin", "--delete"]).exitCode).toBe(0);

      const r = await repo.runPullPal(["doctor"]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stdout).toContain("not known locally");
      const head = repo.git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
      expect(head.exitCode).not.toBe(0);
    });
  });

  // It used to assume origin; the push follows remote.pushDefault.
  test("doctor names the remote a push would actually use", async () => {
    await withRepo(async (repo) => {
      repo.git(["remote", "add", "fork", repo.remoteDir]);
      repo.git(["config", "remote.pushDefault", "fork"]);

      const r = await repo.runPullPal(["doctor"]);

      expect(r.stdout).toContain("pushes to       fork");
    });
  });
});

describe("push", () => {
  test("pushes a clean, up-to-date branch", async () => {
    await withRepo(async (repo) => {
      const sha = repo.commit("work", { "a.txt": "a" });
      const r = await repo.runPullPal([]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stderr).toContain("Pushed successfully");
      expect(repo.git(["ls-remote", repo.remoteDir, "refs/heads/main"]).stdout).toContain(sha);
    });
  });

  test("pullpal.sync=rebase rebases and force-pushes when behind", async () => {
    await withRepo(async (repo) => {
      repo.git(["config", "pullpal.sync", "rebase"]);
      repo.advanceRemote("main", "teammate");
      repo.commit("mine", { "mine.txt": "mine" });

      const r = await repo.runPullPal([]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stderr).toContain("Rebased onto origin/main");
      expect(r.stderr).toContain("--force-with-lease");
      expect(repo.git(["ls-remote", repo.remoteDir, "refs/heads/main"]).stdout).toContain(
        repo.sha("HEAD"),
      );
    });
  });

  test("--dry-run prints the plan and changes nothing", async () => {
    await withRepo(async (repo) => {
      repo.git(["config", "pullpal.sync", "rebase"]);
      repo.advanceRemote("main", "teammate");
      const before = repo.sha("HEAD");
      const remoteBefore = repo.git(["ls-remote", repo.remoteDir, "refs/heads/main"]).stdout;

      const r = await repo.runPullPal(["--dry-run"]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stderr).toContain("Dry run");
      expect(r.stderr).toContain("rebase onto origin/main");
      expect(repo.sha("HEAD")).toBe(before);
      expect(repo.git(["ls-remote", repo.remoteDir, "refs/heads/main"]).stdout).toBe(remoteBefore);
    });
  });

  test("a failing test suite blocks the push", async () => {
    await withRepo(async (repo) => {
      // A test command that always fails, via the documented override.
      repo.git(["config", "pullpal.testCommand", "exit 7"]);
      const remoteBefore = repo.git(["ls-remote", repo.remoteDir, "refs/heads/main"]).stdout;
      repo.commit("work", { "a.txt": "a" });

      const r = await repo.runPullPal([]);

      expect(r.exitCode).toBe(7);
      expect(r.stderr).toContain("Tests failed");
      expect(repo.git(["ls-remote", repo.remoteDir, "refs/heads/main"]).stdout).toBe(remoteBefore);
    });
  });

  test("--no-tests skips a suite that would have failed", async () => {
    await withRepo(async (repo) => {
      repo.git(["config", "pullpal.testCommand", "exit 7"]);
      repo.commit("work", { "a.txt": "a" });

      const r = await repo.runPullPal(["--no-tests"]);

      expect(r.exitCode).toBe(EXIT.ok);
      expect(r.stderr).toContain("Pushed successfully");
    });
  });

  test("pullpal.tests=off disables tests without a flag", async () => {
    await withRepo(async (repo) => {
      repo.git(["config", "pullpal.testCommand", "exit 7"]);
      repo.git(["config", "pullpal.tests", "off"]);
      repo.commit("work", { "a.txt": "a" });

      const r = await repo.runPullPal([]);
      expect(r.exitCode).toBe(EXIT.ok);
    });
  });

  test("pullpal.sync=off keeps the branch unrebased", async () => {
    await withRepo(async (repo) => {
      repo.git(["config", "pullpal.sync", "off"]);
      repo.advanceRemote("main", "teammate");
      const before = repo.sha("HEAD");

      const r = await repo.runPullPal(["--no-tests"]);

      expect(repo.sha("HEAD")).toBe(before);
      expect(r.stderr).toContain("disabled");
    });
  });
});

/**
 * The two cases from the v0.2 review, through the real CLI. Both used to plan a
 * rebase onto origin/main followed by `git push --force-with-lease`.
 */
describe("review regressions", () => {
  function setUp(repo: ReturnType<typeof makeRepo>) {
    repo.git(["checkout", "-q", "-b", "release/1.0"]);
    repo.commit("rel fix", { "rel.txt": "r" });
    repo.git(["push", "-q", "-u", "origin", "release/1.0"]);
    repo.git(["checkout", "-q", "main"]);
    repo.git(["checkout", "-q", "-b", "feature-a"]);
    repo.commit("a", { "a.txt": "a" });
    repo.git(["push", "-q", "-u", "origin", "feature-a"]);
    repo.git(["checkout", "-q", "main"]);
    repo.git(["checkout", "-q", "-b", "feature-x"]);
    repo.commit("x", { "x.txt": "x" });
    repo.git(["push", "-q", "-u", "origin", "feature-x"]);
    repo.advanceRemote("main", "main moved");
  }

  for (const policy of ["check", "rebase"]) {
    test(`[${policy}] pushing another branch: no sync, no lease`, async () => {
      await withRepo(async (repo) => {
        setUp(repo);
        repo.git(["config", "pullpal.sync", policy]);
        repo.git(["checkout", "-q", "feature-a"]);

        const r = await repo.runPullPal(["--dry-run", "--no-tests", "origin", "feature-x"]);

        expect(r.exitCode).toBe(EXIT.ok);
        expect(r.stderr).toContain("not the checked-out branch");
        expect(r.stderr).toContain("push:    git push origin feature-x");
        expect(r.stderr).not.toContain("--force-with-lease");
      });
    });

    test(`[${policy}] a release branch is not synced with main`, async () => {
      await withRepo(async (repo) => {
        setUp(repo);
        repo.git(["config", "pullpal.sync", policy]);
        repo.git(["checkout", "-q", "release/1.0"]);

        const r = await repo.runPullPal(["--dry-run", "--no-tests"]);

        expect(r.exitCode).toBe(EXIT.ok);
        expect(r.stderr).toContain("long-lived");
        expect(r.stderr).not.toContain("--force-with-lease");
      });
    });
  }
});

describe("test cache across runs", () => {
  /** Records each run in a file outside the work tree (see hook.test.ts). */
  const RECORD = "echo run >> ../runs.txt";
  const runs = (repo: ReturnType<typeof makeRepo>) => {
    try {
      return readFileSync(join(repo.dir, "..", "runs.txt"), "utf8")
        .split(/\r?\n/)
        .filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  test("a second run on the same commit skips the suite; --retest forces it", async () => {
    await withRepo(async (repo) => {
      repo.git(["config", "pullpal.testCommand", RECORD]);
      repo.commit("work", { "a.txt": "a" });

      expect((await repo.runPullPal([])).exitCode).toBe(EXIT.ok);
      const second = await repo.runPullPal([]);
      expect(runs(repo)).toBe(1);
      expect(second.stderr).toContain("already passed for this exact commit");

      await repo.runPullPal(["--retest"]);
      expect(runs(repo)).toBe(2);

      repo.git(["config", "pullpal.testCache", "off"]);
      await repo.runPullPal([]);
      expect(runs(repo)).toBe(3);
    });
  });
});

describe("error boundary", () => {
  test("a preflight failure prints a clean message, not a stack trace", async () => {
    await withRepo(async (repo) => {
      repo.git(["checkout", "-q", "--detach", "HEAD"]);

      const r = await repo.runPullPal([]);

      expect(r.exitCode).toBe(EXIT.preflight);
      expect(r.stderr).toContain("detached");
      expect(r.stderr).toContain("git checkout -b");
      expect(r.stderr).not.toContain("at <anonymous>");
      expect(r.stderr).not.toContain("this is a bug");
    });
  });

  test("running outside a repository fails cleanly", async () => {
    await withRepo(async (repo) => {
      // The scratch root above the clone is not itself a repository.
      const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../../src/index.ts`], {
        cwd: `${repo.dir}/..`,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

      expect(exitCode).toBe(EXIT.preflight);
      expect(stderr).toContain("Not inside a git repository");
    });
  });
});
