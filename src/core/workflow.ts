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
import { EXIT, UserFacingError } from "./errors";
import { decideSync, planPush, preflight, resolveRemote, userPassedForce } from "./plan";
import type { RunOptions, SyncDecision, TestPlan } from "./types";

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

function outcome(partial: Partial<WorkflowOutcome> = {}): WorkflowOutcome {
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
  if (decision.action === "none") ui.ok(decision.reason);
}

export async function runPush(deps: WorkflowDeps, opts: RunOptions): Promise<WorkflowOutcome> {
  const { git, ui } = deps;

  // ── Preflight ────────────────────────────────────────────────────────────
  const base = assertWorkable(deps);
  const upstreamRemote = queries.readUpstreamRemote(git, base.branch);
  const remote = resolveRemote(opts.gitArgs, base.remotes, upstreamRemote);

  // ── Fetch ────────────────────────────────────────────────────────────────
  if (opts.sync) {
    ui.step(`Fetching ${remote}...`);
    const fetched = actions.fetch(git, remote);
    if (!fetched.ok) {
      throw new UserFacingError(`Could not fetch ${remote}.`, {
        hint: fetched.message || "Check your network connection and remote configuration.",
        exitCode: EXIT.preflight,
      });
    }
    ui.ok("Fetched");
  } else {
    ui.info("Skipping fetch and rebase (--no-sync)");
  }

  // ── Sync decision ────────────────────────────────────────────────────────
  const syncState = queries.readSyncState(git, remote);
  const decision = decideSync({
    base,
    sync: syncState,
    policy: opts.syncPolicy,
    enabled: opts.sync,
    forced: userPassedForce(opts.gitArgs),
  });

  if (decision.block) {
    ui.fail(decision.block.reason);
    ui.detail(decision.block.hint);
    return outcome({ exitCode: EXIT.blocked, blocked: "diverged-upstream" });
  }

  // The branch is published on its first push, so the plan must say so.
  const setUpstream = !syncState.upstream && base.branch ? { remote, branch: base.branch } : null;

  // ── Dry run stops here, after everything has been decided ────────────────
  if (opts.dryRun) {
    printDryRun(deps, opts, decision, remote, setUpstream);
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
  } else {
    reportSync(ui, decision);
  }

  // ── Tests ────────────────────────────────────────────────────────────────
  let testsPassed: boolean | null = null;
  let testRunner: string | null = null;

  if (opts.tests) {
    const plan = deps.detectTests();
    testRunner = plan ? plan.label : null;

    if (!plan) {
      ui.warn("No test runner detected — skipping tests.");
      ui.detail('Set one explicitly: git config pullpal.testCommand "<command>"');
    } else if (!plan.shell && !deps.isRunnable(plan.command)) {
      // A missing tool is an environment gap, not a test failure (defect: v0.1
      // crashed with ENOENT and blocked the push).
      ui.warn(`Detected ${plan.label}, but "${plan.command}" is not on PATH — skipping tests.`);
    } else {
      ui.step(`Running ${plan.label}`);
      const code = await deps.runTests(plan);
      testsPassed = code === 0;
      if (!testsPassed) {
        ui.fail("Tests failed — push blocked.");
        return outcome({
          exitCode: code === 0 ? EXIT.blocked : code,
          rebased,
          testsPassed: false,
          testRunner,
          blocked: "tests-failed",
        });
      }
      ui.ok("Tests passed");
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

function printDryRun(
  deps: WorkflowDeps,
  opts: RunOptions,
  decision: SyncDecision,
  remote: string,
  setUpstream: { remote: string; branch: string } | null,
): void {
  const { ui } = deps;
  ui.info("Dry run — nothing will be changed.");
  ui.info(`  remote:  ${remote}`);
  ui.info(
    `  sync:    ${decision.action === "rebase" ? `rebase onto ${decision.onto}` : "none"} (${decision.reason})`,
  );

  if (opts.tests) {
    const plan = deps.detectTests();
    if (!plan) {
      ui.info("  tests:   none detected");
    } else if (!deps.isRunnable(plan.command)) {
      ui.info(`  tests:   ${plan.label} [${plan.source}] — not on PATH, would be skipped`);
    } else {
      ui.info(`  tests:   ${plan.label} [${plan.source}]`);
    }
  } else {
    ui.info("  tests:   skipped (--no-tests)");
  }

  const pushPlan = planPush({
    gitArgs: opts.gitArgs,
    didRebase: decision.action === "rebase",
    setUpstream,
  });
  ui.info(`  push:    git push ${pushPlan.args.join(" ")}`.trimEnd());
}
