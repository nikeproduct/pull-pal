/**
 * Telemetry tests.
 *
 * The privacy claims in the README are only worth making if they are enforced,
 * so these assert the negative case hardest: when analytics is off, not a single
 * request leaves the process. A local server counts them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportTestStep } from "../../src/core/test-step";
import { shellPlan } from "../../src/detect/index";
import { createTelemetry } from "../../src/telemetry/index";
import {
  analyticsEnabled,
  detectInstallSource,
  loadOrInit,
  readState,
  setOptOut,
} from "../../src/telemetry/state";
import { recordingUi } from "../helpers/harness";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pullpal-analytics-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A throwaway HTTP server that records every request body it receives. */
async function withCapturingServer<T>(
  fn: (ctx: { url: string; bodies: unknown[] }) => Promise<T>,
): Promise<T> {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json());
      return new Response("ok");
    },
  });
  try {
    return await fn({ url: `http://localhost:${server.port}/capture/`, bodies });
  } finally {
    server.stop(true);
  }
}

describe("state", () => {
  test("creates an anonymous record on first run", () => {
    const { state, isFirstRun } = loadOrInit(dir, {});
    expect(isFirstRun).toBe(true);
    expect(state?.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state?.optOut).toBe(false);
  });

  test("a second run reuses the same id and is not a first run", () => {
    const first = loadOrInit(dir, {});
    const second = loadOrInit(dir, {});
    expect(second.isFirstRun).toBe(false);
    expect(second.state?.anonymousId).toBe(first.state?.anonymousId ?? "");
  });

  test("the persisted record contains no identifying fields", () => {
    loadOrInit(dir, {});
    const raw = JSON.parse(readFileSync(join(dir, "analytics.json"), "utf8"));
    expect(Object.keys(raw).sort()).toEqual([
      "anonymousId",
      "installSource",
      "installedAt",
      "optOut",
      "schemaVersion",
    ]);
  });

  test("a corrupt state file is replaced rather than crashing", () => {
    writeFileSync(join(dir, "analytics.json"), "{ not json", "utf8");
    expect(readState(dir)).toBeNull();
    expect(loadOrInit(dir, {}).state?.anonymousId).toBeTruthy();
  });

  test("setOptOut persists across loads", () => {
    loadOrInit(dir, {});
    setOptOut(dir, true);
    expect(readState(dir)?.optOut).toBe(true);
    setOptOut(dir, false);
    expect(readState(dir)?.optOut).toBe(false);
  });

  // e.g. analytics.json left owned by root after a `sudo pull-pal` run. The CLI
  // must not print "Analytics disabled" while events keep being sent.
  test.skipIf(process.getuid?.() === 0)(
    "setOptOut reports failure when the change cannot be saved",
    () => {
      loadOrInit(dir, {});
      const file = join(dir, "analytics.json");
      chmodSync(file, 0o444);
      try {
        expect(setOptOut(dir, true)).toBeNull();
        expect(readState(dir)?.optOut).toBe(false);
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );
});

describe("install source", () => {
  test.each([
    ["npm", "npm"],
    ["brew", "brew"],
  ] as const)("%s from the launcher env", (value, expected) => {
    expect(detectInstallSource({ PULLPAL_INSTALL_SOURCE: value }, "/x")).toBe(expected);
  });

  test("homebrew prefixes are recognised without a launcher", () => {
    expect(detectInstallSource({}, "/opt/homebrew/bin/pull-pal")).toBe("brew");
    expect(detectInstallSource({}, "/usr/local/Cellar/pull-pal/0.2.0/bin/pull-pal")).toBe("brew");
  });

  test("anything else is unknown, never guessed", () => {
    expect(detectInstallSource({}, "/usr/bin/pull-pal")).toBe("unknown");
    expect(detectInstallSource({ PULLPAL_INSTALL_SOURCE: "nonsense" }, "/x")).toBe("unknown");
  });
});

describe("opt-out matrix", () => {
  const state = {
    anonymousId: "id",
    installSource: "npm" as const,
    optOut: false,
    installedAt: "now",
    schemaVersion: 1,
  };

  test("enabled by default", () => {
    expect(analyticsEnabled(state, {})).toBe(true);
  });

  test.each([
    [{ DO_NOT_TRACK: "1" }],
    [{ DO_NOT_TRACK: "true" }],
    [{ DO_NOT_TRACK: "yes" }],
    [{ PULLPAL_NO_ANALYTICS: "1" }],
    [{ PULLPAL_NO_ANALYTICS: "anything" }],
  ])("disabled by %p", (env) => {
    expect(analyticsEnabled(state, env)).toBe(false);
  });

  test.each([[{ DO_NOT_TRACK: "0" }], [{ DO_NOT_TRACK: "false" }], [{ DO_NOT_TRACK: "" }]])(
    "%p is not an opt-out",
    (env) => {
      expect(analyticsEnabled(state, env)).toBe(true);
    },
  );

  test("the persisted flag disables it", () => {
    expect(analyticsEnabled({ ...state, optOut: true }, {})).toBe(false);
  });

  test("no state at all means disabled", () => {
    expect(analyticsEnabled(null, {})).toBe(false);
  });
});

describe("sending", () => {
  test("a first run sends exactly install + command_invoked", async () => {
    await withCapturingServer(async ({ url, bodies }) => {
      const t = createTelemetry({ endpoint: url, configDir: dir, env: {} });
      await t.flush({ command: "push", exit_code: 0 });

      expect(bodies).toHaveLength(2);
      const events = bodies.map((b) => (b as { event: string }).event).sort();
      expect(events).toEqual(["command_invoked", "install"]);
    });
  });

  test("later runs send only command_invoked", async () => {
    await withCapturingServer(async ({ url, bodies }) => {
      loadOrInit(dir, {}); // consume the first run
      const t = createTelemetry({ endpoint: url, configDir: dir, env: {} });
      await t.flush({ command: "push", exit_code: 0 });

      expect(bodies).toHaveLength(1);
      expect((bodies[0] as { event: string }).event).toBe("command_invoked");
    });
  });

  test("the payload carries outcomes and nothing identifying", async () => {
    await withCapturingServer(async ({ url, bodies }) => {
      loadOrInit(dir, {});
      const t = createTelemetry({ endpoint: url, configDir: dir, env: {} });
      await t.flush({
        command: "push",
        rebased: true,
        test_runner: "bun run test",
        tests_passed: true,
        push_succeeded: true,
        exit_code: 0,
      });

      const body = bodies[0] as { properties: Record<string, unknown> };
      expect(body.properties.rebased).toBe(true);
      expect(body.properties.tests_passed).toBe(true);
      expect(body.properties.$process_person_profile).toBe(false);

      // Nothing about *this* machine or repository may appear anywhere.
      const serialized = JSON.stringify(bodies);
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain(process.cwd());
      for (const forbidden of ["branch", "remote", "repo_name", "path", "email"]) {
        expect(Object.keys(body.properties)).not.toContain(forbidden);
      }
    });
  });

  // A configured command is free text: tokens, usernames, repository paths.
  test("a configured test command never reaches the payload", async () => {
    const command = "API_TOKEN=abc123 /Users/alice/acme-repo/scripts/ci.sh";
    const plan = shellPlan(command, "linux", "config:pullpal.testCommand");
    const { ui } = recordingUi();
    const summary = reportTestStep(ui, { kind: "passed", plan }, false);

    await withCapturingServer(async ({ url, bodies }) => {
      loadOrInit(dir, {});
      const t = createTelemetry({ endpoint: url, configDir: dir, env: {} });
      await t.flush({ command: "push", test_runner: summary.runner, tests_passed: true });

      const serialized = JSON.stringify(bodies);
      expect(serialized).toContain("config:pullpal.testCommand");
      for (const secret of ["abc123", "alice", "acme-repo", "ci.sh"]) {
        expect(serialized).not.toContain(secret);
      }
    });
  });

  test("the gate result is reported, so hook behaviour is measurable", async () => {
    await withCapturingServer(async ({ url, bodies }) => {
      loadOrInit(dir, {});
      const t = createTelemetry({ endpoint: url, configDir: dir, env: {} });
      await t.flush({ command: "gate", hook_gate_result: "out-of-sync", exit_code: 1 });

      const body = bodies[0] as { properties: Record<string, unknown> };
      expect(body.properties.hook_gate_result).toBe("out-of-sync");
    });
  });

  test.each([
    ["DO_NOT_TRACK", { DO_NOT_TRACK: "1" }],
    ["PULLPAL_NO_ANALYTICS", { PULLPAL_NO_ANALYTICS: "1" }],
  ])("sends absolutely nothing when disabled by %s", async (_name, env) => {
    await withCapturingServer(async ({ url, bodies }) => {
      const t = createTelemetry({ endpoint: url, configDir: dir, env });
      await t.flush({ command: "push", exit_code: 0 });
      expect(bodies).toHaveLength(0);
    });
  });

  test("sends nothing after opting out", async () => {
    await withCapturingServer(async ({ url, bodies }) => {
      loadOrInit(dir, {});
      setOptOut(dir, true);
      const t = createTelemetry({ endpoint: url, configDir: dir, env: {} });
      await t.flush({ command: "push", exit_code: 0 });
      expect(bodies).toHaveLength(0);
    });
  });

  test("a failing endpoint never throws", async () => {
    const t = createTelemetry({
      endpoint: "http://127.0.0.1:1/never",
      configDir: dir,
      env: {},
    });
    expect(t.flush({ command: "push", exit_code: 0 })).resolves.toBeUndefined();
  });

  test("a hanging endpoint does not stall the run indefinitely", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}), // never resolves
    });
    try {
      const t = createTelemetry({
        endpoint: `http://localhost:${server.port}/`,
        configDir: dir,
        env: {},
      });
      const started = performance.now();
      await t.flush({ command: "push", exit_code: 0 });
      // Bounded by the internal 700ms timeout, with slack for CI.
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      server.stop(true);
    }
  });
});
