import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestPlan } from "../../src/core/types";
import { shellPlan } from "../../src/detect/index";
import { createFileTestCache } from "../../src/test-cache";
import { isRunnable, runTests } from "../../src/testing";

const plan: TestPlan = { command: "bun", args: ["test"], label: "bun test", source: "test" };
const TREE = "a".repeat(40);

function withDir(fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pullpal-cache-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("file test cache", () => {
  test("remembers a passing tree across instances", async () => {
    await withDir((dir) => {
      const file = join(dir, "pullpal", "passed-trees");
      createFileTestCache(file).record(TREE, plan);
      expect(createFileTestCache(file).has(TREE, plan)).toBe(true);
    });
  });

  test("a different command is a different entry", async () => {
    await withDir((dir) => {
      const cache = createFileTestCache(join(dir, "passed-trees"));
      cache.record(TREE, plan);
      expect(cache.has(TREE, { ...plan, args: ["run", "test"] })).toBe(false);
      expect(cache.has("b".repeat(40), plan)).toBe(false);
    });
  });

  test("keeps a bounded number of entries", async () => {
    await withDir((dir) => {
      const file = join(dir, "passed-trees");
      const cache = createFileTestCache(file);
      for (let i = 0; i < 250; i++) cache.record(i.toString(16).padStart(40, "0"), plan);
      expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(200);
      expect(cache.has("0".repeat(40), plan)).toBe(false);
      expect(cache.has((249).toString(16).padStart(40, "0"), plan)).toBe(true);
    });
  }, 30000);

  test("an unreadable location degrades to a cache that remembers nothing", () => {
    const cache = createFileTestCache(join(tmpdir(), "\0invalid", "passed-trees"));
    expect(() => cache.record(TREE, plan)).not.toThrow();
    expect(cache.has(TREE, plan)).toBe(false);
  });
});

describe("runTests", () => {
  // pull-pal must outlive Ctrl+C: it holds the user's stashed changes.
  test("an interrupt is passed to the suite and reported as 130", async () => {
    const sleeper: TestPlan = {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 20000)"],
      label: "sleep",
      source: "test",
    };
    const started = Date.now();
    const running = runTests(sleeper);
    setTimeout(() => process.emit("SIGINT", "SIGINT"), 300);

    expect(await running).toBe(130);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  // On Windows, cmd.exe does not understand the usual argv escaping, so a
  // configured `npm test -- --grep "my suite"` arrived split in two.
  test("quotes inside a configured command reach the program intact", async () => {
    await withDir(async (dir) => {
      const check = join(dir, "argv-check.js");
      writeFileSync(
        check,
        'process.exit(process.argv[2] === "a b" && process.argv[3] === "c" ? 0 : 3);\n',
      );
      const command = `"${process.execPath}" "${check}" "a b" c`;
      expect(await runTests(shellPlan(command, process.platform, "test"))).toBe(0);
    });
  });

  // ./gradlew lives in the repo: resolved against the repo root, never PATH.
  test("a repo-relative command runs from the repo root, wherever pull-pal started", async () => {
    await withDir(async (dir) => {
      const windows = process.platform === "win32";
      const name = windows ? "wrapper.bat" : "wrapper";
      writeFileSync(join(dir, name), windows ? "@exit /b 7\r\n" : "#!/bin/sh\nexit 7\n");
      if (!windows) chmodSync(join(dir, name), 0o755);
      const wrapper: TestPlan = { command: `./${name}`, args: [], label: name, source: "test" };

      expect(isRunnable(wrapper.command, dir)).toBe(true);
      expect(isRunnable("./missing-wrapper", dir)).toBe(false);
      expect(await runTests(wrapper, { cwd: dir })).toBe(7);
    });
  });
});
