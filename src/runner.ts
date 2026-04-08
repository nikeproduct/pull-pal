export interface RunResult {
  exitCode: number;
}

export async function runTests(
  command: string,
  args: string[]
): Promise<RunResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const exitCode = await proc.exited;
  return { exitCode };
}
