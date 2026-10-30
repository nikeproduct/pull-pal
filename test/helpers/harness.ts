/**
 * Wiring for workflow-level tests: a real git runner against a fixture repo,
 * a recording reporter, and stubbed test detection/execution.
 */

import { DEFAULT_LONG_LIVED } from "../../src/core/plan";
import type { RunOptions } from "../../src/core/types";
import type { Reporter, TestPlan, WorkflowDeps } from "../../src/core/workflow";
import { createGitRunner } from "../../src/git/exec";
import { type TestCache, createMemoryTestCache } from "../../src/test-cache";

export interface RecordingUi {
  ui: Reporter;
  lines: string[];
  /** All output joined, for substring assertions. */
  text(): string;
}

export function recordingUi(): RecordingUi {
  const lines: string[] = [];
  const push = (kind: string) => (msg: string) => lines.push(`${kind}: ${msg}`);
  return {
    lines,
    text: () => lines.join("\n"),
    ui: {
      step: push("step"),
      ok: push("ok"),
      warn: push("warn"),
      fail: push("fail"),
      info: push("info"),
      detail: push("detail"),
    },
  };
}

export interface HarnessOptions {
  /** Test plan the workflow should "detect". Default: none. */
  testPlan?: TestPlan | null;
  /** Exit code the stubbed suite returns. Default 0. */
  testExitCode?: number;
  /** Whether the detected command counts as present on PATH. Default true. */
  runnable?: boolean;
  /** Called while the stubbed suite "runs" — e.g. to inspect the working tree. */
  duringTests?: () => void;
  /** Share a cache between runs. Default: a fresh in-memory cache. */
  testCache?: TestCache;
}

export interface Harness {
  deps: WorkflowDeps;
  ui: RecordingUi;
  /** How many times the test suite was actually executed. */
  testRuns: number;
}

export function makeDeps(cwd: string, opts: HarnessOptions = {}): Harness {
  const ui = recordingUi();
  const harness: Harness = {
    ui,
    testRuns: 0,
    deps: {
      git: createGitRunner(cwd),
      ui: ui.ui,
      detectTests: () => opts.testPlan ?? null,
      isRunnable: () => opts.runnable ?? true,
      async runTests() {
        harness.testRuns += 1;
        opts.duringTests?.();
        return opts.testExitCode ?? 0;
      },
      testCache: opts.testCache ?? createMemoryTestCache(),
    },
  };
  return harness;
}

export function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    sync: true,
    tests: true,
    dryRun: false,
    hookMode: false,
    syncPolicy: "check",
    onConflict: "block",
    longLived: DEFAULT_LONG_LIVED,
    useTestCache: true,
    gitArgs: [],
    ...overrides,
  };
}

export const fakeTestPlan: TestPlan = {
  command: "stub-runner",
  args: ["test"],
  label: "stub-runner test",
  source: "stub",
};
