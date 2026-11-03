/**
 * Repository-mutating git operations.
 *
 * Each returns a result object rather than throwing, so the workflow decides how
 * a failure is reported. The rebase helper guarantees one thing above all: it
 * never leaves the repo mid-rebase.
 */

import type { GitRunner } from "./exec";
import { SYNC_NAMESPACE, operationInProgress, readChanges } from "./queries";

/** Marks a `git push` as originating from pull-pal, so our own hook stands down. */
export const INTERNAL_ENV = "PULLPAL_INTERNAL";

export interface ActionResult {
  ok: boolean;
  /** git's stderr, trimmed — used verbatim in error output. */
  message: string;
}

/**
 * Fetch `remote`'s branches into pull-pal's own namespace (see SYNC_NAMESPACE).
 *
 * `--refmap=` stops git from also updating the configured remote-tracking refs
 * as a side effect, `--prune` drops copies of branches deleted on the remote,
 * and tags are left alone — nothing outside refs/pull-pal is written.
 */
export function fetch(git: GitRunner, remote: string): ActionResult {
  const r = git.capture([
    "fetch",
    "--no-tags",
    "--prune",
    "--refmap=",
    remote,
    `+refs/heads/*:${SYNC_NAMESPACE}/${remote}/*`,
  ]);
  return { ok: r.exitCode === 0, message: r.stderr || r.stdout };
}

export type RebaseResult =
  | { ok: true }
  /**
   * `state` says where the repository was left:
   *   not-started — git refused before rewriting anything (e.g. an untracked
   *                 file in the way); the branch is exactly as it was
   *   aborted     — it started, failed, and was rolled back
   *   in-progress — it started and could not be rolled back
   */
  | { ok: false; message: string; state: "not-started" | "aborted" | "in-progress" };

/**
 * Rebase onto `onto` with --autostash.
 *
 * --autostash means a dirty working tree is stashed and reapplied rather than
 * rejected, and `git rebase --abort` restores both the original commit and the
 * stash. On any failure we abort so the user is never left mid-rebase holding a
 * conflict they did not ask for — and report what actually happened by looking
 * at the repository, not at whether `--abort` succeeded, which also fails when
 * there was never a rebase to abort.
 */
export function rebase(git: GitRunner, onto: string): RebaseResult {
  const r = git.capture(["rebase", "--autostash", onto]);
  if (r.exitCode === 0) return { ok: true };

  const message = r.stderr || r.stdout;
  if (operationInProgress(git) !== "rebase") return { ok: false, message, state: "not-started" };
  git.capture(["rebase", "--abort"]);
  const state = operationInProgress(git) === "rebase" ? "in-progress" : "aborted";
  return { ok: false, message, state };
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
  const before = readChanges(git);
  if (before === null) return { kind: "failed", message: "could not read the working tree status" };
  if (before === "") return { kind: "clean" };

  const previousTip = stashTip(git);
  const r = git.capture(["stash", "push", "--include-untracked", "--message", STASH_MESSAGE]);
  if (r.exitCode !== 0) return { kind: "failed", message: r.stderr || r.stdout };

  const tip = stashTip(git);
  if (!tip || tip === previousTip) return { kind: "not-isolated" };
  return { kind: "stashed", stash: tip, isolated: readChanges(git) === "" };
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

/**
 * Run `git push` with the user's terminal attached. The child is marked with
 * PULLPAL_INTERNAL so that if a pre-push hook is installed it recognises our own
 * push and exits immediately instead of re-running the whole workflow (the v0.1
 * double-test bug).
 */
export function push(git: GitRunner, args: string[]): number {
  return git.passthrough(["push", ...args], { env: { [INTERNAL_ENV]: "1" } });
}

/** True when this process was spawned by pull-pal's own push. */
export function isInternalInvocation(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INTERNAL_ENV] === "1";
}
