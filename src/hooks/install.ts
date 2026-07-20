/**
 * Installing and removing the pre-push hook.
 *
 * The hooks directory is resolved with `git rev-parse --git-path hooks`, which
 * is the only answer that survives `core.hooksPath` (husky, lefthook), linked
 * worktrees, and submodules. v0.1 walked up to the first `.git` it found and
 * assumed it was a directory, so it silently installed hooks that never ran —
 * and crashed outright in a worktree, where `.git` is a file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitRunner } from "../git/exec";
import { gitPath } from "../git/queries";
import { HOOK_VERSION, hookVersionOf, isOurHook, renderHook } from "./template";

export type HookState =
  | { kind: "no-repo" }
  | { kind: "absent"; path: string }
  | { kind: "ours"; path: string; version: number | null; current: boolean }
  | { kind: "foreign"; path: string };

export interface HookActionResult {
  ok: boolean;
  message: string;
  hint?: string;
}

export function hooksDir(git: GitRunner): string | null {
  return gitPath(git, "hooks");
}

export function prePushPath(git: GitRunner): string | null {
  const dir = hooksDir(git);
  return dir ? join(dir, "pre-push") : null;
}

export function readHookState(git: GitRunner): HookState {
  const path = prePushPath(git);
  if (!path) return { kind: "no-repo" };
  if (!existsSync(path)) return { kind: "absent", path };

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { kind: "foreign", path };
  }

  if (!isOurHook(content)) return { kind: "foreign", path };
  const version = hookVersionOf(content);
  return { kind: "ours", path, version, current: version === HOOK_VERSION };
}

/** One-line summary for `doctor`. */
export function describeHookState(state: HookState): string {
  switch (state.kind) {
    case "no-repo":
      return "not a git repository";
    case "absent":
      return "not installed (run: pull-pal setup)";
    case "foreign":
      return `present, but not written by pull-pal (${state.path})`;
    case "ours":
      return state.current
        ? `installed (v${state.version}) at ${state.path}`
        : `installed but outdated (v${state.version ?? "?"} → v${HOOK_VERSION}); run: pull-pal setup`;
  }
}

/**
 * How to invoke pull-pal from the hook.
 *
 * In a compiled binary `process.execPath` is pull-pal itself. Running from
 * source it is the bun binary, so the script path has to come along too —
 * otherwise the hook would invoke bare `bun --hook-mode`.
 */
export function currentInvocation(argv = process.argv): string[] {
  const script = argv[1];
  if (script && /\.[cm]?ts$/.test(script)) {
    return [process.execPath, "run", script];
  }
  return [process.execPath];
}

export function installHook(git: GitRunner, invocation = currentInvocation()): HookActionResult {
  const state = readHookState(git);

  if (state.kind === "no-repo") {
    return { ok: false, message: "Not inside a git repository." };
  }

  if (state.kind === "foreign") {
    return {
      ok: false,
      message: `A pre-push hook already exists and was not written by pull-pal:\n  ${state.path}`,
      hint: 'Add this line to it manually:\n  pull-pal --hook-mode "$@"',
    };
  }

  if (state.kind === "ours" && state.current) {
    return { ok: true, message: "Hook is already installed and up to date." };
  }

  const path = state.path;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderHook(invocation), { encoding: "utf8" });
    if (process.platform !== "win32") chmodSync(path, 0o755);
  } catch (error) {
    return {
      ok: false,
      message: `Could not write the hook to ${path}.`,
      hint: error instanceof Error ? error.message : String(error),
    };
  }

  const verb = state.kind === "ours" ? "updated" : "installed";
  return { ok: true, message: `pre-push hook ${verb} at ${path}` };
}

export function removeHook(git: GitRunner): HookActionResult {
  const state = readHookState(git);

  switch (state.kind) {
    case "no-repo":
      return { ok: false, message: "Not inside a git repository." };
    case "absent":
      return { ok: true, message: "No pre-push hook found — nothing to remove." };
    case "foreign":
      return {
        ok: false,
        message: `The pre-push hook at ${state.path} was not installed by pull-pal.`,
        hint: "Remove it manually if you no longer need it.",
      };
    case "ours":
      try {
        unlinkSync(state.path);
      } catch (error) {
        return {
          ok: false,
          message: `Could not remove ${state.path}.`,
          hint: error instanceof Error ? error.message : String(error),
        };
      }
      return { ok: true, message: "pre-push hook removed." };
  }
}
