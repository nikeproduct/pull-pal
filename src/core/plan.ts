/**
 * The decision core: pure functions from state to intent.
 *
 * Nothing here spawns a process, touches the filesystem, or prints. That is the
 * whole point — every branch below is unit-testable from plain objects, which is
 * what makes the sync/force-push matrix auditable instead of hopeful.
 */

import type { BaseState, PushPlan, SyncDecision, SyncState } from "./types";

export interface PreflightFailure {
  reason: string;
  hint?: string;
}

/**
 * Conditions under which we refuse to do anything at all, checked *before* any
 * network access. Returns null when the repo is workable.
 */
export function preflight(state: BaseState): PreflightFailure | null {
  if (!state.isRepo) {
    return {
      reason: "Not inside a git repository.",
      hint: "Run pull-pal from within a git repository.",
    };
  }
  if (state.unborn) {
    return {
      reason: "This repository has no commits yet.",
      hint: "Make your first commit, then push.",
    };
  }
  if (state.operationInProgress) {
    const op = state.operationInProgress;
    return {
      reason: `A ${op} is already in progress.`,
      hint: `Finish it (git ${op} --continue) or abort it (git ${op} --abort), then re-run pull-pal.`,
    };
  }
  if (state.detached) {
    return {
      reason: "HEAD is detached — pull-pal needs a branch to sync and push.",
      hint: "Check out a branch first: git checkout -b <name>",
    };
  }
  if (state.remotes.length === 0) {
    return {
      reason: "This repository has no remotes — there is nothing to push to.",
      hint: "Add one: git remote add origin <url>",
    };
  }
  return null;
}

/**
 * Which remote this push targets (defect: v0.1 hardcoded "origin" everywhere).
 * Priority: explicit positional arg → the branch's upstream remote → the only
 * remote → "origin" → whatever exists.
 */
export function resolveRemote(
  gitArgs: string[],
  remotes: string[],
  upstreamRemote: string | null,
): string {
  for (const arg of gitArgs) {
    if (arg.startsWith("-")) continue;
    if (remotes.includes(arg)) return arg;
  }
  if (upstreamRemote && remotes.includes(upstreamRemote)) return upstreamRemote;
  if (remotes.length === 1 && remotes[0]) return remotes[0];
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? "origin";
}

/** True when the user supplied any force flag themselves — we then never add ours. */
export function userPassedForce(gitArgs: string[]): boolean {
  return gitArgs.some(
    (a) =>
      a === "--force" ||
      a === "-f" ||
      a === "--force-with-lease" ||
      a.startsWith("--force-with-lease=") ||
      a === "--force-if-includes" ||
      a.startsWith("--force-if-includes="),
  );
}

export interface SyncInput {
  base: BaseState;
  sync: SyncState;
  /** Resolved policy; "off" and `enabled: false` both mean "do not rebase". */
  policy: "default" | "upstream" | "off";
  /** false = --no-sync (skips fetch too, handled by the workflow). */
  enabled: boolean;
  /** When true, the user owns the safety decision and we never block. */
  forced: boolean;
}

/**
 * Decide whether to rebase, onto what, and whether the push must stop first.
 *
 * The block case is the one v0.1 never checked: if the branch's own upstream
 * holds commits we do not have, a post-rebase force-push silently destroys them.
 * `--force-with-lease` does NOT save you here — pull-pal always fetches first,
 * which refreshes the very ref the lease compares against.
 */
export function decideSync(input: SyncInput): SyncDecision {
  const { base, sync, policy, enabled, forced } = input;

  const none = (reason: string, extra: Partial<SyncDecision> = {}): SyncDecision => ({
    action: "none",
    onto: null,
    reason,
    ...extra,
  });

  // Work out the intended rebase target and how far behind it we are.
  let target: string | null = null;
  let behind: number | null = null;
  let decision: SyncDecision | null = null;

  if (!enabled) {
    decision = none("sync skipped (--no-sync)");
  } else if (policy === "off") {
    decision = none("sync disabled (pullpal.sync=off)");
  } else if (policy === "upstream") {
    if (!sync.upstream) {
      decision = none("branch has no upstream yet — nothing to rebase onto");
    } else {
      target = sync.upstream;
      behind = sync.behindUpstream;
    }
  } else {
    if (!sync.defaultBranch) {
      // Never report "✓ up to date" when we simply could not tell (defect 21).
      decision = none("default branch could not be determined", {
        warning: `Could not determine the default branch of "${sync.remote}" — skipping sync.`,
      });
    } else {
      target = `${sync.remote}/${sync.defaultBranch}`;
      behind = sync.behindDefault;
    }
  }

  if (!decision && target !== null) {
    if (behind === null) {
      decision = none(`could not compare against ${target}`, {
        warning: `Could not compare against ${target} — skipping sync.`,
      });
    } else if (behind === 0) {
      decision = none(`up to date with ${target}`);
    } else {
      decision = {
        action: "rebase",
        onto: target,
        reason: `behind ${target} by ${behind} commit${behind === 1 ? "" : "s"}`,
      };
    }
  }

  const result = decision ?? none("nothing to do");

  // Data-loss guard.
  //
  // Scope: only the case where *we* would force-push. A rebase rewrites history,
  // so pull-pal adds --force-with-lease — and if the upstream holds commits we
  // never saw, that push destroys them. The lease does not save us here, because
  // this run just fetched and refreshed the very ref the lease compares against.
  //
  // Deliberately NOT blocked: an ordinary push while merely behind. Git rejects
  // that itself, clearly and safely; duplicating the check would only make
  // pull-pal obstructive where plain git is already correct.
  const rebasingOntoUpstream = result.action === "rebase" && result.onto === sync.upstream;
  const behindUpstream = sync.behindUpstream ?? 0;
  const wouldForcePush = result.action === "rebase" && !rebasingOntoUpstream;
  if (!forced && wouldForcePush && behindUpstream > 0 && sync.upstream) {
    const plural = behindUpstream === 1 ? "" : "s";
    result.block = {
      reason: `${sync.upstream} has ${behindUpstream} commit${plural} you do not have — the force-push after rebasing would destroy them.`,
      hint: "Integrate them first (git pull --rebase), or re-run with --force-with-lease if you are certain you want to replace the remote branch.",
    };
  }

  // A dirty tree is not fatal — rebase --autostash handles it — but say so.
  if (result.action === "rebase" && base.dirty) {
    result.warning = "Working tree has changes — they will be stashed and restored.";
  }

  return result;
}

export interface PushPlanInput {
  gitArgs: string[];
  didRebase: boolean;
  /**
   * Set when the branch has no upstream yet and the user passed no refspec —
   * we publish it with -u so a first push works like every other push.
   */
  setUpstream: { remote: string; branch: string } | null;
}

/** True when the user already named a remote/refspec themselves. */
function hasPositional(gitArgs: string[]): boolean {
  return gitArgs.some((a) => !a.startsWith("-"));
}

/**
 * Build the final `git push` argv.
 *
 * A rebase rewrites history, so the push needs force — but never bare `--force`.
 * `--force-with-lease` compares the remote against our remote-tracking ref, which
 * rejects the push if anyone landed a commit between our fetch and now.
 *
 * The other half of that safety story lives in `decideSync`: the lease cannot
 * protect commits we fetched but did not incorporate, so those are blocked
 * outright before we ever get here.
 */
export function planPush(input: PushPlanInput): PushPlan {
  const { gitArgs, didRebase, setUpstream } = input;

  let args = gitArgs;
  if (setUpstream && !hasPositional(gitArgs)) {
    // Options must precede `--`; anything after it is a refspec to git.
    const extra = ["--set-upstream", setUpstream.remote, setUpstream.branch];
    const separator = args.indexOf("--");
    args =
      separator === -1
        ? [...args, ...extra]
        : [...args.slice(0, separator), ...extra, ...args.slice(separator)];
  }

  if (!didRebase || userPassedForce(gitArgs)) {
    return { args, forceLeaseAdded: false };
  }
  return { args: ["--force-with-lease", ...args], forceLeaseAdded: true };
}
