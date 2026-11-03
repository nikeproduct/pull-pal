/**
 * Configuration, read from `git config` so it layers per-repo over global for
 * free and is discoverable with tools users already have.
 *
 * Precedence: command-line flags > repo config > global config > defaults.
 * (Flags are applied by `toRunOptions`; everything below is the config half.)
 *
 * Every read is total — an unreadable or nonsensical value falls back to the
 * default rather than failing a push.
 */

import { DEFAULT_LONG_LIVED } from "./core/plan";
import type { ConflictMode, SyncPolicy } from "./core/types";
import type { GitConfig } from "./git/queries";

export interface PullPalConfig {
  syncPolicy: SyncPolicy;
  /** What a conflict with the base branch does — in both the command and the hook. */
  onConflict: ConflictMode;
  testsEnabled: boolean;
  testCommand: string | null;
  /** Remember passing trees and skip re-running them. */
  testCache: boolean;
  /** Branch patterns never compared with the default branch. */
  longLived: readonly string[];
}

export const DEFAULT_CONFIG: PullPalConfig = {
  syncPolicy: "check",
  onConflict: "block",
  testsEnabled: true,
  testCommand: null,
  testCache: true,
  longLived: DEFAULT_LONG_LIVED,
};

export const CONFIG_KEYS = {
  sync: "pullpal.sync",
  onConflict: "pullpal.onConflict",
  tests: "pullpal.tests",
  testCommand: "pullpal.testCommand",
  testCache: "pullpal.testCache",
  longLived: "pullpal.longLived",
} as const;

export function parseConflictMode(value: string | null): ConflictMode {
  return value?.toLowerCase() === "warn" ? "warn" : DEFAULT_CONFIG.onConflict;
}

function readKey(config: GitConfig, key: string): string | null {
  const value = config.get(key)?.trim();
  return value ? value : null;
}

export function parseSyncPolicy(value: string | null): SyncPolicy {
  switch (value?.toLowerCase()) {
    case "check":
      return "check";
    case "rebase":
      return "rebase";
    case "upstream":
      return "upstream";
    case "off":
    case "none":
    case "false":
      return "off";
    default:
      return DEFAULT_CONFIG.syncPolicy;
  }
}

/**
 * `pullpal.longLived` may be given several times (`git config --add`), and each
 * value may hold several patterns separated by spaces or commas. Setting it
 * replaces the defaults rather than adding to them, so a repo can also *remove*
 * a default — an empty value means "no long-lived branches".
 */
export function parseLongLived(values: string[]): readonly string[] {
  if (values.length === 0) return DEFAULT_CONFIG.longLived;
  return values.flatMap((v) => v.split(/[\s,]+/)).filter(Boolean);
}

export function parseBool(value: string | null, fallback: boolean): boolean {
  switch (value?.toLowerCase()) {
    case "on":
    case "true":
    case "yes":
    case "1":
      return true;
    case "off":
    case "false":
    case "no":
    case "0":
      return false;
    default:
      return fallback;
  }
}

export function loadConfig(config: GitConfig): PullPalConfig {
  return {
    syncPolicy: parseSyncPolicy(readKey(config, CONFIG_KEYS.sync)),
    onConflict: parseConflictMode(readKey(config, CONFIG_KEYS.onConflict)),
    testsEnabled: parseBool(readKey(config, CONFIG_KEYS.tests), DEFAULT_CONFIG.testsEnabled),
    testCommand: readKey(config, CONFIG_KEYS.testCommand),
    testCache: parseBool(readKey(config, CONFIG_KEYS.testCache), DEFAULT_CONFIG.testCache),
    longLived: parseLongLived(config.getAll(CONFIG_KEYS.longLived)),
  };
}

/**
 * Whether to emit ANSI colour. Honours the NO_COLOR convention and never
 * colours output that is being piped somewhere.
 */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return true;
  return process.stdout.isTTY === true;
}
