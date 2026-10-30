/**
 * Remembering which trees have already passed.
 *
 * Tests run against a stashed-clean working tree, so what they verify is
 * exactly HEAD's tree. A tree id names that content completely: if the same tree
 * passed with the same command before, running the suite again proves nothing
 * new. That is common — a push retried after a network error, the hook having
 * already run, a rebase that turned out to be a no-op — and on a suite that
 * takes minutes it is the difference between a gate people keep and one they
 * bypass.
 *
 * Only passes are recorded. A failure is always re-run.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TestPlan } from "./core/types";

export interface TestCache {
  has(tree: string, plan: TestPlan): boolean;
  record(tree: string, plan: TestPlan): void;
}

/** How many passing trees to remember. Old entries fall off the front. */
const MAX_ENTRIES = 200;

function entryFor(tree: string, plan: TestPlan): string {
  const command = JSON.stringify([plan.command, plan.args, plan.shell === true]);
  const digest = createHash("sha256").update(command).digest("hex").slice(0, 16);
  return `${tree} ${digest}`;
}

/** A cache persisted at `file` (inside the repo's git dir). Never throws. */
export function createFileTestCache(file: string): TestCache {
  const read = (): string[] => {
    try {
      return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    has(tree, plan) {
      return read().includes(entryFor(tree, plan));
    },
    record(tree, plan) {
      const entry = entryFor(tree, plan);
      const entries = read().filter((e) => e !== entry);
      entries.push(entry);
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${entries.slice(-MAX_ENTRIES).join("\n")}\n`, "utf8");
      } catch {
        // A cache that cannot be written only costs a re-run next time.
      }
    },
  };
}

/** In-memory cache for tests and for runs where the git dir is unavailable. */
export function createMemoryTestCache(): TestCache {
  const entries = new Set<string>();
  return {
    has: (tree, plan) => entries.has(entryFor(tree, plan)),
    record: (tree, plan) => {
      entries.add(entryFor(tree, plan));
    },
  };
}
