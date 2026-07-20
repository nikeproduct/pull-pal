/**
 * The single place pull-pal spawns git.
 *
 * Everything above this module talks to the `GitRunner` interface, so unit tests
 * substitute a scripted fake and never need a real repository.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PassthroughOptions {
  /** Extra environment for the child (merged over process.env). */
  env?: Record<string, string>;
  /** Inherit stdin. Off by default so hook-mode never eats git's ref lines. */
  stdin?: boolean;
}

export interface GitRunner {
  /** Run git and capture output. Never throws on a non-zero exit. */
  capture(args: string[]): ExecResult;
  /** Run git with the user's terminal attached. Returns the exit code. */
  passthrough(args: string[], opts?: PassthroughOptions): number;
  /** Directory all commands run in. */
  readonly cwd: string;
}

const decoder = new TextDecoder();

export function createGitRunner(cwd: string): GitRunner {
  return {
    cwd,
    capture(args) {
      const r = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      return {
        stdout: decoder.decode(r.stdout).trim(),
        stderr: decoder.decode(r.stderr).trim(),
        exitCode: r.exitCode ?? 1,
      };
    },
    passthrough(args, opts = {}) {
      const r = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "inherit",
        stderr: "inherit",
        stdin: opts.stdin ? "inherit" : "ignore",
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
      });
      return r.exitCode ?? 1;
    },
  };
}
