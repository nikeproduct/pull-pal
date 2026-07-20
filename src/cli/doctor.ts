/**
 * `pull-pal doctor` — answers "what would pull-pal do here, and why?" without
 * touching anything. Every value it prints is one the push pipeline actually
 * uses, so it doubles as the debugging tool for surprising behaviour.
 */

import type { PullPalConfig } from "../config";
import type { TestPlan } from "../core/types";
import type { GitRunner } from "../git/exec";
import * as queries from "../git/queries";

export interface DoctorInput {
  version: string;
  git: GitRunner;
  config: PullPalConfig;
  detect: () => TestPlan | null;
  isRunnable: (command: string) => boolean;
  /** Rendered by M4's hook module; omitted when unavailable. */
  hookStatus?: string;
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(16)}${value}`;
}

export function renderDoctor(input: DoctorInput): string {
  const { git, config } = input;
  const out: string[] = [];

  out.push(`pull-pal ${input.version}`);
  const gitVersion = git.capture(["--version"]);
  out.push(line("git", gitVersion.exitCode === 0 ? gitVersion.stdout : "not found"));
  out.push("");

  const base = queries.readBaseState(git);
  out.push("Repository");
  if (!base.isRepo) {
    out.push(line("status", "not a git repository"));
    return out.join("\n");
  }

  out.push(line("root", base.root ?? "unknown"));
  out.push(line("branch", base.detached ? "(detached HEAD)" : (base.branch ?? "(unborn)")));
  out.push(line("remotes", base.remotes.length ? base.remotes.join(", ") : "none"));

  const upstream = queries.readUpstream(git);
  out.push(line("upstream", upstream ?? "none (would be set on first push)"));

  const remote = base.remotes.includes("origin") ? "origin" : (base.remotes[0] ?? "origin");
  const defaultBranch = base.remotes.length ? queries.resolveDefaultBranch(git, remote) : null;
  out.push(line("default branch", defaultBranch ? `${remote}/${defaultBranch}` : "undetermined"));

  out.push(line("working tree", base.dirty ? "modified (would autostash)" : "clean"));
  if (base.operationInProgress) {
    out.push(line("in progress", `${base.operationInProgress} — pull-pal would refuse to run`));
  }
  out.push("");

  out.push("Configuration");
  out.push(line("sync", config.syncPolicy));
  out.push(line("tests", config.testsEnabled ? "on" : "off"));
  out.push(line("testCommand", config.testCommand ?? "(auto-detect)"));
  out.push("");

  out.push("Tests");
  const plan = input.detect();
  if (!plan) {
    out.push(line("detected", "none"));
    out.push(line("", 'set one with: git config pullpal.testCommand "<command>"'));
  } else {
    out.push(line("detected", plan.label));
    out.push(line("source", plan.source));
    const runnable = plan.shell || input.isRunnable(plan.command);
    out.push(line("runnable", runnable ? "yes" : `no — "${plan.command}" is not on PATH`));
  }

  if (input.hookStatus) {
    out.push("");
    out.push("Hook");
    out.push(line("pre-push", input.hookStatus));
  }

  return out.join("\n");
}
