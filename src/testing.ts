/**
 * Running the project's test suite.
 *
 * Kept separate from detection so the decision ("what would we run") stays pure
 * and the effect ("run it") stays trivial.
 */

import { EXIT } from "./core/errors";
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

/**
 * Run the suite and resolve to its exit code.
 *
 * While it runs, pull-pal must survive Ctrl+C: the user's uncommitted changes
 * are stashed for the duration, and only this process can put them back. So the
 * signal is passed on to the suite instead of ending us, and the caller's
 * restore runs once the suite has exited.
 */
export async function runTests(plan: TestPlan, opts: RunTestsOptions = {}): Promise<number> {
  const proc = Bun.spawn([plan.command, ...plan.args], {
    cwd: opts.cwd ?? process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: opts.inheritStdin ? "inherit" : "ignore",
  });

  let interrupted = false;
  const forward = (signal: NodeJS.Signals) => () => {
    interrupted = true;
    try {
      proc.kill(signal);
    } catch {
      // Already gone.
    }
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const code = await proc.exited;
    return interrupted ? EXIT.interrupted : code;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
