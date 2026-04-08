interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function exec(cmd: string, args: string[]): ExecResult {
  const result = Bun.spawnSync([cmd, ...args], { cwd: process.cwd() });
  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
    exitCode: result.exitCode ?? 1,
  };
}

export function fetch(): void {
  const result = exec("git", ["fetch"]);
  if (result.exitCode !== 0) {
    throw new Error(`git fetch failed:\n${result.stderr}`);
  }
}

export function getDefaultBranch(): string {
  // Fast path: symbolic-ref works when `git remote set-head origin -a` has been run
  const symref = exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symref.exitCode === 0 && symref.stdout) {
    // "refs/remotes/origin/main" -> "main"
    return symref.stdout.replace("refs/remotes/origin/", "");
  }

  // Slower but reliable: query the remote directly
  const show = exec("git", ["remote", "show", "origin"]);
  if (show.exitCode === 0) {
    const match = show.stdout.match(/HEAD branch:\s+(.+)/);
    if (match) return match[1].trim();
  }

  return "main";
}

export function isBehind(defaultBranch: string): boolean {
  const result = exec("git", [
    "rev-list",
    `HEAD..origin/${defaultBranch}`,
    "--count",
  ]);
  if (result.exitCode !== 0) return false;
  return parseInt(result.stdout, 10) > 0;
}

export function rebase(defaultBranch: string): void {
  const result = exec("git", ["rebase", `origin/${defaultBranch}`]);
  if (result.exitCode !== 0) {
    throw new Error(`git rebase failed:\n${result.stderr}`);
  }
}

export function push(args: string[]): number {
  const result = Bun.spawnSync(["git", "push", ...args], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode ?? 1;
}
