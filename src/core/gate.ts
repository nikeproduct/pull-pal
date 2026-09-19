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
 * So the hook only ever answers yes or no. When a rebase is needed it blocks and
 * tells the user to run `pull-pal`, which does the work correctly in a process
 * that owns its own push.
 *
 * It also blocks for exactly two reasons — out of sync, or failing tests. Every
 * other surprise (odd repo state, missing tools, an undeterminable default
 * branch) lets the push through with a warning. A gate that fails open on the
 * unexpected stays useful; one that fails closed gets uninstalled.
 */

import * as actions from "../git/actions";
import * as queries from "../git/queries";
import { EXIT } from "./errors";
import { decideSync, preflight, resolveRemote, userPassedForce } from "./plan";
import type { RunOptions } from "./types";
import type { WorkflowDeps, WorkflowOutcome } from "./workflow";

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

export type GateMode = "block" | "warn";

export interface GateOptions extends RunOptions {
  /** What to do when the branch is out of sync. */
  gateMode: GateMode;
  /** Ref lines from git; empty when invoked outside a real hook. */
  refs: PushRef[];
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
    return outcome({ blocked: null });
  }

  // ── Sync check ───────────────────────────────────────────────────────────
  if (opts.sync) {
    // Git hands the hook the remote's name as its first argument, so a push to a
    // second remote is checked against that remote, not the branch's upstream.
    const upstreamRemote = queries.readUpstreamRemote(git, base.branch);
    const remote = resolveRemote(opts.gitArgs, base.remotes, upstreamRemote);

    const fetched = actions.fetch(git, remote);
    if (!fetched.ok) {
      ui.warn(`pull-pal could not fetch ${remote} — skipping the sync check.`);
    } else {
      const decision = decideSync({
        base,
        sync: queries.readSyncState(git, remote),
        policy: opts.syncPolicy,
        enabled: true,
        forced: userPassedForce(opts.gitArgs),
      });

      if (decision.action === "rebase") {
        if (opts.gateMode === "warn") {
          ui.warn(`Your branch is ${decision.reason}. Run pull-pal to rebase before pushing.`);
        } else {
          ui.fail(`Push blocked: your branch is ${decision.reason}.`);
          ui.detail("Run pull-pal — it will rebase and push for you.");
          ui.detail("To push anyway, bypass the hook: git push --no-verify");
          return outcome({ exitCode: EXIT.blocked, blocked: "out-of-sync" });
        }
      }
    }
  }

  // ── Tests ────────────────────────────────────────────────────────────────
  if (!opts.tests) return outcome();

  const plan = deps.detectTests();
  if (!plan) return outcome();

  if (!plan.shell && !deps.isRunnable(plan.command)) {
    ui.warn(`pull-pal detected ${plan.label}, but "${plan.command}" is not on PATH — skipping.`);
    return outcome({ testRunner: plan.label });
  }

  ui.step(`Running ${plan.label}`);
  const code = await deps.runTests(plan);
  if (code !== 0) {
    ui.fail("Tests failed — push blocked.");
    ui.detail("To push anyway, bypass the hook: git push --no-verify");
    return outcome({
      exitCode: code,
      testsPassed: false,
      testRunner: plan.label,
      blocked: "tests-failed",
    });
  }

  ui.ok("Tests passed");
  return outcome({ testsPassed: true, testRunner: plan.label });
}
