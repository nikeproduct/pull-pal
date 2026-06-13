/**
 * Local analytics state and opt-out policy for pull-pal.
 *
 * Stores a single anonymous device record at ~/.pull-pal/analytics.json. There
 * is NO personally identifiable information here: just a random UUID, the
 * install channel, an opt-out flag, and the first-run timestamp.
 *
 * Every function in this module is best-effort and MUST NOT throw — if the home
 * directory is unreadable/unwritable, analytics silently degrades to disabled
 * and the CLI continues normally.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type InstallSource = "npm" | "pip" | "brew" | "unknown";

export interface AnalyticsConfig {
  anonymousId: string;
  installSource: InstallSource;
  optOut: boolean;
  installedAt: string;
  schemaVersion: number;
}

const SCHEMA_VERSION = 1;

function configDir(): string {
  return join(homedir(), ".pull-pal");
}

function configPath(): string {
  return join(configDir(), "analytics.json");
}

/**
 * Determine how this binary was installed.
 * The npm/pip launchers set PULLPAL_INSTALL_SOURCE before spawning us, which is
 * reliable. Homebrew installs the raw binary with no wrapper, so we fall back to
 * a path heuristic. Anything else is "unknown".
 */
function detectInstallSource(): InstallSource {
  const fromEnv = process.env.PULLPAL_INSTALL_SOURCE;
  if (fromEnv === "npm" || fromEnv === "pip" || fromEnv === "brew") {
    return fromEnv;
  }

  // Heuristic: a Homebrew-installed binary lives under a Homebrew prefix.
  const execPath = (process.execPath || "").replace(/\\/g, "/");
  const brewPrefixes = ["/opt/homebrew/", "/usr/local/cellar/", "/home/linuxbrew/"];
  const lowered = execPath.toLowerCase();
  if (brewPrefixes.some((p) => lowered.includes(p))) {
    return "brew";
  }

  return "unknown";
}

function readConfig(): AnalyticsConfig | null {
  try {
    if (!existsSync(configPath())) return null;
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AnalyticsConfig>;
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

function writeConfig(config: AnalyticsConfig): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort: if we can't persist, analytics degrades to disabled.
  }
}

/**
 * Load the existing config, or initialise it on first run.
 * Returns the config (null if it could not be created) plus whether this was
 * the very first run (used to emit a one-time install event + notice).
 */
export function loadOrInitConfig(): { config: AnalyticsConfig | null; isFirstRun: boolean } {
  const existing = readConfig();
  if (existing) {
    return { config: existing, isFirstRun: false };
  }

  let anonymousId: string;
  try {
    anonymousId = crypto.randomUUID();
  } catch {
    return { config: null, isFirstRun: false };
  }

  const config: AnalyticsConfig = {
    anonymousId,
    installSource: detectInstallSource(),
    optOut: false,
    installedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  };
  writeConfig(config);

  // Only treat it as a first run if we actually persisted the record, so we
  // don't re-emit an install event on every invocation when disk is read-only.
  const persisted = readConfig();
  return { config: persisted, isFirstRun: persisted !== null };
}

/**
 * Whether analytics may send events. Any of the following disables it:
 *   - DO_NOT_TRACK is set and truthy (consoledonottrack.com standard)
 *   - PULLPAL_NO_ANALYTICS is set
 *   - the persisted optOut flag is true
 *   - no config could be loaded/created
 */
export function analyticsEnabled(config: AnalyticsConfig | null): boolean {
  if (!config) return false;
  if (config.optOut) return false;

  const dnt = process.env.DO_NOT_TRACK;
  if (dnt && dnt !== "0" && dnt.toLowerCase() !== "false") return false;

  if (process.env.PULLPAL_NO_ANALYTICS) return false;

  return true;
}

/**
 * Persist the opt-out flag. Creates the config first if it does not exist yet
 * so `pull-pal analytics off` works even before the tool has otherwise run.
 */
export function setOptOut(value: boolean): void {
  const { config } = loadOrInitConfig();
  if (!config) return;
  writeConfig({ ...config, optOut: value });
}
