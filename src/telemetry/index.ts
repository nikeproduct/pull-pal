/**
 * Privacy-conscious, fire-and-forget telemetry.
 *
 * At most two anonymous events per run:
 *   install         once, on the very first run
 *   command_invoked once per run, carrying the workflow outcome
 *
 * Guarantees, all of them tested:
 *   - Never blocks the happy path — events are sent only at the terminal point,
 *     after user-visible output, bounded by a short timeout.
 *   - Never throws, never changes an exit code.
 *   - No PII: a random UUID, OS/arch, version, install source, and coarse
 *     outcome flags. No repo names, paths, remotes, branches, or code.
 *   - Sends absolutely nothing when disabled — not a connection, not a DNS
 *     lookup.
 *
 * Opt out: `pull-pal analytics off`, DO_NOT_TRACK=1, or PULLPAL_NO_ANALYTICS=1.
 */

import { VERSION } from "../version";
import { type AnalyticsState, analyticsEnabled, defaultConfigDir, loadOrInit } from "./state";

/**
 * PostHog Cloud US ingestion. The key is a *public, write-only* project key —
 * it can send events and nothing else, which is why embedding it in distributed
 * binaries is safe.
 */
export const POSTHOG_HOST = "https://us.i.posthog.com/capture/";
const POSTHOG_KEY = "phc_B8muxnnSGeEQyUJwSypQeDbbAih489GSCSfNrjYDSWtH";
const TIMEOUT_MS = 700;

export interface CommandProps {
  command: "push" | "gate" | "setup" | "remove-hook" | "doctor" | "help" | "analytics";
  hook_mode?: boolean;
  no_sync?: boolean;
  no_tests?: boolean;
  dry_run?: boolean;
  sync_policy?: string;
  rebased?: boolean;
  test_runner?: string | null;
  tests_passed?: boolean | null;
  push_succeeded?: boolean | null;
  /** Why the gate stopped a push, when it did — the new hook needs this signal. */
  hook_gate_result?: string | null;
  blocked?: string | null;
  exit_code?: number;
}

export interface TelemetryOptions {
  /** Override the ingestion endpoint (tests point this at a local server). */
  endpoint?: string;
  /** Override the state directory. */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface Telemetry {
  /** Send the run's events and wait briefly for them to flush. */
  flush(props: CommandProps): Promise<void>;
  /** True on the very first run, so the caller can print the notice. */
  readonly isFirstRun: boolean;
  readonly state: AnalyticsState | null;
  readonly enabled: boolean;
}

function baseProps(state: AnalyticsState): Record<string, unknown> {
  return {
    os: process.platform,
    arch: process.arch,
    version: VERSION,
    install_source: state.installSource,
    // Anonymous event, no person profile. $ip is deliberately left alone so
    // PostHog can still derive country-level geography.
    $process_person_profile: false,
  };
}

export function createTelemetry(opts: TelemetryOptions = {}): Telemetry {
  const env = opts.env ?? process.env;
  const dir = opts.configDir ?? defaultConfigDir(env);
  const endpoint = opts.endpoint ?? POSTHOG_HOST;
  const doFetch = opts.fetchImpl ?? fetch;

  const { state, isFirstRun } = loadOrInit(dir, env);
  const enabled = analyticsEnabled(state, env);

  async function capture(event: string, properties: Record<string, unknown>): Promise<void> {
    if (!state) return;
    try {
      await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: POSTHOG_KEY,
          event,
          distinct_id: state.anonymousId,
          properties,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // Offline, blocked, slow, or rejected. Telemetry is never load-bearing.
    }
  }

  return {
    isFirstRun,
    state,
    enabled,
    async flush(props) {
      if (!enabled || !state) return;
      const base = baseProps(state);
      const sends: Promise<void>[] = [];
      if (isFirstRun) sends.push(capture("install", base));
      sends.push(capture("command_invoked", { ...base, ...props }));
      await Promise.allSettled(sends);
    },
  };
}

export const FIRST_RUN_NOTICE = [
  "pull-pal collects anonymous, non-identifying usage analytics (OS, version, and",
  "command outcomes — never repo names, paths, branches, or code) to improve the tool.",
  'Opt out anytime: "pull-pal analytics off", or set DO_NOT_TRACK=1.',
].join("\n");
