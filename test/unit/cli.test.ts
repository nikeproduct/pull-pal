import { describe, expect, test } from "bun:test";
import { FLAGS, type ParsedFlags, parseArgs, toRunOptions } from "../../src/cli/args";
import { renderHelp } from "../../src/cli/help";
import { DEFAULT_CONFIG } from "../../src/config";

/** Parse and assert we got a push command, returning its flags. */
function pushFlags(argv: string[]): ParsedFlags {
  const { command } = parseArgs(argv);
  if (command.kind !== "push") throw new Error(`expected push, got ${command.kind}`);
  return command.flags;
}

describe("subcommands", () => {
  test.each([
    ["setup", "setup"],
    ["remove-hook", "remove-hook"],
    ["doctor", "doctor"],
  ] as const)("%s", (arg, kind) => {
    expect(parseArgs([arg]).command.kind).toBe(kind);
  });

  test.each([
    [["analytics", "on"], "on"],
    [["analytics", "off"], "off"],
    [["analytics"], "status"],
    [["analytics", "nonsense"], "status"],
  ] as const)("analytics %p", (argv, mode) => {
    const { command } = parseArgs([...argv]);
    expect(command).toEqual({ kind: "analytics", mode });
  });

  test("a subcommand is only recognised in first position", () => {
    // `git push origin setup` must still work.
    expect(pushFlags(["origin", "setup"]).gitArgs).toEqual(["origin", "setup"]);
  });
});

describe("pull-pal's own flags", () => {
  test("defaults: sync and tests on, nothing forwarded", () => {
    expect(pushFlags([])).toEqual({
      sync: true,
      tests: true,
      dryRun: false,
      hookMode: false,
      retest: false,
      gitArgs: [],
    });
  });

  // Defect 9: v0.1's --no-rebase still fetched, contradicting its own docs.
  test("--no-sync turns off fetch and rebase together", () => {
    expect(pushFlags(["--no-sync"]).sync).toBe(false);
  });

  test("--no-rebase still works but warns about the rename", () => {
    const { command, warnings } = parseArgs(["--no-rebase"]);
    expect(command.kind === "push" && command.flags.sync).toBe(false);
    expect(warnings[0]).toContain("--no-rebase is deprecated");
  });

  test.each([
    ["--no-tests", "tests", false],
    ["--dry-run", "dryRun", true],
    ["--hook-mode", "hookMode", true],
    ["--retest", "retest", true],
  ] as const)("%s sets %s", (flag, key, value) => {
    expect(pushFlags([flag])[key]).toBe(value);
  });

  test("--help and --version become their own commands", () => {
    expect(parseArgs(["--help"]).command.kind).toBe("help");
    expect(parseArgs(["--version"]).command.kind).toBe("version");
  });

  test("pull-pal flags are consumed, never forwarded to git", () => {
    expect(pushFlags(["--no-sync", "--no-tests", "--dry-run", "origin"]).gitArgs).toEqual([
      "origin",
    ]);
  });
});

describe("git passthrough", () => {
  // Defect 16: v0.1 claimed -v and -h, so they could never reach git push.
  test.each([["-v"], ["-h"], ["-f"], ["--verbose"], ["--tags"]])(
    "%s belongs to git, not pull-pal",
    (flag) => {
      const flags = pushFlags([flag]);
      expect(flags.gitArgs).toEqual([flag]);
    },
  );

  test("unknown long flags pass through untouched", () => {
    expect(pushFlags(["--follow-tags", "--atomic"]).gitArgs).toEqual(["--follow-tags", "--atomic"]);
  });

  test("positional arguments pass through in order", () => {
    expect(pushFlags(["origin", "my-branch"]).gitArgs).toEqual(["origin", "my-branch"]);
  });

  test("-- forwards everything after it, including pull-pal's own flag names", () => {
    const flags = pushFlags(["--no-tests", "--", "--dry-run", "--no-sync"]);
    expect(flags.tests).toBe(false);
    expect(flags.dryRun).toBe(false);
    expect(flags.gitArgs).toEqual(["--", "--dry-run", "--no-sync"]);
  });

  test("--help after -- is git's, not ours", () => {
    const { command } = parseArgs(["--", "--help"]);
    expect(command.kind).toBe("push");
  });

  test("flag order is preserved for git", () => {
    expect(pushFlags(["--tags", "origin", "--atomic"]).gitArgs).toEqual([
      "--tags",
      "origin",
      "--atomic",
    ]);
  });
});

describe("toRunOptions", () => {
  const flags = (over: Partial<ParsedFlags> = {}): ParsedFlags => ({
    sync: true,
    tests: true,
    dryRun: false,
    hookMode: false,
    retest: false,
    gitArgs: [],
    ...over,
  });

  const config = { ...DEFAULT_CONFIG };

  test("config supplies the sync policy and conflict mode", () => {
    const opts = toRunOptions(flags(), { ...config, syncPolicy: "upstream", onConflict: "warn" });
    expect(opts.syncPolicy).toBe("upstream");
    expect(opts.onConflict).toBe("warn");
  });

  test("--no-tests overrides config that enables tests", () => {
    expect(toRunOptions(flags({ tests: false }), config).tests).toBe(false);
  });

  test("config can disable tests without a flag", () => {
    expect(toRunOptions(flags(), { ...config, testsEnabled: false }).tests).toBe(false);
  });

  test("the test cache is on by default; --retest or config turns it off", () => {
    expect(toRunOptions(flags(), config).useTestCache).toBe(true);
    expect(toRunOptions(flags({ retest: true }), config).useTestCache).toBe(false);
    expect(toRunOptions(flags(), { ...config, testCache: false }).useTestCache).toBe(false);
  });
});

describe("help text", () => {
  const help = renderHelp("9.9.9");

  test("documents every non-hidden flag, and no hidden ones", () => {
    for (const flag of FLAGS) {
      if (flag.hidden) {
        expect(help).not.toContain(flag.name);
      } else {
        expect(help).toContain(flag.name);
      }
    }
  });

  test("mentions the deprecated alias so existing users can find it", () => {
    expect(help).toContain("--no-rebase");
  });

  test("includes the version it was rendered with", () => {
    expect(help).toContain("9.9.9");
  });

  test("documents the config keys the code actually reads", () => {
    expect(help).toContain("pullpal.sync");
    expect(help).toContain("pullpal.tests");
    expect(help).toContain("pullpal.testCommand");
    expect(help).toContain("pullpal.onConflict");
    expect(help).toContain("pullpal.testCache");
    expect(help).toContain("pullpal.longLived");
    expect(help).toContain("pullpalBase");
  });
});
