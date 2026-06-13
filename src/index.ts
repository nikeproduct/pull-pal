#!/usr/bin/env bun

import * as git from "./git";
import { detectTestRunner } from "./detect";
import { runTests } from "./runner";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  chmodSync,
} from "fs";
import { join, resolve } from "path";
import { VERSION } from "./version";
import {
  initAnalytics,
  maybePrintFirstRunNotice,
  flushAndExit,
  type CommandProps,
} from "./analytics";
import { setOptOut, loadOrInitConfig, analyticsEnabled } from "./config";

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";

function step(msg: string): void {
  console.log(`\n${BOLD}${CYAN}→ ${msg}${RESET}`);
}

function ok(msg: string): void {
  console.log(`${GREEN}✓ ${msg}${RESET}`);
}

function warn(msg: string): void {
  console.log(`${YELLOW}⚠ ${msg}${RESET}`);
}

function fail(msg: string): void {
  console.error(`${RED}✗ ${msg}${RESET}`);
}

function printHelp(): void {
  console.log(`
pull-pal — git push with automatic fetch, rebase, and test-gating

Usage:
  pull-pal [options] [git push args...]
  pull-pal setup          Install a pre-push git hook in this repo
  pull-pal remove-hook    Uninstall the pre-push git hook
  pull-pal analytics <on|off|status>
                          Manage anonymous usage analytics

Options:
  --no-rebase   Skip the rebase-against-default-branch step
  --no-tests    Skip the test runner step
  --help        Show this help message
  --version     Print the pull-pal version

Anonymous, non-identifying analytics are on by default to help improve the tool.
Opt out with "pull-pal analytics off", or set DO_NOT_TRACK=1.

Any other flags are passed directly to git push.
When a rebase occurs, --force-with-lease is added automatically.

Hook mode (used internally by the pre-push hook):
  --hook-mode   Run checks only; let git handle the final push

Examples:
  pull-pal
  pull-pal origin my-branch
  pull-pal --no-tests origin main
  pull-pal --force-with-lease=origin/HEAD   (override lease ref)
  pull-pal setup                            (run once per repo)
`);
}

function findGitDir(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function setupHook(): number {
  const gitDir = findGitDir();
  if (!gitDir) {
    fail("Not inside a git repository.");
    return 1;
  }

  const hooksDir = join(gitDir, "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = join(hooksDir, "pre-push");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes("pull-pal --hook-mode")) {
      fail(
        `A pre-push hook already exists at ${hookPath} and was not created by pull-pal.\n` +
        `  Add the following line to it manually:\n\n    pull-pal --hook-mode "$@"\n`
      );
      return 1;
    }
    warn("pre-push hook is already installed — nothing changed.");
    return 0;
  }

  const hookContent = `#!/bin/sh\npull-pal --hook-mode "$@"\n`;
  writeFileSync(hookPath, hookContent, { encoding: "utf8" });

  if (process.platform !== "win32") {
    chmodSync(hookPath, 0o755);
  }

  ok(`pre-push hook installed at ${hookPath}`);
  console.log(`\nNow every ${BOLD}git push${RESET} in this repo will automatically:`);
  console.log(`  1. Fetch the remote`);
  console.log(`  2. Rebase against the default branch if you're behind`);
  console.log(`  3. Run your test suite (auto-detected)`);
  console.log(`  4. Block the push if tests fail\n`);
  console.log(`To uninstall: ${BOLD}pull-pal remove-hook${RESET}\n`);
  return 0;
}

function removeHook(): number {
  const gitDir = findGitDir();
  if (!gitDir) {
    fail("Not inside a git repository.");
    return 1;
  }

  const hookPath = join(gitDir, "hooks", "pre-push");

  if (!existsSync(hookPath)) {
    warn("No pre-push hook found — nothing to remove.");
    return 0;
  }

  const content = readFileSync(hookPath, "utf8");
  if (!content.includes("pull-pal --hook-mode")) {
    fail(
      `The pre-push hook at ${hookPath} was not installed by pull-pal.\n` +
      `  Remove it manually if you no longer need it.`
    );
    return 1;
  }

  unlinkSync(hookPath);
  ok("pre-push hook removed.");
  return 0;
}

const rawArgs = process.argv.slice(2);

const noRebase = rawArgs.includes("--no-rebase");
const noTests  = rawArgs.includes("--no-tests");
const hookMode = rawArgs.includes("--hook-mode");

// Strip our own flags; pass everything else through to git push
const gitArgs = rawArgs.filter(
  (a) => a !== "--no-rebase" && a !== "--no-tests" && a !== "--hook-mode"
);

function printAnalyticsStatus(): void {
  const { config } = loadOrInitConfig();
  const enabled = analyticsEnabled(config);
  console.log(`Analytics: ${enabled ? "enabled" : "disabled"}`);
  if (config) {
    console.log(`  Device ID:      ${config.anonymousId}`);
    console.log(`  Install source: ${config.installSource}`);
  }
  if (config && !config.optOut && !enabled) {
    console.log(`  (suppressed by DO_NOT_TRACK / PULLPAL_NO_ANALYTICS)`);
  }
}

// Subcommand / flag dispatch. Runs after analytics has been initialised so the
// terminal commands can flush their one event before exiting.
async function dispatch(): Promise<void> {
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printHelp();
    await flushAndExit(0, { command: "help" });
  }

  if (rawArgs[0] === "analytics") {
    const mode = rawArgs[1];
    if (mode === "off") {
      setOptOut(true);
      ok("Analytics disabled. No usage data will be sent.");
    } else if (mode === "on") {
      setOptOut(false);
      ok("Analytics enabled. Thank you for helping improve pull-pal.");
    } else {
      printAnalyticsStatus();
    }
    process.exit(0);
  }

  if (rawArgs[0] === "setup") {
    await flushAndExit(setupHook(), { command: "setup" });
  }

  if (rawArgs[0] === "remove-hook") {
    await flushAndExit(removeHook(), { command: "remove-hook" });
  }

  await main();
}

async function main(): Promise<void> {
  const props: CommandProps = {
    command: "push",
    hook_mode: hookMode,
    no_rebase: noRebase,
    no_tests: noTests,
  };

  // ── Step 1: Fetch ────────────────────────────────────────────────────────
  step("Fetching remote...");
  try {
    git.fetch();
    ok("Fetched");
  } catch (e: unknown) {
    fail((e as Error).message);
    await flushAndExit(1, { ...props, exit_code: 1, push_succeeded: false });
  }

  // ── Step 2: Resolve default branch ───────────────────────────────────────
  const defaultBranch = git.getDefaultBranch();

  // ── Step 3: Check / rebase against default branch ────────────────────────
  let didRebase = false;

  if (!noRebase) {
    step(`Checking against origin/${defaultBranch}...`);
    const behind = git.isBehind(defaultBranch);

    if (behind) {
      step(`Behind origin/${defaultBranch} — rebasing...`);
      try {
        git.rebase(defaultBranch);
        ok(`Rebased onto origin/${defaultBranch}`);
        didRebase = true;
      } catch (e: unknown) {
        fail((e as Error).message);
        fail("Resolve conflicts then run: git rebase --continue");
        await flushAndExit(1, { ...props, rebased: false, exit_code: 1, push_succeeded: false });
      }
    } else {
      ok(`Up to date with origin/${defaultBranch}`);
    }
  }
  props.rebased = didRebase;

  // ── Step 4: Detect and run tests ─────────────────────────────────────────
  if (!noTests) {
    step("Detecting test runner...");
    const runner = detectTestRunner();
    props.test_runner = runner ? runner.label : null;

    if (!runner) {
      warn("No test runner detected — skipping tests.");
      warn("Use --no-tests to suppress this warning.");
    } else {
      step(`Running: ${runner.label}`);
      const { exitCode } = await runTests(runner.command, runner.args);
      if (exitCode !== 0) {
        fail("Tests failed — push blocked.");
        props.tests_passed = false;
        await flushAndExit(exitCode, { ...props, exit_code: exitCode, push_succeeded: false });
      }
      ok("Tests passed");
      props.tests_passed = true;
    }
  }

  // ── Step 5: Push ─────────────────────────────────────────────────────────
  // In hook mode without a rebase, git itself handles the push — just exit 0.
  if (hookMode && !didRebase) {
    await flushAndExit(0, props);
  }

  // After a rebase, history has been rewritten — force-with-lease is required.
  // Skip adding it if the user already supplied any force flag themselves.
  const userPassedForce = gitArgs.some(
    (a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease")
  );
  const pushArgs =
    didRebase && !userPassedForce
      ? ["--force-with-lease", ...gitArgs]
      : gitArgs;

  if (didRebase && !userPassedForce) {
    warn("Rebase rewrote history — pushing with --force-with-lease");
  }

  step("Pushing...");
  const exitCode = git.push(pushArgs);

  if (exitCode === 0) {
    // In hook mode after a rebase we pushed directly; git's own push will
    // follow but will simply report "Everything up to date".
    ok(hookMode ? "Rebased and pushed. Git will confirm momentarily.\n" : "Pushed successfully!\n");
  } else {
    fail("Push failed.");
  }

  props.push_succeeded = exitCode === 0;
  props.exit_code = exitCode;
  await flushAndExit(exitCode, props);
}

async function entry(): Promise<void> {
  const { isFirstRun } = initAnalytics();
  maybePrintFirstRunNotice(isFirstRun);
  await dispatch();
}

entry().catch(async (e: unknown) => {
  fail((e as Error).message ?? String(e));
  await flushAndExit(1, { command: "push", exit_code: 1, push_succeeded: false });
});
