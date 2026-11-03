/**
 * The decision core: pure functions from state to intent.
 *
 * Nothing here spawns a process, touches the filesystem, or prints. That is the
 * whole point — every branch below is unit-testable from plain objects, which is
 * what makes the sync/force-push matrix auditable instead of hopeful.
 */

import type {
  BaseState,
  Comparison,
  ConflictMode,
  PushPlan,
  PushScope,
  SyncDecision,
  SyncPolicy,
  SyncState,
  SyncTarget,
} from "./types";

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

/** `git push` options whose value may arrive as the *next* argument. */
const VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * Flags that push refs other than (or as well as) the current branch. `--tags`
 * belongs here: with no refspec, `git push --tags` pushes only tags.
 */
const BROAD_FLAGS = new Set([
  "--all",
  "--branches",
  "--mirror",
  "--tags",
  "--delete",
  "-d",
  "--prune",
]);

/**
 * The positional arguments of a `git push` command line: repository first, then
 * refspecs. Option values given as a separate argument (`-o ci.skip`) are not
 * positionals, and everything after `--` is.
 */
export function pushPositionals(gitArgs: string[]): string[] {
  const positionals: string[] = [];
  let afterSeparator = false;
  for (let i = 0; i < gitArgs.length; i++) {
    const arg = gitArgs[i] as string;
    if (afterSeparator) {
      positionals.push(arg);
    } else if (arg === "--") {
      afterSeparator = true;
    } else if (VALUE_FLAGS.has(arg)) {
      i++; // its value is the next argument
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  return positionals;
}

/** The value of `--repo`, given as `--repo=<x>` or `--repo <x>`. */
function repoFlag(gitArgs: string[]): string | null {
  for (let i = 0; i < gitArgs.length; i++) {
    const arg = gitArgs[i] as string;
    if (arg === "--") return null;
    if (arg === "--repo") return gitArgs[i + 1] ?? null;
    if (arg.startsWith("--repo=")) return arg.slice("--repo=".length);
  }
  return null;
}

/** The parts of `git config` that decide where a push goes. */
export interface RemotePreferences {
  /** `branch.<name>.pushRemote` */
  pushRemote?: string | null;
  /** `remote.pushDefault` */
  pushDefault?: string | null;
  /** `branch.<name>.remote` */
  upstreamRemote?: string | null;
}

/**
 * Which remote this push targets, in git's own order (defect: v0.1 hardcoded
 * "origin" everywhere): the repository argument → `--repo` →
 * `branch.<name>.pushRemote` → `remote.pushDefault` → `branch.<name>.remote` →
 * the only remote → "origin" → whatever exists.
 *
 * Getting this right matters beyond the push itself: the fetch, the comparison,
 * the divergence guard, and `--set-upstream` all follow it.
 */
export function resolveRemote(
  gitArgs: string[],
  remotes: string[],
  prefs: RemotePreferences = {},
): string {
  const [repository] = pushPositionals(gitArgs);
  const candidates = [
    repository,
    repoFlag(gitArgs),
    prefs.pushRemote,
    prefs.pushDefault,
    prefs.upstreamRemote,
  ];
  for (const candidate of candidates) {
    if (candidate && remotes.includes(candidate)) return candidate;
  }
  if (remotes.length === 1 && remotes[0]) return remotes[0];
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? "origin";
}

/** True when the user supplied any force flag themselves — we then never add ours. */
export function userPassedForce(gitArgs: string[]): boolean {
  return (
    gitArgs.some(
      (a) =>
        a === "--force" ||
        a === "-f" ||
        a === "--force-with-lease" ||
        a.startsWith("--force-with-lease=") ||
        a === "--force-if-includes" ||
        a.startsWith("--force-if-includes="),
    ) || pushPositionals(gitArgs).some((a) => a.startsWith("+"))
  );
}

/**
 * True when the user has taken responsibility for overwriting the remote branch:
 * an outright force, or a lease that names the exact value they expect it to
 * hold. A bare `--force-with-lease` is neither — it trusts a remote-tracking ref
 * the user may not have looked at — so it leaves the divergence guard on.
 */
export function userOverridesGuard(gitArgs: string[]): boolean {
  return (
    gitArgs.some((a) => a === "--force" || a === "-f" || /^--force-with-lease=[^:]*:/.test(a)) ||
    pushPositionals(gitArgs).some((a) => a.startsWith("+"))
  );
}

function shortBranch(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export interface ScopeInput {
  gitArgs: string[];
  /** The checked-out branch. */
  branch: string;
  /** The branch's upstream as a remote-tracking ref, e.g. "origin/feature". */
  upstream: string | null;
  /** The remote the push goes to — strips the upstream down to a branch name. */
  remote: string;
}

/**
 * What a direct `pull-pal [git push args]` invocation will send.
 *
 * With no refspecs, git pushes the current branch. With refspecs, each one is
 * checked: a source naming the current branch means its commit is HEAD (so the
 * tests apply); a destination naming the branch's own remote branch means the
 * sync — and the --force-with-lease a rebase adds — apply too. Anything else is
 * pushed untouched, because pull-pal cannot vouch for code it has not checked.
 */
export function scopeOfPush(input: ScopeInput): PushScope {
  const { gitArgs, branch, upstream, remote } = input;
  const broad = gitArgs.find((a) => BROAD_FLAGS.has(a));
  if (broad) {
    return { testsHead: false, syncsHead: false, description: `git push ${broad}` };
  }

  const refspecs = pushPositionals(gitArgs).slice(1);
  if (refspecs.length === 0) {
    return { testsHead: true, syncsHead: true, description: branch };
  }

  const upstreamBranch =
    upstream?.startsWith(`${remote}/`) === true ? upstream.slice(remote.length + 1) : null;
  const isHead = (src: string) => src === "HEAD" || src === "@" || shortBranch(src) === branch;

  let testsHead = true;
  let syncsHead = true;
  for (const spec of refspecs) {
    const unforced = spec.startsWith("+") ? spec.slice(1) : spec;
    const colon = unforced.indexOf(":");
    const src = colon === -1 ? unforced : unforced.slice(0, colon);
    const dst = colon === -1 ? null : shortBranch(unforced.slice(colon + 1));

    if (!isHead(src)) {
      testsHead = false;
      syncsHead = false;
      continue;
    }
    if (dst !== null && dst !== branch && dst !== upstreamBranch) syncsHead = false;
  }
  return { testsHead, syncsHead, description: refspecs.join(" ") };
}

/** One ref line from git's pre-push protocol, with its commit already resolved. */
export interface PushedRef {
  localRef: string;
  remoteRef: string;
  /** The local sha peeled to a commit (annotated tags resolve to their commit). */
  commit: string | null;
}

const isTag = (ref: string) => ref.startsWith("refs/tags/");

/**
 * What a hook-mode push sends, from the ref lines git hands the hook. Deletions
 * must already be filtered out — they carry no commit to check.
 *
 * Tags are set aside: `--follow-tags` sends them alongside the branch, and a tag
 * is a label on history, not new code to check. `destBranch` is the remote
 * branch a plain push updates, which differs from `branch` when the upstream has
 * another name.
 */
export function scopeOfRefs(
  refs: PushedRef[],
  branch: string,
  headCommit: string,
  destBranch: string = branch,
): PushScope {
  const branches = refs.filter((r) => !isTag(r.localRef) && !isTag(r.remoteRef));
  if (branches.length === 0) {
    const description = refs.map((r) => shortBranch(r.localRef)).join(" ") || "nothing";
    return { testsHead: false, syncsHead: false, description };
  }

  const description = branches.map((r) => shortBranch(r.localRef)).join(" ");
  const testsHead = branches.every((r) => r.commit === headCommit);
  const fromHead = (local: string) => local === "HEAD" || local === `refs/heads/${branch}`;
  const toOwnBranch = (remote: string) =>
    remote === `refs/heads/${branch}` || remote === `refs/heads/${destBranch}`;
  const syncsHead =
    testsHead && branches.every((r) => fromHead(r.localRef) && toOwnBranch(r.remoteRef));
  return { testsHead, syncsHead, description };
}

/**
 * Branches that are never compared with, or rebased onto, the default branch.
 * A release branch is *supposed* to lack main's newer commits; rebasing one onto
 * main rewrites a shared branch into something else entirely.
 */
export const DEFAULT_LONG_LIVED: readonly string[] = [
  "main",
  "master",
  "trunk",
  "develop",
  "development",
  "dev",
  "staging",
  "production",
  "prod",
  "release/*",
  "releases/*",
  "release-*",
  "hotfix/*",
];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function isLongLived(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(branch));
}

export interface TargetInput {
  branch: string | null;
  sync: SyncState;
  policy: SyncPolicy;
  /** false = --no-sync, or a push of something other than HEAD. */
  enabled: boolean;
  /** Why sync is disabled, when `enabled` is false. */
  disabledReason?: string;
  longLived: readonly string[];
}

/**
 * What HEAD should be compared with. The base branch is the default branch,
 * unless the branch names its own (`branch.<name>.pullpalBase`) — the escape
 * hatch for stacked PRs and branches cut from something other than main.
 */
export function chooseTarget(input: TargetInput): SyncTarget {
  const { branch, sync, policy, enabled, longLived } = input;

  if (!enabled) return { ref: null, reason: input.disabledReason ?? "sync skipped (--no-sync)" };
  if (policy === "off") return { ref: null, reason: "sync disabled (pullpal.sync=off)" };

  if (policy === "upstream") {
    return sync.upstream
      ? { ref: sync.upstream, reason: "the branch's upstream" }
      : { ref: null, reason: "branch has no upstream yet — nothing to compare with" };
  }

  if (sync.configuredBase) {
    return { ref: `${sync.remote}/${sync.configuredBase}`, reason: "configured base branch" };
  }

  if (!sync.defaultBranch) {
    // Never report "✓ up to date" when we simply could not tell (defect 21).
    return {
      ref: null,
      reason: "default branch could not be determined",
      warning: `Could not determine the default branch of "${sync.remote}" — skipping sync.`,
    };
  }

  const ref = `${sync.remote}/${sync.defaultBranch}`;
  // The default branch compared with its namesake — on its upstream, or on
  // whichever remote this push goes to — is just "am I behind".
  if (ref === sync.upstream || branch === sync.defaultBranch) {
    return { ref, reason: "default branch" };
  }

  if (branch && isLongLived(branch, longLived)) {
    return {
      ref: null,
      reason: `${branch} is a long-lived branch — not comparing it with ${ref}`,
    };
  }
  return { ref, reason: "default branch" };
}

export interface SyncInput {
  base: BaseState;
  sync: SyncState;
  target: SyncTarget;
  /** Measured against `target.ref`; null when there is no target. */
  comparison: Comparison | null;
  policy: SyncPolicy;
  /** When true, the user owns the force-push decision and we never block it. */
  forced: boolean;
  onConflict: ConflictMode;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * How to bring the branch up to date with `label` ("origin/main"). pull-pal's
 * fetch leaves the user's remote-tracking refs alone, so the advice fetches too.
 */
export function pullCommand(remote: string, label: string, mode: "rebase" | "merge"): string {
  const branch = label.startsWith(`${remote}/`) ? label.slice(remote.length + 1) : label;
  return `git pull ${mode === "rebase" ? "--rebase" : "--no-rebase"} ${remote} ${branch}`;
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, 5).join(", ");
  return files.length > 5 ? `${shown}, and ${files.length - 5} more` : shown;
}

/**
 * Decide whether to rebase, and whether the push must stop first.
 *
 * Being behind is not, by itself, a problem — CI on a pull request tests the
 * merge result anyway. What *is* a problem is a branch that no longer merges,
 * so that is what blocks. Rebasing is opt-in (`pullpal.sync=rebase`), and even
 * then only happens when it will apply cleanly.
 */
export function decideSync(input: SyncInput): SyncDecision {
  const { base, sync, target, comparison, policy, forced, onConflict } = input;

  const none = (reason: string, extra: Partial<SyncDecision> = {}): SyncDecision => ({
    action: "none",
    onto: null,
    reason,
    ...extra,
  });

  const ref = target.ref;
  if (!ref || !comparison) return none(target.reason, { warning: target.warning });

  const { behind, conflicts } = comparison;
  if (behind === null) {
    return none(`could not compare against ${ref}`, {
      warning: `Could not compare against ${ref} — skipping sync.`,
    });
  }
  if (behind === 0) return none(`up to date with ${ref}`);

  const behindText = `behind ${ref} by ${plural(behind, "commit")}`;

  if (conflicts && conflicts.length > 0) {
    const reason = `${plural(conflicts.length, "file")} conflict with ${ref}: ${listFiles(conflicts)}`;
    const rebase = pullCommand(sync.remote, ref, "rebase");
    const fix =
      ref === sync.upstream
        ? rebase
        : `${rebase}  (or, to merge: ${pullCommand(sync.remote, ref, "merge")})`;
    if (onConflict === "warn") return none(behindText, { warning: `${reason}.` });
    return none(behindText, {
      block: {
        kind: "conflicts",
        reason: `Your branch no longer merges cleanly — ${reason}.`,
        hint: `Bring it up to date and resolve them first: ${fix}`,
      },
    });
  }

  if (policy === "check") {
    if (ref === sync.upstream) {
      // Nothing of ours to push: git will just say "Everything up-to-date".
      if (sync.aheadUpstream === 0) return none(behindText);
      return none(behindText, {
        warning: `${ref} has commits you do not have — git will reject the push until you integrate them (${pullCommand(sync.remote, ref, "rebase")}).`,
      });
    }
    if (conflicts === null) {
      return none(behindText, {
        warning: `Could not check for conflicts with ${ref} (needs git 2.38 or later).`,
      });
    }
    return none(`${behindText} — merges cleanly`);
  }

  // policy rebase / upstream: bring the branch up to date.
  const result: SyncDecision = { action: "rebase", onto: ref, reason: behindText };

  // Data-loss guard.
  //
  // Scope: only the case where *we* would force-push. A rebase rewrites history,
  // so pull-pal adds --force-with-lease — and if the upstream holds commits we
  // never incorporated, that push destroys them. The lease does not save us
  // here: it is pinned to what this run just fetched, so it only catches commits
  // that land after the fetch.
  //
  // Deliberately NOT blocked: an ordinary push while merely behind. Git rejects
  // that itself, clearly and safely; duplicating the check would only make
  // pull-pal obstructive where plain git is already correct.
  const rebasingOntoUpstream = ref === sync.upstream;
  const behindUpstream = sync.behindUpstream ?? 0;
  if (!forced && !rebasingOntoUpstream && behindUpstream > 0 && sync.upstream) {
    result.block = {
      kind: "diverged",
      reason: `${sync.upstream} has ${plural(behindUpstream, "commit")} you do not have — the force-push after rebasing would destroy them.`,
      hint: `Integrate them first (${pullCommand(sync.remote, sync.upstream, "rebase")}), or re-run with --force if you are certain you want to replace the remote branch.`,
    };
  }

  // A dirty tree is not fatal — rebase --autostash handles it — but say so.
  if (base.dirty) {
    result.warning = "Working tree has changes — they will be stashed and restored.";
  }

  return result;
}

export interface PushPlanInput {
  gitArgs: string[];
  didRebase: boolean;
  /**
   * What the lease pins after a rebase: the remote branch the push updates, and
   * the commit pull-pal last saw there (null = it did not exist).
   */
  lease?: { branch: string; expect: string | null } | null;
  /**
   * Set when the branch has no upstream yet and the user passed no refspec —
   * we publish it with -u so a first push works like every other push.
   */
  setUpstream: { remote: string; branch: string } | null;
}

/**
 * Build the final `git push` argv.
 *
 * A rebase rewrites history, so the push needs force — but never bare `--force`.
 * The lease names the exact commit pull-pal fetched and checked, so the push is
 * rejected if anyone landed a commit between that fetch and now. (A bare lease
 * would compare against `refs/remotes/*`, which pull-pal deliberately does not
 * update — see SYNC_NAMESPACE.)
 *
 * The other half of that safety story lives in `decideSync`: the lease cannot
 * protect commits we fetched but did not incorporate, so those are blocked
 * outright before we ever get here.
 */
export function planPush(input: PushPlanInput): PushPlan {
  const { gitArgs, didRebase, setUpstream, lease } = input;

  let args = gitArgs;
  if (setUpstream && pushPositionals(gitArgs).length === 0) {
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
  const flag = lease
    ? `--force-with-lease=refs/heads/${lease.branch}:${lease.expect ?? ""}`
    : "--force-with-lease";
  return { args: [flag, ...args], forceLeaseAdded: true };
}
