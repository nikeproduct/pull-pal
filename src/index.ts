#!/usr/bin/env bun
/**
 * Entry point: parse, wire the adapters, run, and translate anything that
 * escapes into an exit code.
 *
 * There is exactly one error boundary, at the bottom of this file. A
 * `UserFacingError` is a condition we anticipated, so it prints as a message;
 * anything else is a bug in pull-pal and says so.
 */

import { parseArgs, toRunOptions } from "./cli/args";
import { renderDoctor } from "./cli/doctor";
import { renderHelp } from "./cli/help";
import { createUi } from "./cli/ui";
import { loadConfig } from "./config";
import { EXIT, isUserFacing } from "./core/errors";
import { runPush } from "./core/workflow";
import { createFsView, detectTestRunner } from "./detect/index";
import { createGitRunner } from "./git/exec";
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

async function main(argv: string[]): Promise<number> {
  const { command, warnings } = parseArgs(argv);
  const ui = createUi();
  for (const warning of warnings) ui.warn(warning);

  if (command.kind === "help") {
    process.stdout.write(renderHelp(VERSION));
    return EXIT.ok;
  }
  if (command.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const git = createGitRunner(root);
  const config = loadConfig(git);
  const detect = () =>
    detectTestRunner(
      { fs: createFsView(root), platform: process.platform },
      { override: config.testCommand },
    );

  switch (command.kind) {
    case "doctor": {
      process.stdout.write(
        `${renderDoctor({ version: VERSION, git, config, detect, isRunnable })}\n`,
      );
      return EXIT.ok;
    }

    case "setup":
    case "remove-hook":
    case "analytics": {
      // Landing in M4 (hooks) and M5 (analytics).
      ui.fail(`"${command.kind}" is not available in this build yet.`);
      return EXIT.preflight;
    }

    case "push": {
      const opts = toRunOptions(command.flags, {
        syncPolicy: config.syncPolicy,
        testsEnabled: config.testsEnabled,
      });
      const outcome = await runPush(
        {
          git,
          ui,
          detectTests: detect,
          isRunnable,
          runTests: (plan) => runTests(plan, { cwd: root, inheritStdin: !opts.hookMode }),
        },
        opts,
      );
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
