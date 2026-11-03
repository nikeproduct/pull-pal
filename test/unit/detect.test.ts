import { describe, expect, test } from "bun:test";
import { type MemoryFs, createMemoryFsView } from "../../src/detect/fsview";
import { detectTestRunner } from "../../src/detect/index";
import { choosePackageManager } from "../../src/detect/node";

function detect(fsSpec: MemoryFs, opts: { platform?: NodeJS.Platform; override?: string } = {}) {
  return detectTestRunner(
    { fs: createMemoryFsView(fsSpec), platform: opts.platform ?? "linux" },
    { override: opts.override ?? null },
  );
}

const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "app", scripts: { test: "vitest run" }, ...extra });

describe("node", () => {
  // v0.1 ran `bun test`, Bun's built-in runner, which ignores scripts.test.
  test("invokes the package script, never bun's built-in runner", () => {
    const plan = detect({ files: { "package.json": pkg(), "bun.lockb": "" } });
    expect(plan?.command).toBe("bun");
    expect(plan?.args).toEqual(["run", "test"]);
    expect(plan?.label).toBe("bun run test");
  });

  test.each([
    ["bun.lockb", "bun", ["run", "test"]],
    ["bun.lock", "bun", ["run", "test"]],
    ["pnpm-lock.yaml", "pnpm", ["test"]],
    ["yarn.lock", "yarn", ["test"]],
    ["package-lock.json", "npm", ["test"]],
  ] as const)("picks %s → %s", (lockfile, command, args) => {
    const plan = detect({ files: { "package.json": pkg(), [lockfile]: "" } });
    expect(plan?.command).toBe(command);
    expect(plan?.args).toEqual([...args]);
  });

  test("an explicit packageManager field outranks lockfiles", () => {
    const plan = detect({
      files: { "package.json": pkg({ packageManager: "pnpm@9.1.0" }), "bun.lockb": "" },
    });
    expect(plan?.command).toBe("pnpm");
  });

  test("defaults to npm when the project gives no signal", () => {
    const plan = detect({ files: { "package.json": pkg() } });
    expect(plan?.command).toBe("npm");
  });

  // Detection must not depend on what the *developer* has installed.
  test("choosePackageManager reads only project files", () => {
    const fs = createMemoryFsView({ files: { "yarn.lock": "" } });
    expect(choosePackageManager(fs, {})).toBe("yarn");
    expect(choosePackageManager(fs, { packageManager: "bun@1.0.0" })).toBe("bun");
  });

  describe("false positives that blocked pushes in v0.1", () => {
    test("the npm-init placeholder counts as no test runner", () => {
      const plan = detect({
        files: {
          "package.json": JSON.stringify({
            scripts: { test: 'echo "Error: no test specified" && exit 1' },
          }),
        },
      });
      expect(plan).toBeNull();
    });

    test('a dependency named "test" is not a test script', () => {
      const plan = detect({
        files: { "package.json": JSON.stringify({ dependencies: { test: "^1.0.0" } }) },
      });
      expect(plan).toBeNull();
    });

    test("an empty or whitespace test script counts as none", () => {
      const plan = detect({
        files: { "package.json": JSON.stringify({ scripts: { test: "  " } }) },
      });
      expect(plan).toBeNull();
    });

    test("malformed package.json does not throw", () => {
      expect(() => detect({ files: { "package.json": "{not json" } })).not.toThrow();
      expect(detect({ files: { "package.json": "{not json" } })).toBeNull();
    });
  });
});

describe("other ecosystems", () => {
  test("rust", () => {
    const plan = detect({ files: { "Cargo.toml": "" } });
    expect(plan?.label).toBe("cargo test");
  });

  test("go", () => {
    const plan = detect({ files: { "go.mod": "" } });
    expect(plan?.args).toEqual(["test", "./..."]);
  });

  test("maven", () => {
    const plan = detect({ files: { "pom.xml": "" } });
    expect(plan?.command).toBe("mvn");
  });
});

describe("python", () => {
  test.each([
    ["pytest.ini", { "pytest.ini": "" }],
    ["pyproject with [tool.pytest]", { "pyproject.toml": "[tool.pytest.ini_options]\n" }],
    ["pyproject listing pytest as a dep", { "pyproject.toml": 'dev = ["pytest>=8"]\n' }],
    ["setup.cfg", { "setup.cfg": "[tool:pytest]\n" }],
    ["tox.ini", { "tox.ini": "[pytest]\n" }],
  ])("detects pytest from %s", (_name, files) => {
    expect(detect({ files })?.command).toBe("pytest");
  });

  // pytest exits 5 when it collects nothing; a project with no tests yet must
  // not be blocked from pushing.
  test("knows pytest's no-tests exit code", () => {
    expect(detect({ files: { "pytest.ini": "" } })?.noTestsExitCode).toBe(5);
  });

  // The root cause of v0.1's ENOENT crashes: pyproject.toml ≠ pytest.
  test("a pyproject.toml that never mentions pytest detects nothing", () => {
    const plan = detect({
      files: { "pyproject.toml": '[project]\nname = "app"\ndependencies = ["requests"]\n' },
    });
    expect(plan).toBeNull();
  });
});

describe("gradle", () => {
  test("prefers ./gradlew on posix", () => {
    const plan = detect({ files: { gradlew: "", "build.gradle": "" } }, { platform: "linux" });
    expect(plan?.command).toBe("./gradlew");
  });

  // v0.1 emitted ./gradlew on Windows, which cannot execute.
  test("uses gradlew.bat on windows", () => {
    const plan = detect(
      { files: { "gradlew.bat": "", "build.gradle": "" } },
      { platform: "win32" },
    );
    expect(plan?.command).toBe("./gradlew.bat");
  });

  // Repo-relative, so it is resolved against the repo root rather than looked
  // up on PATH — where a bare gradlew.bat is never found.
  test("the wrapper is marked as living in the repository", () => {
    expect(detect({ files: { gradlew: "" } }, { platform: "linux" })?.command).toBe("./gradlew");
  });

  test("falls back to system gradle without a wrapper", () => {
    const plan = detect({ files: { "build.gradle.kts": "" } });
    expect(plan?.command).toBe("gradle");
  });
});

describe("make", () => {
  test.each([
    ["test:", true],
    ["test :", true],
    ["test::", true],
    ["test:\n\techo hi", true],
    // Assignments are not targets — v0.1's regex matched all of these.
    ["test := unit", false],
    ["test ::= unit", false],
    ["test = unit", false],
    ["testdata: foo", false],
  ])("Makefile content %p → detected: %p", (content, expected) => {
    const plan = detect({ files: { Makefile: `${content}\n` } });
    expect(plan !== null).toBe(expected);
    if (expected) expect(plan?.command).toBe("make");
  });

  test("finds a target that is not on the first line", () => {
    const plan = detect({ files: { Makefile: "build:\n\tgo build\n\ntest:\n\tgo test\n" } });
    expect(plan?.label).toBe("make test");
  });
});

describe("ruby", () => {
  test("uses rspec when spec/ is a directory", () => {
    const plan = detect({ files: { Gemfile: "" }, dirs: ["spec"] });
    expect(plan?.label).toBe("bundle exec rspec");
  });

  const RAKEFILE =
    'require "rake/testtask"\nRake::TestTask.new do |t|\n  t.pattern = "test/**/*_test.rb"\nend\n';

  // v0.1's hasDir never checked isDirectory, so a *file* named spec chose rspec.
  test("a file named spec does not select rspec", () => {
    const plan = detect({ files: { Gemfile: "", spec: "not a directory", Rakefile: RAKEFILE } });
    expect(plan?.label).toBe("bundle exec rake test");
  });

  // Bundler for tooling only (fastlane, Jekyll): rake test would fail every push.
  test("a Gemfile alone is not a test suite", () => {
    expect(detect({ files: { Gemfile: "" } })).toBeNull();
  });

  test("a Rakefile without a test task is not one either", () => {
    expect(detect({ files: { Gemfile: "", Rakefile: "task :build do\nend\n" } })).toBeNull();
  });

  test.each([
    ["Rake::TestTask", RAKEFILE],
    ["task :test", "task :test do\n  sh 'ruby -Itest test/all.rb'\nend\n"],
    ['task "test"', 'task "test" do\nend\n'],
    ["task test: [...]", "task test: [:compile]\n"],
    ["a Rails app", 'require_relative "config/application"\nRails.application.load_tasks\n'],
  ])("runs rake test for %s", (_, rakefile) => {
    const plan = detect({ files: { Gemfile: "", Rakefile: rakefile } });
    expect(plan?.label).toBe("bundle exec rake test");
  });
});

describe("priority and overrides", () => {
  test("git config override beats every detector", () => {
    const plan = detect(
      { files: { "package.json": pkg(), "Cargo.toml": "" } },
      {
        override: "make check",
      },
    );
    expect(plan?.label).toBe("make check");
    expect(plan?.shell).toBe(true);
    expect(plan?.source).toBe("config:pullpal.testCommand");
  });

  test("override runs through the platform shell", () => {
    expect(detect({ files: {} }, { override: "a && b", platform: "linux" })?.args).toEqual([
      "-c",
      "a && b",
    ]);
    // /s strips only the outer quotes, so quotes inside the command survive.
    expect(
      detect({ files: {} }, { override: 'npm test -- --grep "my suite"', platform: "win32" })?.args,
    ).toEqual(["/d", "/s", "/c", '"npm test -- --grep "my suite""']);
  });

  test("a package.json pull-pal.test block overrides detection", () => {
    const plan = detect({
      files: { "package.json": pkg({ "pull-pal": { test: "npm run verify" } }) },
    });
    expect(plan?.label).toBe("npm run verify");
    expect(plan?.source).toBe("package.json:pull-pal.test");
  });

  test("package.json wins over Cargo.toml when both exist", () => {
    const plan = detect({ files: { "package.json": pkg(), "Cargo.toml": "" } });
    expect(plan?.command).toBe("npm");
  });

  test("an empty project detects nothing", () => {
    expect(detect({ files: {} })).toBeNull();
  });

  test("every plan reports which detector produced it", () => {
    expect(detect({ files: { "Cargo.toml": "" } })?.source).toBe("rust:cargo");
    expect(detect({ files: { "go.mod": "" } })?.source).toBe("go:modules");
    expect(detect({ files: { Gemfile: "", Rakefile: "task :test\n" } })?.source).toBe("ruby:rake");
  });
});
