/**
 * Repository-mutating git operations.
 *
 * Each returns a result object rather than throwing, so the workflow decides how
 * a failure is reported. The rebase helper guarantees one thing above all: it
 * never leaves the repo mid-rebase.
 */

import type { GitRunner } from "./exec";

/** Marks a `git push` as originating from pull-pal, so our own hook stands down. */
export const INTERNAL_ENV = "PULLPAL_INTERNAL";

export interface ActionResult {
  ok: boolean;
  /** git's stderr, trimmed — used verbatim in error output. */
  message: string;
}

export function fetch(git: GitRunner, remote: string): ActionResult {
  const r = git.capture(["fetch", remote]);
  return { ok: r.exitCode === 0, message: r.stderr || r.stdout };
}

export interface RebaseResult extends ActionResult {
  /** True when the rebase failed and we successfully restored the pre-rebase state. */
  aborted: boolean;
}

/**
 * Rebase onto `onto` with --autostash.
 *
 * --autostash means a dirty working tree is stashed and reapplied rather than
 * rejected, and `git rebase --abort` restores both the original commit and the
 * stash. On any failure we abort so the user is never left mid-rebase holding a
 * conflict they did not ask for.
 */
export function rebase(git: GitRunner, onto: string): RebaseResult {
  const r = git.capture(["rebase", "--autostash", onto]);
  if (r.exitCode === 0) {
    return { ok: true, message: "", aborted: false };
  }
  const abort = git.capture(["rebase", "--abort"]);
  return {
    ok: false,
    message: r.stderr || r.stdout,
    aborted: abort.exitCode === 0,
  };
}

export interface PushOptions {
  /** Attach the user's terminal so they see git's progress output. */
  passthrough?: boolean;
}

/**
 * Run `git push`. The child is marked with PULLPAL_INTERNAL so that if a
 * pre-push hook is installed it recognises our own push and exits immediately
 * instead of re-running the whole workflow (the v0.1 double-test bug).
 */
export function push(git: GitRunner, args: string[], opts: PushOptions = {}): number {
  const env = { [INTERNAL_ENV]: "1" };
  if (opts.passthrough === false) {
    const r = git.capture(["push", ...args]);
    return r.exitCode;
  }
  return git.passthrough(["push", ...args], { env });
}

/** True when this process was spawned by pull-pal's own push. */
export function isInternalInvocation(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INTERNAL_ENV] === "1";
}
