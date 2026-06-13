/**
 * Privacy-conscious, fire-and-forget telemetry for pull-pal.
 *
 * Sends at most two anonymous events per run to PostHog:
 *   - `install`         once, on the very first run
 *   - `command_invoked` once per run, carrying the workflow outcome
 *
 * Guarantees:
 *   - Never blocks the happy path: events are emitted only at terminal points,
 *     after the user-visible output has already printed, and are bounded by a
 *     short timeout.
 *   - Never throws and never fails the push: all errors are swallowed.
 *   - No PII: only a random UUID, OS/arch, version, install source, and coarse
 *     workflow flags/outcomes are sent. No repo names, paths, remotes, or
 *     branch names ever leave the machine.
 *
 * Opt out anytime: `pull-pal analytics off`, `DO_NOT_TRACK=1`, or
 * `PULLPAL_NO_ANALYTICS=1`.
 */

import { VERSION } from "./version";
import {
  type AnalyticsConfig,
  analyticsEnabled,
  loadOrInitConfig,
} from "./config";

// PostHog Cloud US ingestion endpoint. The project key below is a *public*
// write-only ingestion key (phc_…) and is safe to embed in distributed binaries
// — it can only send events, never read data.
const POSTHOG_HOST = "https://us.i.posthog.com/capture/";
const POSTHOG_KEY: string = "phc_B8muxnnSGeEQyUJwSypQeDbbAih489GSCSfNrjYDSWtH";
const ANALYTICS_TIMEOUT_MS = 700;

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export interface CommandProps {
  command: "push" | "setup" | "remove-hook" | "help";
  hook_mode?: boolean;
  no_rebase?: boolean;
  no_tests?: boolean;
  rebased?: boolean;
  test_runner?: string | null;
  tests_passed?: boolean | null;
  push_succeeded?: boolean | null;
  exit_code?: number;
}

let state: { config: AnalyticsConfig | null; isFirstRun: boolean } = {
  config: null,
  isFirstRun: false,
};

/**
 * Load (or first-time initialise) the local analytics record. Call once at
 * startup. Returns whether this was the first run so the caller can print the
 * one-time notice.
 */
export function initAnalytics(): { isFirstRun: boolean } {
  state = loadOrInitConfig();
  return { isFirstRun: state.isFirstRun };
}

function keyConfigured(): boolean {
  return POSTHOG_KEY.startsWith("phc_") && POSTHOG_KEY !== "phc_REPLACE_ME";
}

function baseProps(config: AnalyticsConfig): Record<string, unknown> {
  return {
    os: process.platform,
    arch: process.arch,
    version: VERSION,
    install_source: config.installSource,
    // Ingest as an anonymous event (no person profile). We intentionally do NOT
    // set $ip, so PostHog can still derive coarse country-level geo.
    $process_person_profile: false,
  };
}

/** Low-level single-event POST. Bounded by timeout; swallows every error. */
async function postCapture(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(POSTHOG_HOST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: distinctId,
        properties,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
    });
  } catch {
    // Offline, blocked, slow, or rejected — telemetry is never load-bearing.
  }
}

/**
 * Emit the command event (plus the install event on first run), wait at most
 * ANALYTICS_TIMEOUT_MS for them to flush, then exit with `code`.
 *
 * When analytics is disabled this exits immediately with zero added latency and
 * no network access.
 */
export async function flushAndExit(code: number, props: CommandProps): Promise<never> {
  const config = state.config;
  if (config && keyConfigured() && analyticsEnabled(config)) {
    const base = baseProps(config);
    const sends: Promise<void>[] = [];

    if (state.isFirstRun) {
      sends.push(postCapture("install", config.anonymousId, base));
    }
    sends.push(
      postCapture("command_invoked", config.anonymousId, {
        ...base,
        ...props,
      }),
    );

    await Promise.allSettled(sends);
  }

  process.exit(code);
}

/**
 * Print a one-time anonymous-telemetry notice on the first run. Subsequent runs
 * find the config file already present and stay silent.
 */
export function maybePrintFirstRunNotice(isFirstRun: boolean): void {
  if (!isFirstRun) return;
  process.stderr.write(
    `${DIM}pull-pal collects anonymous, non-identifying usage analytics (OS, version,\n` +
      `and command outcomes — never repo names, paths, or code) to improve the tool.\n` +
      `Opt out anytime: "pull-pal analytics off", or set DO_NOT_TRACK=1.${RESET}\n`,
  );
}
