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
  chooseTarget,
  decideSync,
  planPush,
  preflight,
  resolveRemote,
  scopeOfPush,
  userPassedForce,
} from "./plan";
import { runTestStep } from "./test-step";
import type { RunOptions, SyncDecision, SyncTarget, TestPlan } from "./types";

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
  /** Is this command actually present on PATH? Missing tools warn, never crash. */
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

function reportSync(ui: Reporter, decision: SyncDecision): void {
  if (decision.warning) ui.warn(decision.warning);
  if (decision.action === "none" && !decision.warning) ui.ok(decision.reason);
}

export async function runPush(deps: WorkflowDeps, opts: RunOptions): Promise<WorkflowOutcome> {
  const { git, ui } = deps;

  // ── Preflight ────────────────────────────────────────────────────────────
  const base = assertWorkable(deps);
  const branch = base.branch as string; // preflight rules out detached/unborn
  const upstreamRemote = queries.readUpstreamRemote(git, branch);
  const remote = resolveRemote(opts.gitArgs, base.remotes, upstreamRemote);
  const scope = scopeOfPush({
    gitArgs: opts.gitArgs,
    branch,
    upstream: queries.readUpstream(git),
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
  if (syncing) {
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
  }

  // ── Sync decision ────────────────────────────────────────────────────────
  const syncState = syncing
    ? queries.readSyncState(git, remote, branch)
    : queries.readOfflineSyncState(git, remote);
  const target = chooseTarget({
    branch,
    sync: syncState,
    policy: opts.syncPolicy,
    enabled: syncing,
    disabledReason: opts.sync ? "not syncing a push of another branch" : undefined,
    longLived: opts.longLived,
  });
  const decision = decideSync({
    base,
    sync: syncState,
    target,
    comparison: target.ref ? queries.compareWith(git, target.ref) : null,
    policy: opts.syncPolicy,
    forced: userPassedForce(opts.gitArgs),
    onConflict: opts.onConflict,
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
  const setUpstream = !syncState.upstream && scope.syncsHead ? { remote, branch } : null;

  // ── Dry run stops here, after everything has been decided ────────────────
  if (opts.dryRun) {
    printDryRun(deps, opts, { decision, target, remote, setUpstream, testsHead: scope.testsHead });
    return outcome({ exitCode: EXIT.ok });
  }

  // ── Rebase ───────────────────────────────────────────────────────────────
  let rebased = false;
  if (decision.action === "rebase" && decision.onto) {
    if (decision.warning) ui.warn(decision.warning);
    ui.step(`Rebasing onto ${decision.onto} (${decision.reason})...`);
    const result = actions.rebase(git, decision.onto);
    if (!result.ok) {
      const hint = result.aborted
        ? `The rebase was rolled back — your branch is exactly as it was.\nIntegrate manually with: git rebase ${decision.onto}`
        : "The repository is mid-rebase. Resolve the conflicts, then run: git rebase --continue";
      throw new UserFacingError(`Could not rebase onto ${decision.onto}.`, {
        hint: `${result.message}\n${hint}`,
        exitCode: EXIT.preflight,
      });
    }
    rebased = true;
    ui.ok(`Rebased onto ${decision.onto}`);
  } else if (syncing) {
    reportSync(ui, decision);
  }

  // ── Tests ────────────────────────────────────────────────────────────────
  let testsPassed: boolean | null = null;
  let testRunner: string | null = null;

  if (opts.tests && scope.testsHead) {
    const result = await runTestStep(deps, { useCache: opts.useTestCache });
    testRunner = "plan" in result ? result.plan.label : null;

    switch (result.kind) {
      case "none":
        ui.warn("No test runner detected — skipping tests.");
        ui.detail('Set one explicitly: git config pullpal.testCommand "<command>"');
        break;
      case "missing":
        ui.warn(
          `Detected ${result.plan.label}, but "${result.plan.command}" is not on PATH — skipping tests.`,
        );
        break;
      case "failed":
        ui.fail(
          result.code === EXIT.interrupted
            ? "Tests interrupted — nothing was pushed."
            : "Tests failed — push blocked.",
        );
        return outcome({
          exitCode: result.code,
          rebased,
          testsPassed: false,
          testRunner,
          blocked: "tests-failed",
        });
      case "passed":
        ui.ok("Tests passed");
        testsPassed = true;
        break;
      case "cached":
        testsPassed = true;
        break;
    }
  }

  // ── Push ─────────────────────────────────────────────────────────────────
  const pushPlan = planPush({
    gitArgs: opts.gitArgs,
    didRebase: rebased,
    setUpstream,
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
  testsHead: boolean;
}

function describeSync(decision: SyncDecision, target: SyncTarget): string {
  if (decision.action === "rebase") return `rebase onto ${decision.onto} (${decision.reason})`;
  if (!target.ref) return `none (${decision.reason})`;
  return `compare with ${target.ref} — ${decision.reason}`;
}

function describeTests(deps: WorkflowDeps, opts: RunOptions, testsHead: boolean): string {
  if (!opts.tests) return "skipped (--no-tests)";
  if (!testsHead) return "skipped (not the checked-out branch)";
  const plan = deps.detectTests();
  if (!plan) return "none detected";
  const label = `${plan.label} [${plan.source}]`;
  if (!plan.shell && !deps.isRunnable(plan.command))
    return `${label} — not on PATH, would be skipped`;
  const tree = queries.readHeadTree(deps.git);
  if (opts.useTestCache && tree && deps.testCache.has(tree, plan)) {
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
  ui.info(`  tests:   ${describeTests(deps, opts, plan.testsHead)}`);

  const pushPlan = planPush({
    gitArgs: opts.gitArgs,
    didRebase: plan.decision.action === "rebase",
    setUpstream: plan.setUpstream,
  });
  ui.info(`  push:    git push ${pushPlan.args.join(" ")}`.trimEnd());
}
