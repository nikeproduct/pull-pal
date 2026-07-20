/**
 * End-to-end tests: the real CLI process, against real repositories.
 *
 * These are the only tests that exercise argument parsing, config loading, the
 * reporter, and the error boundary together — i.e. what a user actually runs.
 */

import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/core/errors";
import { withRepo } from "../helpers/fixture";

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

  test("rebases and force-pushes when behind the default branch", async () => {
    await withRepo(async (repo) => {
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
