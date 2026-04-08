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

Options:
  --no-rebase   Skip the rebase-against-default-branch step
  --no-tests    Skip the test runner step
  --help        Show this help message

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

function setupHook(): void {
  const gitDir = findGitDir();
  if (!gitDir) {
    fail("Not inside a git repository.");
    process.exit(1);
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
      process.exit(1);
    }
    warn("pre-push hook is already installed — nothing changed.");
    process.exit(0);
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
}

function removeHook(): void {
  const gitDir = findGitDir();
  if (!gitDir) {
    fail("Not inside a git repository.");
    process.exit(1);
  }

  const hookPath = join(gitDir, "hooks", "pre-push");

  if (!existsSync(hookPath)) {
    warn("No pre-push hook found — nothing to remove.");
    process.exit(0);
  }

  const content = readFileSync(hookPath, "utf8");
  if (!content.includes("pull-pal --hook-mode")) {
    fail(
      `The pre-push hook at ${hookPath} was not installed by pull-pal.\n` +
      `  Remove it manually if you no longer need it.`
    );
    process.exit(1);
  }

  unlinkSync(hookPath);
  ok("pre-push hook removed.");
}

const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (rawArgs[0] === "setup") {
  setupHook();
  process.exit(0);
}

if (rawArgs[0] === "remove-hook") {
  removeHook();
  process.exit(0);
}

const noRebase = rawArgs.includes("--no-rebase");
const noTests  = rawArgs.includes("--no-tests");
const hookMode = rawArgs.includes("--hook-mode");

// Strip our own flags; pass everything else through to git push
const gitArgs = rawArgs.filter(
  (a) => a !== "--no-rebase" && a !== "--no-tests" && a !== "--hook-mode"
);

async function main(): Promise<void> {
  // ── Step 1: Fetch ────────────────────────────────────────────────────────
  step("Fetching remote...");
  try {
    git.fetch();
    ok("Fetched");
  } catch (e: unknown) {
    fail((e as Error).message);
    process.exit(1);
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
        process.exit(1);
      }
    } else {
      ok(`Up to date with origin/${defaultBranch}`);
    }
  }

  // ── Step 4: Detect and run tests ─────────────────────────────────────────
  if (!noTests) {
    step("Detecting test runner...");
    const runner = detectTestRunner();

    if (!runner) {
      warn("No test runner detected — skipping tests.");
      warn("Use --no-tests to suppress this warning.");
    } else {
      step(`Running: ${runner.label}`);
      const { exitCode } = await runTests(runner.command, runner.args);
      if (exitCode !== 0) {
        fail("Tests failed — push blocked.");
        process.exit(exitCode);
      }
      ok("Tests passed");
    }
  }

  // ── Step 5: Push ─────────────────────────────────────────────────────────
  // In hook mode without a rebase, git itself handles the push — just exit 0.
  if (hookMode && !didRebase) {
    process.exit(0);
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

  process.exit(exitCode);
}

main().catch((e: unknown) => {
  fail((e as Error).message ?? String(e));
  process.exit(1);
});
