/**
 * Reading repository state. Every function is total: git failures become null /
 * false rather than exceptions, and the decision core decides what that means.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BaseState, OperationInProgress, SyncState } from "../core/types";
import type { GitRunner } from "./exec";

function ok(git: GitRunner, args: string[]): boolean {
  return git.capture(args).exitCode === 0;
}

function out(git: GitRunner, args: string[]): string | null {
  const r = git.capture(args);
  return r.exitCode === 0 && r.stdout ? r.stdout : null;
}

/**
 * Resolve a git-internal path (honors worktrees, submodules, core.hooksPath).
 *
 * `rev-parse --git-path` answers relative to the repository, not to our process,
 * so the result must be re-anchored to the runner's cwd before it can be handed
 * to the filesystem.
 */
export function gitPath(git: GitRunner, name: string): string | null {
  const p = out(git, ["rev-parse", "--git-path", name]);
  if (p === null) return null;
  return isAbsolute(p) ? p : resolve(git.cwd, p);
}

function detectOperation(git: GitRunner): OperationInProgress | null {
  const checks: Array<[string, OperationInProgress]> = [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["BISECT_LOG", "bisect"],
  ];
  for (const [name, op] of checks) {
    const p = gitPath(git, name);
    if (p && existsSync(p)) return op;
  }
  return null;
}

export function readBaseState(git: GitRunner): BaseState {
  const isRepo = ok(git, ["rev-parse", "--git-dir"]);
  if (!isRepo) {
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

  // An unborn HEAD (no commits yet) still resolves symbolic-ref, so check first.
  const unborn = !ok(git, ["rev-parse", "--verify", "HEAD"]);
  const branchRef = out(git, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  const detached = !unborn && branchRef === null;

  const remotesRaw = out(git, ["remote"]);
  const remotes = remotesRaw ? remotesRaw.split(/\r?\n/).filter(Boolean) : [];

  // Untracked files do not block a rebase, so they must not count as dirty.
  const status = git.capture(["status", "--porcelain", "--untracked-files=no"]);
  const dirty = status.exitCode === 0 && status.stdout.length > 0;

  return {
    isRepo: true,
    root: out(git, ["rev-parse", "--show-toplevel"]),
    detached,
    branch: branchRef,
    unborn,
    remotes,
    dirty,
    operationInProgress: detectOperation(git),
  };
}

/** Full upstream ref of `branch` (e.g. "origin/feature"), or null when unset. */
export function readUpstream(git: GitRunner): string | null {
  return out(git, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
}

/** The remote half of the branch's upstream (e.g. "origin"), or null. */
export function readUpstreamRemote(git: GitRunner, branch: string | null): string | null {
  if (!branch) return null;
  return out(git, ["config", "--get", `branch.${branch}.remote`]);
}

/** Resolve any ref to a sha, or null if it does not exist. */
export function revParse(git: GitRunner, ref: string): string | null {
  return out(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/**
 * Default branch of `remote`.
 *
 * Prefers the local origin/HEAD symref (free). Falls back to one ls-remote and
 * then *persists* the answer with `remote set-head`, so the network round-trip
 * happens at most once per clone instead of on every push (defect: v0.1 ran
 * `git remote show` — a network call — on every invocation).
 */
export function resolveDefaultBranch(git: GitRunner, remote: string): string | null {
  const prefix = `refs/remotes/${remote}/`;
  const symref = out(git, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (symref?.startsWith(prefix)) {
    return symref.slice(prefix.length);
  }

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

/** Ahead/behind counts vs the upstream, as [ahead, behind]. */
function aheadBehind(git: GitRunner, upstream: string): [number | null, number | null] {
  const r = git.capture(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  if (r.exitCode !== 0) return [null, null];
  const parts = r.stdout.split(/\s+/);
  const ahead = Number.parseInt(parts[0] ?? "", 10);
  const behind = Number.parseInt(parts[1] ?? "", 10);
  return [Number.isFinite(ahead) ? ahead : null, Number.isFinite(behind) ? behind : null];
}

export function readSyncState(git: GitRunner, remote: string): SyncState {
  const upstream = readUpstream(git);
  const defaultBranch = resolveDefaultBranch(git, remote);

  let behindDefault: number | null = null;
  if (defaultBranch) {
    const ref = `${remote}/${defaultBranch}`;
    // Only meaningful if we actually have that remote-tracking ref locally.
    behindDefault = revParse(git, ref) ? countRevs(git, `HEAD..${ref}`) : null;
  }

  const [aheadUpstream, behindUpstream] = upstream ? aheadBehind(git, upstream) : [null, null];

  return {
    remote,
    defaultBranch,
    behindDefault,
    upstream,
    aheadUpstream,
    behindUpstream,
  };
}
