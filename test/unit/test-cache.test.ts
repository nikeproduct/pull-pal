import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestPlan } from "../../src/core/types";
import { createFileTestCache } from "../../src/test-cache";
import { runTests } from "../../src/testing";

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
});
