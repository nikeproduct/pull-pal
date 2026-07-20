/**
 * The detection table: an ordered list of detectors, first match wins.
 *
 * Ordering is deliberate — an explicit user override beats project files, and a
 * package.json script beats language defaults, because a repo that declares how
 * to test itself has already answered the question.
 */

import type { TestPlan } from "../core/types";
import {
  type DetectContext,
  detectGo,
  detectGradle,
  detectMake,
  detectMaven,
  detectPython,
  detectRuby,
  detectRust,
} from "./detectors";
import type { FsView } from "./fsview";
import { detectNode } from "./node";

export type { DetectContext } from "./detectors";
export { createFsView, createMemoryFsView, type FsView } from "./fsview";

/** In table order. Exported so `doctor` can explain what was tried. */
export const DETECTORS: ReadonlyArray<{
  name: string;
  run: (ctx: DetectContext) => TestPlan | null;
}> = [
  { name: "node", run: (ctx) => detectNode(ctx.fs) },
  { name: "rust", run: detectRust },
  { name: "go", run: detectGo },
  { name: "python", run: detectPython },
  { name: "maven", run: detectMaven },
  { name: "gradle", run: detectGradle },
  { name: "make", run: detectMake },
  { name: "ruby", run: detectRuby },
];

/** Wrap a free-form user command so the platform shell interprets it. */
export function shellPlan(command: string, platform: NodeJS.Platform, source: string): TestPlan {
  return {
    command: platform === "win32" ? "cmd" : "sh",
    args: platform === "win32" ? ["/c", command] : ["-c", command],
    label: command,
    source,
    shell: true,
  };
}

interface PackageJsonOverride {
  "pull-pal"?: { test?: string };
}

/** A `"pull-pal": { "test": "..." }` block in package.json. */
function readPackageOverride(fs: FsView): string | null {
  const pkg = fs.readJson<PackageJsonOverride>("package.json");
  const value = pkg?.["pull-pal"]?.test;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export interface DetectOptions {
  /** From `git config pullpal.testCommand` — the highest-priority override. */
  override?: string | null;
}

export function detectTestRunner(
  ctx: DetectContext,
  { override }: DetectOptions = {},
): TestPlan | null {
  if (override && override.trim() !== "") {
    return shellPlan(override, ctx.platform, "config:pullpal.testCommand");
  }

  const packageOverride = readPackageOverride(ctx.fs);
  if (packageOverride) {
    return shellPlan(packageOverride, ctx.platform, "package.json:pull-pal.test");
  }

  for (const detector of DETECTORS) {
    const found = detector.run(ctx);
    if (found) return found;
  }
  return null;
}
