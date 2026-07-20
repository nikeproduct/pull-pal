/**
 * Integration-test fixtures: real git, real temp dirs.
 *
 * `makeRepo()` builds a working clone wired to a local bare "remote", seeded
 * with one commit on the default branch and pushed. Tests then diverge from
 * that state and run the real pull-pal pipeline against real git.
 *
 * Everything is created under the OS temp dir and torn down by `cleanup()`
 * (call it in `afterEach`, or use `withRepo()` which cleans up for you).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the pull-pal entry point, run via `bun`. */
export const ENTRY = join(HERE, "..", "..", "src", "index.ts");

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** Extra argv passed before pull-pal's args (unused today; reserved). */
  cwd?: string;
}

export interface Fixture {
  /** The working clone — the "current repo" pull-pal runs inside. */
  dir: string;
  /** The bare remote this clone pushes to. */
  remoteDir: string;
  /** Run a raw git command inside the working clone. */
  git(args: string[]): ExecResult;
  /** Write a file (relative to the clone), creating parent dirs. */
  writeFile(rel: string, content: string): void;
  /** Stage `files` (path → content), commit, return the new HEAD sha. */
  commit(message: string, files?: Record<string, string>): string;
  /** Resolve a ref to a full sha (default: HEAD). */
  sha(ref?: string): string;
  /** Current checked-out branch name. */
  currentBranch(): string;
  /** Advance a branch on the *remote* by one commit, as if a teammate pushed. */
  advanceRemote(branch?: string, message?: string): string;
  /** Run the compiled-from-source pull-pal against this clone. */
  runPullPal(args: string[], opts?: RunOptions): Promise<ExecResult>;
  /** Remove all temp dirs. Safe to call twice. */
  cleanup(): void;
}

function decode(buf: Buffer | null): string {
  return buf ? buf.toString("utf8") : "";
}

function git(cwd: string, args: string[]): ExecResult {
  const r = spawnSync("git", args, { cwd, encoding: "buffer" });
  if (r.error) throw r.error;
  return {
    stdout: decode(r.stdout).trim(),
    stderr: decode(r.stderr).trim(),
    exitCode: r.status ?? 1,
  };
}

function gitOrThrow(cwd: string, args: string[]): ExecResult {
  const r = git(cwd, args);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr || r.stdout}`);
  }
  return r;
}

/** Configure a repo with a deterministic identity so commits never depend on global config. */
function configureIdentity(cwd: string): void {
  gitOrThrow(cwd, ["config", "user.email", "test@pull-pal.dev"]);
  gitOrThrow(cwd, ["config", "user.name", "Pull Pal Test"]);
  // Keep autocrlf off so file content hashes are stable across platforms.
  gitOrThrow(cwd, ["config", "core.autocrlf", "false"]);
  gitOrThrow(cwd, ["config", "commit.gpgsign", "false"]);
}

function seedCommit(cwd: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  gitOrThrow(cwd, ["add", "-A"]);
  gitOrThrow(cwd, ["commit", "-m", "seed"]);
  return git(cwd, ["rev-parse", "HEAD"]).stdout;
}

export interface MakeRepoOptions {
  /** Default branch name for the seeded remote. Default "main". */
  defaultBranch?: string;
}

export function makeRepo(opts: MakeRepoOptions = {}): Fixture {
  const defaultBranch = opts.defaultBranch ?? "main";
  const root = mkdtempSync(join(tmpdir(), "pullpal-"));
  const remoteDir = join(root, "remote.git");
  const dir = join(root, "work");

  // Bare remote with a known default branch.
  gitOrThrow(root, ["init", "--bare", "--initial-branch", defaultBranch, remoteDir]);

  // Clone, identify, seed one commit, push to establish origin/<default>.
  gitOrThrow(root, ["clone", "--quiet", remoteDir, dir]);
  configureIdentity(dir);
  // Ensure the working branch matches the remote's default (older git clones detached).
  git(dir, ["checkout", "-B", defaultBranch]);
  seedCommit(dir, { "README.md": "# fixture\n" });
  gitOrThrow(dir, ["push", "--quiet", "-u", "origin", defaultBranch]);
  // Record origin/HEAD locally the way a normal clone would.
  git(dir, ["remote", "set-head", "origin", defaultBranch]);

  const fixture: Fixture = {
    dir,
    remoteDir,
    git: (args) => git(dir, args),
    writeFile(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    },
    commit(message, files = {}) {
      for (const [rel, content] of Object.entries(files)) {
        fixture.writeFile(rel, content);
      }
      gitOrThrow(dir, ["add", "-A"]);
      gitOrThrow(dir, ["commit", "--allow-empty", "-m", message]);
      return git(dir, ["rev-parse", "HEAD"]).stdout;
    },
    sha: (ref = "HEAD") => git(dir, ["rev-parse", ref]).stdout,
    currentBranch: () => git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout,
    advanceRemote(branch = defaultBranch, message = "remote advance") {
      const scratch = mkdtempSync(join(root, "advance-"));
      gitOrThrow(root, ["clone", "--quiet", "--branch", branch, remoteDir, scratch]);
      configureIdentity(scratch);
      writeFileSync(join(scratch, `remote-${Date.now()}.txt`), message, "utf8");
      gitOrThrow(scratch, ["add", "-A"]);
      gitOrThrow(scratch, ["commit", "-m", message]);
      const sha = git(scratch, ["rev-parse", "HEAD"]).stdout;
      gitOrThrow(scratch, ["push", "--quiet", "origin", branch]);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
      return sha;
    },
    async runPullPal(args, runOpts = {}) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...process.env, ...runOpts.env })) {
        if (v !== undefined) env[k] = v;
      }
      const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
        cwd: dir,
        env,
        stdin: runOpts.stdin !== undefined ? new TextEncoder().encode(runOpts.stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };

  return fixture;
}

/** Run `fn` with a fresh repo, guaranteeing cleanup even on failure. */
export async function withRepo<T>(
  fn: (repo: Fixture) => Promise<T> | T,
  opts?: MakeRepoOptions,
): Promise<T> {
  const repo = makeRepo(opts);
  try {
    return await fn(repo);
  } finally {
    repo.cleanup();
  }
}
