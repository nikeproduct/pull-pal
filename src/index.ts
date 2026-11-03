#!/usr/bin/env bun
/**
 * Entry point: parse, wire the adapters, run, and translate anything that
 * escapes into an exit code.
 *
 * There is exactly one error boundary, at the bottom of this file. A
 * `UserFacingError` is a condition we anticipated, so it prints as a message;
 * anything else is a bug in pull-pal and says so.
 */

import { readFileSync } from "node:fs";
import { isatty } from "node:tty";
import { parseArgs, toRunOptions } from "./cli/args";
import { renderDoctor } from "./cli/doctor";
import { renderHelp } from "./cli/help";
import { createUi } from "./cli/ui";
import { loadConfig } from "./config";
import { EXIT, isUserFacing } from "./core/errors";
import { type PushRef, parsePushRefs, runGate } from "./core/gate";
import { type WorkflowDeps, runPush } from "./core/workflow";
import { createFsView, detectTestRunner } from "./detect/index";
import { isInternalInvocation } from "./git/actions";
import { createGitRunner } from "./git/exec";
import { gitPath, readGitConfig } from "./git/queries";
import { describeHookState, installHook, readHookState, removeHook } from "./hooks/install";
import { FIRST_RUN_NOTICE, createTelemetry } from "./telemetry/index";
import { defaultConfigDir, setOptOut, statePath } from "./telemetry/state";
import { createFileTestCache, createMemoryTestCache } from "./test-cache";
import { isRunnable, runTests } from "./testing";
import { VERSION } from "./version";

/**
 * Detection and test execution should see the project root, not whatever
 * subdirectory the user happens to be standing in.
 */
function repoRoot(cwd: string): string {
  const r = createGitRunner(cwd).capture(["rev-parse", "--show-toplevel"]);
  return r.exitCode === 0 && r.stdout ? r.stdout : cwd;
}

/**
 * Git feeds the pre-push hook its ref list on stdin. We must consume it — both
 * to know whether this push is only deleting branches, and so that a test runner
 * later in the pipeline cannot swallow the protocol (it is given no stdin at all
 * in hook mode, but draining first is what makes that safe).
 *
 * The read is blocking on purpose. Awaiting `Bun.stdin.text()` here let the
 * event loop drain on Windows before the pipe delivered anything, and Bun then
 * exited 0 with the gate never run — a hook that silently failed open. A
 * synchronous read has no event loop to lose, and git closes the pipe as soon
 * as the ref list is written, so it returns promptly.
 *
 * Guarded on isatty so that running `pull-pal --hook-mode` by hand never hangs
 * waiting for input that will not come.
 */
function readPushRefs(): PushRef[] {
  if (isatty(0)) return [];
  try {
    return parsePushRefs(readFileSync(0, "utf8"));
  } catch {
    return [];
  }
}

async function main(argv: string[]): Promise<number> {
  const { command, warnings } = parseArgs(argv);
  const ui = createUi();
  for (const warning of warnings) ui.warn(warning);

  // --version must stay instant and silent: it is what scripts and installers
  // call, and it should never touch disk, network, or print a notice.
  if (command.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  const telemetry = createTelemetry();
  if (telemetry.isFirstRun && telemetry.enabled) {
    process.stderr.write(`${FIRST_RUN_NOTICE}\n`);
  }

  if (command.kind === "help") {
    process.stdout.write(renderHelp(VERSION));
    await telemetry.flush({ command: "help" });
    return EXIT.ok;
  }

  if (command.kind === "analytics") {
    const dir = defaultConfigDir();
    if (command.mode === "on" || command.mode === "off") {
      const updated = setOptOut(dir, command.mode === "off");
      if (!updated) {
        ui.fail("Could not save the analytics preference — nothing was changed.");
        ui.detail(
          `Check that ${statePath(dir)} is writable by you (not owned by root after a sudo run).`,
        );
        if (command.mode === "off") ui.detail("Or opt out without the file: export DO_NOT_TRACK=1");
        return EXIT.preflight;
      }
      ui.ok(
        command.mode === "off"
          ? "Analytics disabled. No usage data will be sent."
          : "Analytics enabled. Thank you for helping improve pull-pal.",
      );
      return EXIT.ok;
    }

    const state = telemetry.state;
    process.stdout.write(`Analytics: ${telemetry.enabled ? "enabled" : "disabled"}\n`);
    if (state) {
      process.stdout.write(`  Device ID:      ${state.anonymousId}\n`);
      process.stdout.write(`  Install source: ${state.installSource}\n`);
      if (!state.optOut && !telemetry.enabled) {
        process.stdout.write("  (suppressed by DO_NOT_TRACK / PULLPAL_NO_ANALYTICS)\n");
      }
    }
    return EXIT.ok;
  }

  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const git = createGitRunner(root);
  const config = loadConfig(readGitConfig(git));
  const runnable = (command: string) => isRunnable(command, root);
  const detect = () =>
    detectTestRunner(
      { fs: createFsView(root), platform: process.platform },
      { override: config.testCommand },
    );

  switch (command.kind) {
    case "doctor": {
      process.stdout.write(
        `${renderDoctor({
          version: VERSION,
          git,
          config,
          detect,
          isRunnable: runnable,
          hookStatus: describeHookState(readHookState(git)),
        })}\n`,
      );
      await telemetry.flush({ command: "doctor" });
      return EXIT.ok;
    }

    case "setup": {
      const result = installHook(git);
      if (!result.ok) {
        ui.fail(result.message);
        if (result.hint) for (const l of result.hint.split("\n")) ui.detail(l);
        await telemetry.flush({ command: "setup", exit_code: EXIT.preflight });
        return EXIT.preflight;
      }
      ui.ok(result.message);
      ui.detail("Every git push in this repo will now be checked before it leaves.");
      ui.detail("A push that no longer merges with its base, or fails tests, is blocked.");
      await telemetry.flush({ command: "setup", exit_code: EXIT.ok });
      return EXIT.ok;
    }

    case "remove-hook": {
      const result = removeHook(git);
      if (!result.ok) {
        ui.fail(result.message);
        if (result.hint) for (const l of result.hint.split("\n")) ui.detail(l);
        return EXIT.preflight;
      }
      ui.ok(result.message);
      await telemetry.flush({ command: "remove-hook", exit_code: EXIT.ok });
      return EXIT.ok;
    }

    case "push": {
      const opts = toRunOptions(command.flags, config);
      const cacheFile = gitPath(git, "pullpal/passed-trees");

      const deps: WorkflowDeps = {
        git,
        ui,
        detectTests: detect,
        isRunnable: runnable,
        // Hook mode must never inherit stdin: that is where git's ref list lives.
        runTests: (plan) => runTests(plan, { cwd: root, inheritStdin: !opts.hookMode }),
        testCache: cacheFile ? createFileTestCache(cacheFile) : createMemoryTestCache(),
      };

      const shared = {
        no_sync: !opts.sync,
        no_tests: !opts.tests,
        dry_run: opts.dryRun,
        sync_policy: opts.syncPolicy,
      };

      if (opts.hookMode) {
        // pull-pal's own push already ran every one of these checks.
        if (isInternalInvocation()) return EXIT.ok;
        const refs = readPushRefs();
        const outcome = await runGate(deps, { ...opts, refs });
        await telemetry.flush({
          ...shared,
          command: "gate",
          hook_mode: true,
          hook_gate_result: outcome.blocked ?? "allowed",
          test_runner: outcome.testRunner,
          tests_passed: outcome.testsPassed,
          exit_code: outcome.exitCode,
        });
        return outcome.exitCode;
      }

      const outcome = await runPush(deps, opts);
      await telemetry.flush({
        ...shared,
        command: "push",
        rebased: outcome.rebased,
        test_runner: outcome.testRunner,
        tests_passed: outcome.testsPassed,
        push_succeeded: outcome.pushed,
        blocked: outcome.blocked,
        exit_code: outcome.exitCode,
      });
      return outcome.exitCode;
    }
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const ui = createUi();
    if (isUserFacing(error)) {
      ui.fail(error.message);
      if (error.hint) {
        for (const line of error.hint.split("\n")) ui.detail(line);
      }
      process.exit(error.exitCode);
    }
    ui.fail("pull-pal hit an unexpected error — this is a bug.");
    ui.detail("Please report it: https://github.com/nikeproduct/pull-pal/issues");
    ui.detail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(EXIT.internal);
  });
