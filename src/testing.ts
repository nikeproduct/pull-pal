/**
 * Running the project's test suite.
 *
 * Kept separate from detection so the decision ("what would we run") stays pure
 * and the effect ("run it") stays trivial.
 */

import type { TestPlan } from "./core/types";

/**
 * Is this command actually invocable?
 *
 * Checked before spawning so a project that declares pytest on a machine without
 * pytest produces a warning and a skipped step, not an ENOENT crash that blocks
 * the push.
 */
export function isRunnable(command: string): boolean {
  return Bun.which(command) !== null;
}

export interface RunTestsOptions {
  cwd?: string;
  /**
   * Hook mode must not inherit stdin: git feeds the pre-push hook its ref lines
   * there, and a test runner that reads stdin would consume them.
   */
  inheritStdin?: boolean;
}

export async function runTests(plan: TestPlan, opts: RunTestsOptions = {}): Promise<number> {
  const proc = Bun.spawn([plan.command, ...plan.args], {
    cwd: opts.cwd ?? process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: opts.inheritStdin ? "inherit" : "ignore",
  });
  return await proc.exited;
}
