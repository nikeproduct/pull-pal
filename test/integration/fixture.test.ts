import { describe, expect, test } from "bun:test";
import { makeRepo } from "../helpers/fixture";

describe("fixture (M0 proof)", () => {
  test("seeds a working clone wired to a bare remote on the default branch", () => {
    const repo = makeRepo();
    try {
      expect(repo.currentBranch()).toBe("main");
      // The seed commit is present on both the clone and the remote.
      const head = repo.sha("HEAD");
      const remoteHead = repo.git(["rev-parse", "origin/main"]).stdout;
      expect(remoteHead).toBe(head);
      expect(repo.git(["log", "--oneline"]).stdout).toContain("seed");
    } finally {
      repo.cleanup();
    }
  });

  test("commit + push lands new history on the remote", () => {
    const repo = makeRepo();
    try {
      const sha = repo.commit("local work", { "a.txt": "hello" });
      expect(repo.git(["push", "origin", "main"]).exitCode).toBe(0);
      expect(repo.git(["rev-parse", "origin/main"]).stdout).toBe(sha);
    } finally {
      repo.cleanup();
    }
  });

  test("advanceRemote makes the local clone strictly behind origin", () => {
    const repo = makeRepo();
    try {
      const remoteSha = repo.advanceRemote("main", "teammate work");
      repo.git(["fetch", "origin"]);
      const behind = repo.git(["rev-list", "--count", "HEAD..origin/main"]).stdout;
      expect(Number(behind)).toBe(1);
      expect(repo.git(["rev-parse", "origin/main"]).stdout).toBe(remoteSha);
    } finally {
      repo.cleanup();
    }
  });

  test("a custom default branch name is honored", () => {
    const repo = makeRepo({ defaultBranch: "trunk" });
    try {
      expect(repo.currentBranch()).toBe("trunk");
      expect(repo.git(["rev-parse", "origin/trunk"]).exitCode).toBe(0);
    } finally {
      repo.cleanup();
    }
  });
});
