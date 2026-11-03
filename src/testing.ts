/**
 * Running the project's test suite.
 *
 * Kept separate from detection so the decision ("what would we run") stays pure
 * and the effect ("run it") stays trivial.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT } from "./core/errors";
import type { TestPlan } from "./core/types";

/** A command that lives in the repository (`./gradlew`), not on PATH. */
function isRepoRelative(command: string): boolean {
  return command.startsWith("./") || command.startsWith(".\\");
}

/**
 * The path to spawn. Repo-relative commands are made absolute against the repo
 * root: PATH lookup never searches the working directory for them, and on
 * Windows a bare `gradlew.bat` is not found at all.
 */
export function resolveCommand(command: string, root: string): string {
  return isRepoRelative(command) ? resolve(root, command) : command;
}

/**
 * Is this command actually invocable?
 *
 * Checked before spawning so a project that declares pytest on a machine without
 * pytest produces a warning and a skipped step, not an ENOENT crash that blocks
 * the push.
 */
export function isRunnable(command: string, root: string = process.cwd()): boolean {
  if (isRepoRelative(command)) return existsSync(resolveCommand(command, root));
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
  const cwd = opts.cwd ?? process.cwd();
  const proc = Bun.spawn([resolveCommand(plan.command, cwd), ...plan.args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: opts.inheritStdin ? "inherit" : "ignore",
    // cmd.exe has its own quoting rules; the usual argv escaping mangles a
    // configured command's quotes. shellPlan quotes it the way cmd /s expects.
    windowsVerbatimArguments: plan.shell === true && process.platform === "win32",
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
