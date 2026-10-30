/**
 * Hook mode: the pre-push gate.
 *
 * WHY THIS IS A GATE AND NOT A WORKFLOW
 *
 * Git resolves the commits it is going to push *before* it runs `pre-push`, and
 * hands them to the hook on stdin. Anything the hook does to rewrite history is
 * therefore invisible to the push already in flight. v0.1 tried to rebase and
 * push from inside the hook, which cannot work: the outer push proceeds with the
 * pre-rebase sha and is rejected as non-fast-forward, leaving the user rebased
 * but unpushed. (It also forwarded the hook's own arguments — a remote *URL* —
 * to `git push` as a refspec, so it failed before it could get that far.)
 *
 * So the hook only ever answers yes or no, and it blocks for exactly two
 * reasons: the branch no longer merges cleanly with its base, or the tests
 * fail. Merely being behind is not one of them — on an active repository that is
 * nearly every push, and a gate that fires on nearly every push gets
 * uninstalled. Every other surprise (odd repo state, missing tools, an
 * undeterminable default branch, a push of something other than the checked-out
 * branch) lets the push through with a warning, for the same reason.
 */

import * as actions from "../git/actions";
import * as queries from "../git/queries";
import { EXIT } from "./errors";
import {
  type PushedRef,
  chooseTarget,
  decideSync,
  preflight,
  resolveRemote,
  scopeOfRefs,
} from "./plan";
import { runTestStep } from "./test-step";
import type { RunOptions } from "./types";
import { type WorkflowDeps, type WorkflowOutcome, outcome } from "./workflow";

/** One line of the ref list git feeds the hook on stdin. */
export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

const ZERO_SHA = /^0+$/;

export function parsePushRefs(input: string): PushRef[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [localRef = "", localSha = "", remoteRef = "", remoteSha = ""] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/** A deletion has an all-zero local sha; there is nothing to test or sync. */
export function isDeletion(ref: PushRef): boolean {
  return ZERO_SHA.test(ref.localSha);
}

export function allDeletions(refs: PushRef[]): boolean {
  return refs.length > 0 && refs.every(isDeletion);
}

export interface GateOptions extends RunOptions {
  /** Ref lines from git; empty when invoked outside a real hook. */
  refs: PushRef[];
}

const BYPASS = "To push anyway, bypass the hook: git push --no-verify";

export async function runGate(deps: WorkflowDeps, opts: GateOptions): Promise<WorkflowOutcome> {
  const { git, ui } = deps;

  // Nothing being added to the remote — deleting branches needs no gate.
  if (allDeletions(opts.refs)) {
    return outcome();
  }

  const base = queries.readBaseState(git);
  const failure = preflight(base);
  if (failure) {
    // Fail open: git's push is legitimate even if pull-pal cannot reason about it.
    ui.warn(`pull-pal skipped its checks: ${failure.reason}`);
    return outcome();
  }
  const branch = base.branch as string;

  // ── What is git pushing? ─────────────────────────────────────────────────
  // Run by hand (no ref list), the gate checks the current branch.
  const head = queries.peelToCommit(git, "HEAD") ?? "";
  const pushed: PushedRef[] = opts.refs
    .filter((r) => !isDeletion(r))
    .map((r) => ({
      localRef: r.localRef,
      remoteRef: r.remoteRef,
      commit: queries.peelToCommit(git, r.localSha),
    }));
  const scope =
    pushed.length > 0
      ? scopeOfRefs(pushed, branch, head)
      : { testsHead: true, syncsHead: true, description: branch };

  if (!scope.testsHead) {
    ui.warn(
      `pull-pal checks only the checked-out branch (${branch}); this push is ${scope.description} — skipping its checks.`,
    );
    return outcome();
  }

  // ── Sync check ───────────────────────────────────────────────────────────
  if (opts.sync && scope.syncsHead) {
    // Git hands the hook the remote's name as its first argument, so a push to a
    // second remote is checked against that remote, not the branch's upstream.
    const upstreamRemote = queries.readUpstreamRemote(git, branch);
    const remote = resolveRemote(opts.gitArgs, base.remotes, upstreamRemote);

    const fetched = actions.fetch(git, remote);
    if (!fetched.ok) {
      ui.warn(`pull-pal could not fetch ${remote} — skipping the sync check.`);
    } else {
      const sync = queries.readSyncState(git, remote, branch);
      const target = chooseTarget({
        branch,
        sync,
        policy: opts.syncPolicy,
        enabled: true,
        longLived: opts.longLived,
      });
      const decision = decideSync({
        base,
        sync,
        target,
        comparison: target.ref ? queries.compareWith(git, target.ref) : null,
        policy: opts.syncPolicy,
        // The divergence guard protects pull-pal's own force-push. The hook
        // never pushes, so it never applies here.
        forced: true,
        onConflict: opts.onConflict,
      });

      if (decision.block?.kind === "conflicts") {
        ui.fail(`Push blocked: ${decision.block.reason}`);
        ui.detail(decision.block.hint);
        ui.detail(BYPASS);
        return outcome({ exitCode: EXIT.blocked, blocked: "conflicts" });
      }
      if (decision.warning) ui.warn(decision.warning);
      if (decision.action === "rebase") {
        // pullpal.sync=rebase: the hook cannot rebase (see above), so it says
        // how to get the rebase, and lets this push through.
        ui.warn(`Your branch is ${decision.reason}. Run pull-pal to rebase and push.`);
      }
    }
  }

  // ── Tests ────────────────────────────────────────────────────────────────
  if (!opts.tests) return outcome();

  const result = await runTestStep(deps, { useCache: opts.useTestCache });
  switch (result.kind) {
    case "none":
      return outcome();
    case "missing":
      ui.warn(
        `pull-pal detected ${result.plan.label}, but "${result.plan.command}" is not on PATH — skipping.`,
      );
      return outcome({ testRunner: result.plan.label });
    case "failed":
      ui.fail(
        result.code === EXIT.interrupted
          ? "Tests interrupted — push cancelled."
          : "Tests failed — push blocked.",
      );
      ui.detail(BYPASS);
      return outcome({
        exitCode: result.code,
        testsPassed: false,
        testRunner: result.plan.label,
        blocked: "tests-failed",
      });
    case "passed":
      ui.ok("Tests passed");
      return outcome({ testsPassed: true, testRunner: result.plan.label });
    case "cached":
      return outcome({ testsPassed: true, testRunner: result.plan.label });
  }
}
