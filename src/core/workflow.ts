/**
 * The push pipeline: preflight → fetch → sync → test → push.
 *
 * Every effect arrives through `WorkflowDeps`, so this orchestration is driven
 * in tests by a real git repo with stubbed test-running, or entirely by fakes.
 * Decisions themselves live in `core/plan.ts` — this module only sequences them.
 */

import * as actions from "../git/actions";
import type { GitRunner } from "../git/exec";
import * as queries from "../git/queries";
import type { TestCache } from "../test-cache";
import { EXIT, UserFacingError } from "./errors";
import {
  type RemotePreferences,
  chooseTarget,
  decideSync,
  planPush,
  preflight,
  pullCommand,
  resolveRemote,
  scopeOfPush,
  userOverridesGuard,
} from "./plan";
import { reportTestStep, runTestStep } from "./test-step";
import type {
  BaseState,
  ConflictMode,
  RunOptions,
  SyncDecision,
  SyncPolicy,
  SyncState,
  SyncTarget,
  TestPlan,
} from "./types";

/** Output port — the terminal implementation lives in cli/ui.ts. */
export interface Reporter {
  step(msg: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  fail(msg: string): void;
  info(msg: string): void;
  /** Secondary/dimmed line, e.g. a hint under an error. */
  detail(msg: string): void;
}

export type { TestPlan } from "./types";

export interface WorkflowDeps {
  git: GitRunner;
  ui: Reporter;
  /** Detect the project's test command, or null when there is none. */
  detectTests(): TestPlan | null;
  /** Is this command actually present (on PATH, or in the repo for `./x`)? */
  isRunnable(command: string): boolean;
  /** Run the suite with the user's terminal attached; resolves to its exit code. */
  runTests(plan: TestPlan): Promise<number>;
  /** Trees that already passed, so an unchanged commit is not re-tested. */
  testCache: TestCache;
}

export interface WorkflowOutcome {
  exitCode: number;
  rebased: boolean;
  pushed: boolean;
  testsPassed: boolean | null;
  /** The detector that found the suite — never the command (it can hold secrets). */
  testRunner: string | null;
  /** Set when a gate stopped the run; the string is the machine-readable reason. */
  blocked: string | null;
}

export function outcome(partial: Partial<WorkflowOutcome> = {}): WorkflowOutcome {
  return {
    exitCode: EXIT.ok,
    rebased: false,
    pushed: false,
    testsPassed: null,
    testRunner: null,
    blocked: null,
    ...partial,
  };
}

/** Preflight, throwing a UserFacingError the entry point can print cleanly. */
function assertWorkable(deps: WorkflowDeps) {
  const base = queries.readBaseState(deps.git);
  const failure = preflight(base);
  if (failure) {
    throw new UserFacingError(failure.reason, {
      hint: failure.hint,
      exitCode: EXIT.preflight,
    });
  }
  return base;
}

/** The git config that decides where a push from `branch` goes. */
export function remotePreferences(config: queries.GitConfig, branch: string): RemotePreferences {
  return {
    pushRemote: config.get(`branch.${branch}.pushRemote`),
    pushDefault: config.get("remote.pushDefault"),
    upstreamRemote: queries.upstreamRemoteOf(config, branch),
  };
}

export interface SyncAssessmentInput {
  base: BaseState;
  branch: string;
  remote: string;
  config: queries.GitConfig;
  policy: SyncPolicy;
  onConflict: ConflictMode;
  longLived: readonly string[];
  /** false = nothing was fetched; there is nothing to compare. */
  online: boolean;
  /** Shown as the reason when not online. */
  offlineReason?: string;
  /** The user has taken responsibility for overwriting the remote branch. */
  forced: boolean;
}

export interface SyncAssessment {
  sync: SyncState;
  target: SyncTarget;
  decision: SyncDecision;
}

/**
 * State → target → comparison → decision, after any fetch. Shared by the push
 * pipeline and the hook, which differ only in what they do with the decision.
 */
export function assessSync(git: GitRunner, input: SyncAssessmentInput): SyncAssessment {
  const { base, branch, remote, config, policy } = input;
  const sync = input.online
    ? queries.readSyncState(git, config, remote, branch)
    : queries.readOfflineSyncState(remote);
  const target = chooseTarget({
    branch,
    sync,
    policy,
    enabled: input.online,
    disabledReason: input.offlineReason,
    longLived: input.longLived,
  });
  const comparison = target.ref
    ? queries.compareWith(git, queries.syncRefForLabel(remote, target.ref))
    : null;
  const decision = decideSync({
    base,
    sync,
    target,
    comparison,
    policy,
    forced: input.forced,
    onConflict: input.onConflict,
  });
  return { sync, target, decision };
}

function reportSync(ui: Reporter, decision: SyncDecision): void {
  if (decision.warning) ui.warn(decision.warning);
  if (decision.action === "none" && !decision.warning) ui.ok(decision.reason);
}

export async function runPush(deps: WorkflowDeps, opts: RunOptions): Promise<WorkflowOutcome> {
  const { git, ui } = deps;

  // ── Preflight ────────────────────────────────────────────────────────────
  const base = assertWorkable(deps);
  const branch = base.branch as string; // preflight rules out detached/unborn
  const config = queries.readGitConfig(git);
  const remote = resolveRemote(opts.gitArgs, base.remotes, remotePreferences(config, branch));
  const dest = queries.pushDestination(config, remote, branch);
  const scope = scopeOfPush({
    gitArgs: opts.gitArgs,
    branch,
    upstream: `${remote}/${dest}`,
    remote,
  });

  // pull-pal vouches for the checked-out branch only. Anything else goes to git
  // untouched: syncing or testing HEAD says nothing about another branch, and a
  // lease added on HEAD's behalf could force-push over someone else's work.
  const syncing = opts.sync && scope.syncsHead;
  if (!scope.syncsHead) {
    ui.warn(`Pushing ${scope.description}, not the checked-out branch (${branch}).`);
    ui.detail(
      scope.testsHead
        ? "pull-pal will test it, but will not sync it or change how it is pushed."
        : "pull-pal can only check the branch you have checked out — sync and tests are skipped.",
    );
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  // pullpal.sync=off compares nothing, so it has nothing to fetch.
  const fetching = syncing && opts.syncPolicy !== "off";
  if (fetching) {
    ui.step(`Fetching ${remote}...`);
    const fetched = actions.fetch(git, remote);
    if (!fetched.ok) {
      throw new UserFacingError(`Could not fetch ${remote}.`, {
        hint: fetched.message || "Check your network connection and remote configuration.",
        exitCode: EXIT.preflight,
      });
    }
    ui.ok("Fetched");
  } else if (!opts.sync) {
    ui.info("Skipping fetch and sync (--no-sync)");
  } else if (syncing) {
    ui.info("Sync disabled (pullpal.sync=off) — not fetching");
  }

  // ── Sync decision ────────────────────────────────────────────────────────
  const { target, decision } = assessSync(git, {
    base,
    branch,
    remote,
    config,
    policy: opts.syncPolicy,
    onConflict: opts.onConflict,
    longLived: opts.longLived,
    online: fetching,
    offlineReason: !opts.sync
      ? "sync skipped (--no-sync)"
      : !scope.syncsHead
        ? "not syncing a push of another branch"
        : "sync disabled (pullpal.sync=off)",
    forced: userOverridesGuard(opts.gitArgs),
  });

  if (decision.block) {
    ui.fail(decision.block.reason);
    ui.detail(decision.block.hint);
    if (decision.block.kind === "conflicts") {
      ui.detail("To push anyway: pull-pal --no-sync, or git config pullpal.onConflict warn");
    }
    return outcome({
      exitCode: EXIT.blocked,
      blocked: decision.block.kind === "conflicts" ? "conflicts" : "diverged-upstream",
    });
  }

  // The branch is published on its first push, so the plan must say so.
  const setUpstream =
    !queries.hasUpstream(config, branch) && scope.syncsHead ? { remote, branch } : null;

  // ── Dry run stops here, after everything has been decided ────────────────
  if (opts.dryRun) {
    const lease = { branch: dest, expect: queries.revParse(git, queries.syncRef(remote, dest)) };
    printDryRun(deps, opts, {
      decision,
      target,
      remote,
      setUpstream,
      lease,
      testsHead: scope.testsHead,
    });
    return outcome({ exitCode: EXIT.ok });
  }

  // ── Rebase ───────────────────────────────────────────────────────────────
  let rebased = false;
  if (decision.action === "rebase" && decision.onto) {
    if (decision.warning) ui.warn(decision.warning);
    ui.step(`Rebasing onto ${decision.onto} (${decision.reason})...`);
    const result = actions.rebase(git, queries.syncRefForLabel(remote, decision.onto));
    if (!result.ok) {
      const manual = `Integrate manually with: ${pullCommand(remote, decision.onto, "rebase")}`;
      const hint =
        result.state === "not-started"
          ? `The rebase could not start — your branch is exactly as it was.\n${manual}`
          : result.state === "aborted"
            ? `The rebase was rolled back — your branch is exactly as it was.\n${manual}`
            : "The repository is mid-rebase. Resolve the conflicts, then run: git rebase --continue";
      throw new UserFacingError(`Could not rebase onto ${decision.onto}.`, {
        hint: `${result.message}\n${hint}`,
        exitCode: EXIT.preflight,
      });
    }
    rebased = true;
    ui.ok(`Rebased onto ${decision.onto}`);
  } else if (fetching) {
    reportSync(ui, decision);
  }

  // ── Tests ────────────────────────────────────────────────────────────────
  let testsPassed: boolean | null = null;
  let testRunner: string | null = null;

  if (opts.tests && scope.testsHead) {
    const result = await runTestStep(deps, { useCache: opts.useTestCache });
    const summary = reportTestStep(ui, result, false);
    testsPassed = summary.passed;
    testRunner = summary.runner;
    if (summary.failedCode !== null) {
      return outcome({
        exitCode: summary.failedCode,
        rebased,
        testsPassed: false,
        testRunner,
        blocked: "tests-failed",
      });
    }
  }

  // ── Push ─────────────────────────────────────────────────────────────────
  const pushPlan = planPush({
    gitArgs: opts.gitArgs,
    didRebase: rebased,
    setUpstream,
    // Pinned to what this run fetched and checked, not to refs/remotes/*.
    lease: { branch: dest, expect: queries.revParse(git, queries.syncRef(remote, dest)) },
  });

  if (pushPlan.forceLeaseAdded) {
    ui.warn("Rebase rewrote history — pushing with --force-with-lease");
  }

  ui.step("Pushing...");
  const code = actions.push(git, pushPlan.args);
  if (code === 0) {
    ui.ok("Pushed successfully");
  } else {
    ui.fail("Push failed.");
  }

  return outcome({
    exitCode: code,
    rebased,
    pushed: code === 0,
    testsPassed,
    testRunner,
  });
}

interface DryRunPlan {
  decision: SyncDecision;
  target: SyncTarget;
  remote: string;
  setUpstream: { remote: string; branch: string } | null;
  lease: { branch: string; expect: string | null };
  testsHead: boolean;
}

function describeSync(decision: SyncDecision, target: SyncTarget): string {
  if (decision.action === "rebase") return `rebase onto ${decision.onto} (${decision.reason})`;
  if (!target.ref) return `none (${decision.reason})`;
  return `compare with ${target.ref} — ${decision.reason}`;
}

function describeTests(deps: WorkflowDeps, opts: RunOptions, plan: DryRunPlan): string {
  if (!opts.tests) return "skipped (--no-tests)";
  if (!plan.testsHead) return "skipped (not the checked-out branch)";
  const tests = deps.detectTests();
  if (!tests) return "none detected";
  const label = `${tests.label} [${tests.source}]`;
  if (!tests.shell && !deps.isRunnable(tests.command))
    return `${label} — not on PATH, would be skipped`;
  // After a rebase the tree is a new one, so today's cache says nothing about it.
  if (plan.decision.action === "rebase") return `${label} — on the rebased commit`;
  const tree = queries.readHeadTree(deps.git);
  if (opts.useTestCache && tree && deps.testCache.has(tree, tests)) {
    return `${label} — already passed for this commit, would be skipped`;
  }
  return label;
}

function printDryRun(deps: WorkflowDeps, opts: RunOptions, plan: DryRunPlan): void {
  const { ui } = deps;
  if (plan.decision.warning) ui.warn(plan.decision.warning);
  ui.info("Dry run — nothing will be changed.");
  ui.info(`  remote:  ${plan.remote}`);
  ui.info(`  sync:    ${describeSync(plan.decision, plan.target)}`);
  ui.info(`  tests:   ${describeTests(deps, opts, plan)}`);

  const pushPlan = planPush({
    gitArgs: opts.gitArgs,
    didRebase: plan.decision.action === "rebase",
    setUpstream: plan.setUpstream,
    lease: plan.lease,
  });
  ui.info(`  push:    git push ${pushPlan.args.join(" ")}`.trimEnd());
}
