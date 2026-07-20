/**
 * The data the decision core reasons about.
 *
 * State is gathered in two phases because the interesting comparisons only
 * become true after a fetch:
 *   BaseState  — cheap, local, read before any network access (drives preflight)
 *   SyncState  — ahead/behind facts, read after fetch (drives the sync decision)
 *
 * Everything here is plain data so `core/plan.ts` can stay a pure function of it.
 */

export type OperationInProgress = "rebase" | "merge" | "cherry-pick" | "bisect";

export interface BaseState {
  isRepo: boolean;
  /** Repo root, or null when not in a repo. */
  root: string | null;
  /** True when HEAD is not on a branch. */
  detached: boolean;
  /** Current branch, or null when detached / unborn. */
  branch: string | null;
  /** True before the first commit exists. */
  unborn: boolean;
  remotes: string[];
  /**
   * Tracked-file modifications only. Untracked files do NOT block a rebase, so
   * they must not count as dirty — that distinction is what made v0.1 give the
   * wrong advice on a dirty tree.
   */
  dirty: boolean;
  operationInProgress: OperationInProgress | null;
}

export interface SyncState {
  /** The remote this push targets. */
  remote: string;
  /** Default branch of `remote` (e.g. "main"), or null if undeterminable. */
  defaultBranch: string | null;
  /** Commits on <remote>/<defaultBranch> not in HEAD. null = not computable. */
  behindDefault: number | null;
  /** Full upstream ref of the current branch (e.g. "origin/feature"), if set. */
  upstream: string | null;
  /** Commits on HEAD not on upstream. null = no upstream / not computable. */
  aheadUpstream: number | null;
  /** Commits on upstream not in HEAD. null = no upstream / not computable. */
  behindUpstream: number | null;
}

/** What the sync step should do. Produced purely; executed by the workflow. */
export interface SyncDecision {
  action: "none" | "rebase";
  /** Ref to rebase onto, e.g. "origin/main". Set when action === "rebase". */
  onto: string | null;
  /** Human-readable explanation — surfaced by --dry-run and doctor. */
  reason: string;
  /** Non-fatal problem worth showing (e.g. default branch undeterminable). */
  warning?: string;
  /** When set, the push must stop before doing anything destructive. */
  block?: { reason: string; hint: string };
}

export interface PushPlan {
  args: string[];
  /** True when pull-pal added --force-with-lease itself. */
  forceLeaseAdded: boolean;
}

export type SyncPolicy = "default" | "upstream" | "off";

/** A resolved test command, produced by the detection engine. */
export interface TestPlan {
  command: string;
  args: string[];
  /** What we show the user, e.g. "bun run test". */
  label: string;
  /** Which detector produced this — surfaced by --dry-run and doctor. */
  source: string;
  /**
   * Run through the platform shell. Only set for user-configured commands, which
   * are free-form strings ("make check && ./verify.sh") rather than argv.
   */
  shell?: boolean;
}

/** Resolved run options — flags merged over config merged over defaults. */
export interface RunOptions {
  /** false = --no-sync: skip fetch AND rebase (v0.1 skipped only the rebase). */
  sync: boolean;
  tests: boolean;
  dryRun: boolean;
  hookMode: boolean;
  syncPolicy: SyncPolicy;
  /** Args forwarded verbatim to `git push`. */
  gitArgs: string[];
}
