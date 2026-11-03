/**
 * Argument parsing — pure, and the single source of truth for which flags exist.
 *
 * Two rules keep pull-pal out of git's way:
 *
 *  1. pull-pal owns *long-form flags only*. `-v` and `-h` belong to git push
 *     (verbose, help), so v0.1 stealing them meant those flags could never be
 *     forwarded. Anything not in FLAGS below is passed straight through.
 *  2. `--` ends pull-pal's parsing entirely; everything after it is git's.
 *
 * `help.ts` renders from the same FLAGS table, so documentation cannot drift
 * from behaviour the way the v0.1 README did.
 */

import type { ConflictMode, RunOptions, SyncPolicy } from "../core/types";

export interface FlagSpec {
  name: string;
  description: string;
  /** Older spelling kept working, with a warning. */
  deprecatedAlias?: string;
  /** Hidden from --help (internal plumbing). */
  hidden?: boolean;
}

export const FLAGS: readonly FlagSpec[] = [
  {
    name: "--no-sync",
    description: "Skip the fetch and sync steps entirely",
    deprecatedAlias: "--no-rebase",
  },
  { name: "--no-tests", description: "Skip the test runner step" },
  { name: "--retest", description: "Run the tests even if this commit already passed" },
  { name: "--dry-run", description: "Show what would happen, change nothing" },
  { name: "--help", description: "Show this help message" },
  { name: "--version", description: "Print the pull-pal version" },
  {
    name: "--hook-mode",
    description: "Internal: run as the pre-push gate",
    hidden: true,
  },
];

export const SUBCOMMANDS = [
  { name: "setup", description: "Install the pre-push git hook in this repo" },
  { name: "remove-hook", description: "Uninstall the pre-push git hook" },
  { name: "doctor", description: "Report environment, repo, and detection status" },
  { name: "analytics", description: "Manage anonymous usage analytics (on|off|status)" },
] as const;

export type AnalyticsMode = "on" | "off" | "status";

export type Command =
  | { kind: "push"; flags: ParsedFlags }
  | { kind: "setup" }
  | { kind: "remove-hook" }
  | { kind: "doctor" }
  | { kind: "analytics"; mode: AnalyticsMode }
  | { kind: "help" }
  | { kind: "version" };

export interface ParsedFlags {
  sync: boolean;
  tests: boolean;
  dryRun: boolean;
  hookMode: boolean;
  /** Ignore the record of trees that already passed. */
  retest: boolean;
  /** Everything pull-pal did not claim, in original order. */
  gitArgs: string[];
}

export interface ParseResult {
  command: Command;
  /** Non-fatal notices (e.g. deprecated spellings) for the caller to print. */
  warnings: string[];
}

function isSubcommand(arg: string | undefined): arg is (typeof SUBCOMMANDS)[number]["name"] {
  return SUBCOMMANDS.some((s) => s.name === arg);
}

export function parseArgs(argv: string[]): ParseResult {
  const warnings: string[] = [];

  const first = argv[0];
  if (isSubcommand(first)) {
    switch (first) {
      case "setup":
        return { command: { kind: "setup" }, warnings };
      case "remove-hook":
        return { command: { kind: "remove-hook" }, warnings };
      case "doctor":
        return { command: { kind: "doctor" }, warnings };
      case "analytics": {
        const mode = argv[1];
        const resolved: AnalyticsMode = mode === "on" || mode === "off" ? mode : "status";
        return { command: { kind: "analytics", mode: resolved }, warnings };
      }
    }
  }

  const flags: ParsedFlags = {
    sync: true,
    tests: true,
    dryRun: false,
    hookMode: false,
    retest: false,
    gitArgs: [],
  };

  let passthroughOnly = false;
  let help = false;
  let version = false;

  for (const arg of argv) {
    if (passthroughOnly) {
      flags.gitArgs.push(arg);
      continue;
    }

    // `--` is git's separator too, so forward it along with the rest.
    if (arg === "--") {
      passthroughOnly = true;
      flags.gitArgs.push(arg);
      continue;
    }

    switch (arg) {
      case "--no-sync":
        flags.sync = false;
        continue;
      case "--no-rebase":
        flags.sync = false;
        warnings.push("--no-rebase is deprecated; use --no-sync (it now skips the fetch too).");
        continue;
      case "--no-tests":
        flags.tests = false;
        continue;
      case "--dry-run":
        flags.dryRun = true;
        continue;
      case "--retest":
        flags.retest = true;
        continue;
      case "--hook-mode":
        flags.hookMode = true;
        continue;
      case "--help":
        help = true;
        continue;
      case "--version":
        version = true;
        continue;
      default:
        // Not ours — git's. Includes -v, -h, and every unknown flag.
        flags.gitArgs.push(arg);
    }
  }

  if (help) return { command: { kind: "help" }, warnings };
  if (version) return { command: { kind: "version" }, warnings };
  return { command: { kind: "push", flags }, warnings };
}

export interface ResolvedConfig {
  syncPolicy: SyncPolicy;
  onConflict: ConflictMode;
  testsEnabled: boolean;
  testCache: boolean;
  longLived: readonly string[];
}

/** Flags beat config: an explicit --no-tests overrides `pullpal.tests = on`. */
export function toRunOptions(flags: ParsedFlags, config: ResolvedConfig): RunOptions {
  return {
    sync: flags.sync,
    tests: flags.tests && config.testsEnabled,
    dryRun: flags.dryRun,
    hookMode: flags.hookMode,
    syncPolicy: config.syncPolicy,
    onConflict: config.onConflict,
    longLived: config.longLived,
    useTestCache: config.testCache && !flags.retest,
    gitArgs: flags.gitArgs,
  };
}
