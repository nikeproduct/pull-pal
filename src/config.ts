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

import type { SyncPolicy } from "./core/types";
import type { GitRunner } from "./git/exec";

export interface PullPalConfig {
  syncPolicy: SyncPolicy;
  testsEnabled: boolean;
  testCommand: string | null;
}

export const DEFAULT_CONFIG: PullPalConfig = {
  syncPolicy: "default",
  testsEnabled: true,
  testCommand: null,
};

export const CONFIG_KEYS = {
  sync: "pullpal.sync",
  tests: "pullpal.tests",
  testCommand: "pullpal.testCommand",
} as const;

function readKey(git: GitRunner, key: string): string | null {
  const r = git.capture(["config", "--get", key]);
  return r.exitCode === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
}

export function parseSyncPolicy(value: string | null): SyncPolicy {
  switch (value?.toLowerCase()) {
    case "upstream":
      return "upstream";
    case "off":
    case "none":
    case "false":
      return "off";
    case "default":
    case "main":
      return "default";
    default:
      return DEFAULT_CONFIG.syncPolicy;
  }
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

export function loadConfig(git: GitRunner): PullPalConfig {
  return {
    syncPolicy: parseSyncPolicy(readKey(git, CONFIG_KEYS.sync)),
    testsEnabled: parseBool(readKey(git, CONFIG_KEYS.tests), DEFAULT_CONFIG.testsEnabled),
    testCommand: readKey(git, CONFIG_KEYS.testCommand),
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
