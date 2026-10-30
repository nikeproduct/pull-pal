/**
 * The test step, shared by the push pipeline and the pre-push gate.
 *
 * Its promise is that the suite runs against exactly what is being pushed:
 * uncommitted and untracked changes are stashed for the duration and restored
 * afterwards. Because that makes the tested content exactly HEAD's tree, a pass
 * can be remembered by tree id and skipped next time.
 */

import * as actions from "../git/actions";
import * as queries from "../git/queries";
import { EXIT, UserFacingError } from "./errors";
import type { TestPlan } from "./types";
import type { WorkflowDeps } from "./workflow";

export type TestStepResult =
  /** No test runner detected. */
  | { kind: "none" }
  /** Detected, but its command is not on PATH. */
  | { kind: "missing"; plan: TestPlan }
  /** This tree already passed with this command. */
  | { kind: "cached"; plan: TestPlan }
  | { kind: "passed"; plan: TestPlan }
  | { kind: "failed"; plan: TestPlan; code: number };

export interface TestStepOptions {
  useCache: boolean;
}

export async function runTestStep(
  deps: WorkflowDeps,
  opts: TestStepOptions,
): Promise<TestStepResult> {
  const { git, ui } = deps;

  const plan = deps.detectTests();
  if (!plan) return { kind: "none" };
  // A missing tool is an environment gap, not a test failure (defect: v0.1
  // crashed with ENOENT and blocked the push).
  if (!plan.shell && !deps.isRunnable(plan.command)) return { kind: "missing", plan };

  const tree = queries.readHeadTree(git);
  if (opts.useCache && tree && deps.testCache.has(tree, plan)) {
    ui.ok(`Tests already passed for this exact commit (${plan.label}) — skipping`);
    ui.detail("Run them anyway with --retest.");
    return { kind: "cached", plan };
  }

  // ── Test exactly what is pushed ──────────────────────────────────────────
  const aside = actions.setAsideChanges(git);
  let isolated = true;
  switch (aside.kind) {
    case "stashed":
      ui.info("Set aside uncommitted changes — testing exactly what will be pushed");
      isolated = aside.isolated;
      if (!isolated)
        ui.warn("Some changes could not be set aside (submodules?) — the tests will see them.");
      break;
    case "not-isolated":
      isolated = false;
      ui.warn(
        "Uncommitted changes could not be set aside (submodules?) — the tests will see them.",
      );
      break;
    case "failed":
      isolated = false;
      ui.warn(
        `Could not set aside uncommitted changes — the tests will see them. (${aside.message})`,
      );
      break;
  }

  ui.step(`Running ${plan.label}`);
  let code: number;
  let restored: actions.ActionResult = { ok: true, message: "" };
  try {
    code = await deps.runTests(plan);
  } finally {
    if (aside.kind === "stashed") restored = actions.restoreChanges(git, aside.stash);
  }

  if (aside.kind === "stashed") {
    if (!restored.ok) {
      // Stop here, whatever the tests said: the last thing on screen must be
      // where the user's work is, not a push result.
      throw new UserFacingError("Could not restore your uncommitted changes automatically.", {
        hint: [
          restored.message,
          `They are safe in the stash ("${actions.STASH_MESSAGE}").`,
          "Find them with: git stash list",
          "Restore them with: git stash pop --index stash@{N}",
          "Nothing was pushed.",
        ]
          .filter(Boolean)
          .join("\n"),
        exitCode: EXIT.preflight,
      });
    }
    ui.info("Restored your uncommitted changes");
  }

  if (code !== 0) return { kind: "failed", plan, code };
  // Only a run that saw exactly HEAD's tree vouches for that tree.
  if (isolated && tree) deps.testCache.record(tree, plan);
  return { kind: "passed", plan };
}
