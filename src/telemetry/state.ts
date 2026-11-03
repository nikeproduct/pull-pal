/**
 * Local analytics state and opt-out policy.
 *
 * Ported from v0.1, which got this part right, with one change: the storage
 * directory is injectable, so tests exercise the real code instead of a
 * lookalike and never touch the developer's own ~/.pull-pal.
 *
 * There is no personally identifying information here — a random UUID, the
 * install channel, an opt-out flag, and a first-run timestamp. Every function is
 * best-effort and MUST NOT throw: if the home directory is unwritable, analytics
 * degrades to disabled and the CLI carries on.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type InstallSource = "npm" | "brew" | "unknown";

export interface AnalyticsState {
  anonymousId: string;
  installSource: InstallSource;
  optOut: boolean;
  installedAt: string;
  schemaVersion: number;
}

export const SCHEMA_VERSION = 1;

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PULLPAL_CONFIG_DIR || join(homedir(), ".pull-pal");
}

export function statePath(dir: string): string {
  return join(dir, "analytics.json");
}

/**
 * How this binary was installed. The npm launcher sets
 * PULLPAL_INSTALL_SOURCE before spawning us; Homebrew ships the raw binary with
 * no wrapper, so that falls back to a path heuristic.
 */
export function detectInstallSource(
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
): InstallSource {
  const fromEnv = env.PULLPAL_INSTALL_SOURCE;
  if (fromEnv === "npm" || fromEnv === "brew") return fromEnv;

  const normalized = execPath.replace(/\\/g, "/").toLowerCase();
  const brewPrefixes = ["/opt/homebrew/", "/usr/local/cellar/", "/home/linuxbrew/"];
  if (brewPrefixes.some((p) => normalized.includes(p))) return "brew";

  return "unknown";
}

export function readState(dir: string): AnalyticsState | null {
  try {
    const path = statePath(dir);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AnalyticsState>;
    if (typeof parsed.anonymousId !== "string" || !parsed.anonymousId) return null;
    return {
      anonymousId: parsed.anonymousId,
      installSource: (parsed.installSource as InstallSource) ?? "unknown",
      optOut: parsed.optOut === true,
      installedAt: parsed.installedAt ?? new Date().toISOString(),
      schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
    };
  } catch {
    return null;
  }
}

export function writeState(dir: string, state: AnalyticsState): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(dir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort: unwritable disk simply means analytics stays off.
  }
}

export interface LoadResult {
  state: AnalyticsState | null;
  isFirstRun: boolean;
}

export function loadOrInit(
  dir = defaultConfigDir(),
  env: NodeJS.ProcessEnv = process.env,
): LoadResult {
  const existing = readState(dir);
  if (existing) return { state: existing, isFirstRun: false };

  let anonymousId: string;
  try {
    anonymousId = crypto.randomUUID();
  } catch {
    return { state: null, isFirstRun: false };
  }

  writeState(dir, {
    anonymousId,
    installSource: detectInstallSource(env),
    optOut: false,
    installedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  });

  // Only a genuine first run if the record actually persisted — otherwise a
  // read-only disk would re-emit the install event on every invocation.
  const persisted = readState(dir);
  return { state: persisted, isFirstRun: persisted !== null };
}

/**
 * Whether events may be sent. Any of these disables it:
 *   - DO_NOT_TRACK set to anything truthy (consoledonottrack.com)
 *   - PULLPAL_NO_ANALYTICS set
 *   - the persisted opt-out flag
 *   - no state could be loaded or created
 */
export function analyticsEnabled(
  state: AnalyticsState | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!state) return false;
  if (state.optOut) return false;

  const dnt = env.DO_NOT_TRACK;
  if (dnt && dnt !== "0" && dnt.toLowerCase() !== "false") return false;

  if (env.PULLPAL_NO_ANALYTICS) return false;

  return true;
}

/**
 * Persist the opt-out flag. Returns the saved state, or null when the change did
 * not reach the disk — `writeState` is best-effort, so the file is read back:
 * reporting "Analytics disabled" while events keep flowing would break the one
 * promise this command makes.
 */
export function setOptOut(dir: string, value: boolean): AnalyticsState | null {
  const { state } = loadOrInit(dir);
  if (!state) return null;
  writeState(dir, { ...state, optOut: value });
  const saved = readState(dir);
  return saved?.optOut === value ? saved : null;
}
