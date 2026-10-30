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

/** Identifies our stash entry, so the user can find it if a restore ever fails. */
export const STASH_MESSAGE = "pull-pal: uncommitted changes set aside while tests ran";

export type SetAside =
  /** Nothing uncommitted — the working tree already is HEAD. */
  | { kind: "clean" }
  /** Stashed. `isolated` is false when something could not be stashed (submodules). */
  | { kind: "stashed"; stash: string; isolated: boolean }
  /** Changes exist but none could be stashed; tests would see them. */
  | { kind: "not-isolated" }
  | { kind: "failed"; message: string };

function porcelain(git: GitRunner): string | null {
  const r = git.capture(["status", "--porcelain"]);
  return r.exitCode === 0 ? r.stdout : null;
}

function stashTip(git: GitRunner): string | null {
  const r = git.capture(["rev-parse", "--verify", "--quiet", "refs/stash"]);
  return r.exitCode === 0 && r.stdout ? r.stdout : null;
}

/**
 * Stash uncommitted *and untracked* changes so the tests run against exactly the
 * commit being pushed. A file you forgot to `git add` is the classic way for
 * tests to pass locally and fail everywhere else; this is what catches it.
 *
 * Ignored files stay put — build output and node_modules are environment, not
 * code, and removing them would make every test run a cold one.
 */
export function setAsideChanges(git: GitRunner): SetAside {
  const before = porcelain(git);
  if (before === null) return { kind: "failed", message: "could not read the working tree status" };
  if (before === "") return { kind: "clean" };

  const previousTip = stashTip(git);
  const r = git.capture(["stash", "push", "--include-untracked", "--message", STASH_MESSAGE]);
  if (r.exitCode !== 0) return { kind: "failed", message: r.stderr || r.stdout };

  const tip = stashTip(git);
  if (!tip || tip === previousTip) return { kind: "not-isolated" };
  return { kind: "stashed", stash: tip, isolated: porcelain(git) === "" };
}

/**
 * Put stashed changes back. Pops by position, after locating *our* entry by its
 * sha, so a stash the tests themselves created is never the one restored.
 * Git refuses rather than overwrites when something is in the way, so a failure
 * here never loses work — the entry simply stays in the stash.
 */
export function restoreChanges(git: GitRunner, stash: string): ActionResult {
  const list = git.capture(["stash", "list", "--format=%H"]);
  const index = list.stdout.split(/\r?\n/).indexOf(stash);
  if (index === -1) return { ok: false, message: "the stash entry is no longer in the stash list" };

  const entry = `stash@{${index}}`;
  const withIndex = git.capture(["stash", "pop", "--index", entry]);
  if (withIndex.exitCode === 0) return { ok: true, message: "" };
  // --index also restores what was staged; if that cannot apply, the content
  // matters more than the staging.
  const plain = git.capture(["stash", "pop", entry]);
  return { ok: plain.exitCode === 0, message: plain.stderr || plain.stdout };
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
