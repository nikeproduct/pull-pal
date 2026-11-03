/**
 * Reading repository state. Every function is total: git failures become null /
 * false rather than exceptions, and the decision core decides what that means.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BaseState, Comparison, OperationInProgress, SyncState } from "../core/types";
import type { GitRunner } from "./exec";

function ok(git: GitRunner, args: string[]): boolean {
  return git.capture(args).exitCode === 0;
}

function out(git: GitRunner, args: string[]): string | null {
  const r = git.capture(args);
  return r.exitCode === 0 && r.stdout ? r.stdout : null;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ── Configuration ──────────────────────────────────────────────────────────

/** A snapshot of `git config`, read in one process instead of one per key. */
export interface GitConfig {
  /** The effective (last) value of `key`, or null when unset. */
  get(key: string): string | null;
  /** Every value of a multi-valued `key`, in order. */
  getAll(key: string): string[];
}

/**
 * Section and variable names are case-insensitive; the subsection in between
 * (a branch or remote name) is not. `git config --list` prints them that way.
 */
function normalizeKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1) return key.toLowerCase();
  if (first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

export function configFromEntries(entries: Array<[string, string]>): GitConfig {
  const map = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const k = normalizeKey(key);
    map.set(k, [...(map.get(k) ?? []), value]);
  }
  return {
    get: (key) => map.get(normalizeKey(key))?.at(-1) ?? null,
    getAll: (key) => map.get(normalizeKey(key)) ?? [],
  };
}

export function readGitConfig(git: GitRunner): GitConfig {
  const r = git.capture(["config", "--list", "-z"]);
  if (r.exitCode !== 0) return configFromEntries([]);
  const entries: Array<[string, string]> = r.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const newline = entry.indexOf("\n");
      // A bare `key` with no `=` is boolean true.
      return newline === -1 ? [entry, "true"] : [entry.slice(0, newline), entry.slice(newline + 1)];
    });
  return configFromEntries(entries);
}

/** The branch's configured upstream remote (`branch.<name>.remote`). */
export function upstreamRemoteOf(config: GitConfig, branch: string): string | null {
  const remote = config.get(`branch.${branch}.remote`);
  return remote && remote !== "." ? remote : null;
}

/** True when the branch has an upstream configured at all. */
export function hasUpstream(config: GitConfig, branch: string): boolean {
  return config.get(`branch.${branch}.merge`) !== null;
}

/**
 * The branch name a plain `git push` from `branch` updates on `remote`: the
 * upstream branch when the upstream lives on that remote, otherwise a branch of
 * the same name (what every `push.default` except `upstream` does).
 */
export function pushDestination(config: GitConfig, remote: string, branch: string): string {
  const merge = config.get(`branch.${branch}.merge`);
  if (upstreamRemoteOf(config, branch) === remote && merge?.startsWith("refs/heads/")) {
    return merge.slice("refs/heads/".length);
  }
  return branch;
}

/** The base branch a branch declares for itself (`branch.<name>.pullpalBase`). */
export function readConfiguredBase(config: GitConfig, branch: string | null): string | null {
  if (!branch) return null;
  const value = config.get(`branch.${branch}.pullpalBase`);
  if (!value) return null;
  return value.replace(/^refs\/heads\//, "");
}

// ── Repository state ───────────────────────────────────────────────────────

/** Re-anchor a `--git-path` answer, which is relative to the repo, not to us. */
function anchor(git: GitRunner, p: string): string {
  return isAbsolute(p) ? p : resolve(git.cwd, p);
}

/**
 * Resolve git-internal paths (honors worktrees, submodules, core.hooksPath), in
 * one process however many are asked for.
 */
export function gitPaths(git: GitRunner, names: string[]): Array<string | null> {
  const r = git.capture(["rev-parse", ...names.flatMap((n) => ["--git-path", n])]);
  if (r.exitCode !== 0) return names.map(() => null);
  const paths = lines(r.stdout);
  return names.map((_, i) => (paths[i] ? anchor(git, paths[i]) : null));
}

export function gitPath(git: GitRunner, name: string): string | null {
  return gitPaths(git, [name])[0] ?? null;
}

const OPERATION_MARKERS: Array<[string, OperationInProgress]> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

function operationFromPaths(paths: Array<string | null>): OperationInProgress | null {
  for (const [i, [, op]] of OPERATION_MARKERS.entries()) {
    const p = paths[i];
    if (p && existsSync(p)) return op;
  }
  return null;
}

/** The multi-step operation the repository is in the middle of, if any. */
export function operationInProgress(git: GitRunner): OperationInProgress | null {
  return operationFromPaths(
    gitPaths(
      git,
      OPERATION_MARKERS.map(([name]) => name),
    ),
  );
}

export function readBaseState(git: GitRunner): BaseState {
  // One process answers "is this a repo", where its root is, and every marker
  // of an operation in progress.
  const markers = OPERATION_MARKERS.map(([name]) => name);
  const r = git.capture([
    "rev-parse",
    "--show-toplevel",
    ...markers.flatMap((n) => ["--git-path", n]),
  ]);
  if (r.exitCode !== 0) {
    return {
      isRepo: false,
      root: null,
      detached: false,
      branch: null,
      unborn: false,
      remotes: [],
      dirty: false,
      operationInProgress: null,
    };
  }
  const [root = "", ...markerPaths] = lines(r.stdout);

  // An unborn HEAD (no commits yet) still resolves symbolic-ref, so check first.
  const unborn = !ok(git, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const branchRef = out(git, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  const detached = !unborn && branchRef === null;

  const remotesRaw = out(git, ["remote"]);
  const remotes = remotesRaw ? lines(remotesRaw).filter(Boolean) : [];

  // Untracked files do not block a rebase, so they must not count as dirty.
  const status = git.capture(["status", "--porcelain", "--untracked-files=no"]);
  const dirty = status.exitCode === 0 && status.stdout.length > 0;

  return {
    isRepo: true,
    root: root || null,
    detached,
    branch: branchRef,
    unborn,
    remotes,
    dirty,
    operationInProgress: operationFromPaths(markerPaths.map((p) => (p ? anchor(git, p) : null))),
  };
}

/**
 * Every uncommitted change, untracked files included, whatever
 * `status.showUntrackedFiles` says — a file the user never added is exactly what
 * the test isolation exists to catch. null when status cannot be read.
 */
export function readChanges(git: GitRunner): string | null {
  const r = git.capture(["status", "--porcelain", "--untracked-files=all"]);
  return r.exitCode === 0 ? r.stdout : null;
}

/** Full upstream ref of the current branch (e.g. "origin/feature"), or null when unset. */
export function readUpstream(git: GitRunner): string | null {
  return out(git, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
}

/** Resolve any ref or object to the commit it points at, or null if there is none. */
export function revParse(git: GitRunner, ref: string): string | null {
  return out(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/** Tree id of HEAD — the identity of exactly what the tests run against. */
export function readHeadTree(git: GitRunner): string | null {
  return out(git, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
}

// ── The remote, as pull-pal sees it ────────────────────────────────────────

/**
 * pull-pal fetches into its own namespace and never touches `refs/remotes/*`.
 *
 * Those refs are what a bare `--force-with-lease` compares against. A fetch that
 * moves them makes the lease agree with whatever is on the remote now, so the
 * user's own lease — on a pull-pal push, or a `git push` the hook runs inside —
 * would silently stop protecting anything.
 */
export const SYNC_NAMESPACE = "refs/pull-pal";

/** Where pull-pal keeps its copy of `<remote>/<branch>`. */
export function syncRef(remote: string, branch: string): string {
  return `${SYNC_NAMESPACE}/${remote}/${branch}`;
}

/** Map a display label like "origin/main" to pull-pal's copy of that branch. */
export function syncRefForLabel(remote: string, label: string): string {
  const prefix = `${remote}/`;
  return label.startsWith(prefix) ? syncRef(remote, label.slice(prefix.length)) : label;
}

export interface DefaultBranchOptions {
  /** Never touch the network or write refs (doctor, --no-sync). */
  offline?: boolean;
}

/**
 * Default branch of `remote`.
 *
 * Prefers the local origin/HEAD symref (free). Falls back to one ls-remote and
 * then *persists* the answer with `remote set-head`, so the network round-trip
 * happens at most once per clone instead of on every push (defect: v0.1 ran
 * `git remote show` — a network call — on every invocation).
 */
export function resolveDefaultBranch(
  git: GitRunner,
  remote: string,
  opts: DefaultBranchOptions = {},
): string | null {
  const prefix = `refs/remotes/${remote}/`;
  const symref = out(git, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (symref?.startsWith(prefix)) {
    return symref.slice(prefix.length);
  }
  if (opts.offline) return null;

  const ls = git.capture(["ls-remote", "--symref", remote, "HEAD"]);
  if (ls.exitCode === 0) {
    const match = ls.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
    if (match?.[1]) {
      const branch = match[1];
      // Best-effort cache; failure here only costs us the fast path next time.
      git.capture(["remote", "set-head", remote, branch]);
      return branch;
    }
  }

  return null;
}

function countRevs(git: GitRunner, range: string): number | null {
  const r = git.capture(["rev-list", "--count", range]);
  if (r.exitCode !== 0) return null;
  const n = Number.parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : null;
}

/** Ahead/behind counts vs `ref`, as [ahead, behind]. */
function aheadBehind(git: GitRunner, ref: string): [number | null, number | null] {
  const r = git.capture(["rev-list", "--left-right", "--count", `HEAD...${ref}`]);
  if (r.exitCode !== 0) return [null, null];
  const parts = r.stdout.split(/\s+/);
  const ahead = Number.parseInt(parts[0] ?? "", 10);
  const behind = Number.parseInt(parts[1] ?? "", 10);
  return [Number.isFinite(ahead) ? ahead : null, Number.isFinite(behind) ? behind : null];
}

/**
 * Sync state after `fetch` has refreshed pull-pal's copy of `remote`.
 *
 * "Upstream" here is the remote branch this push will update, which is what the
 * divergence guard and the lease must protect — in a fork workflow that is the
 * branch on the push remote, not the one `@{upstream}` names.
 */
export function readSyncState(
  git: GitRunner,
  config: GitConfig,
  remote: string,
  branch: string,
): SyncState {
  const dest = pushDestination(config, remote, branch);
  const destRef = syncRef(remote, dest);
  const exists = revParse(git, destRef) !== null;
  const [aheadUpstream, behindUpstream] = exists ? aheadBehind(git, destRef) : [null, null];

  return {
    remote,
    defaultBranch: resolveDefaultBranch(git, remote),
    configuredBase: readConfiguredBase(config, branch),
    upstream: exists ? `${remote}/${dest}` : null,
    aheadUpstream,
    behindUpstream,
  };
}

/** Sync state for a run that does not sync: nothing is fetched or compared. */
export function readOfflineSyncState(remote: string): SyncState {
  return {
    remote,
    defaultBranch: null,
    configuredBase: null,
    upstream: null,
    aheadUpstream: null,
    behindUpstream: null,
  };
}

/**
 * Paths that would conflict if HEAD were merged with `target`, computed entirely
 * in memory by `git merge-tree --write-tree` — no checkout, no index, nothing
 * for the user to clean up. Returns [] for a clean merge and null when the check
 * cannot run: git older than 2.38, unrelated histories, or an unknown ref.
 */
export function mergeConflicts(git: GitRunner, target: string): string[] | null {
  const r = git.capture([
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "HEAD",
    target,
  ]);
  const [tree = "", ...paths] = lines(r.stdout);
  // Exit 1 also covers "not something we can merge"; only a tree id on the first
  // line means git actually performed the merge.
  if (!/^[0-9a-f]{40,64}$/.test(tree.trim())) return null;
  if (r.exitCode === 0) return [];
  if (r.exitCode !== 1) return null;
  return [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
}

/** Measure HEAD against the sync target: how far behind, and whether it merges. */
export function compareWith(git: GitRunner, target: string): Comparison {
  if (!revParse(git, target)) return { behind: null, conflicts: null };
  const behind = countRevs(git, `HEAD..${target}`);
  if (behind === null) return { behind: null, conflicts: null };
  if (behind === 0) return { behind, conflicts: [] };
  return { behind, conflicts: mergeConflicts(git, target) };
}
