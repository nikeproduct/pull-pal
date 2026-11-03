/**
 * Per-ecosystem detectors. Each is a pure function of the project view (plus the
 * platform, where the tooling differs) and returns null when it does not apply.
 */

import type { TestPlan } from "../core/types";
import type { FsView } from "./fsview";

export interface DetectContext {
  fs: FsView;
  platform: NodeJS.Platform;
}

function plan(
  command: string,
  args: string[],
  source: string,
  label = `${command} ${args.join(" ")}`.trim(),
): TestPlan {
  return { command, args, label, source };
}

/** pytest exits 5 when it collects no tests — a project without tests yet. */
function pytest(source: string): TestPlan {
  return { ...plan("pytest", [], source), noTestsExitCode: 5 };
}

export function detectRust({ fs }: DetectContext): TestPlan | null {
  return fs.exists("Cargo.toml") ? plan("cargo", ["test"], "rust:cargo") : null;
}

export function detectGo({ fs }: DetectContext): TestPlan | null {
  return fs.exists("go.mod") ? plan("go", ["test", "./..."], "go:modules") : null;
}

/**
 * Python, but only when pytest is actually declared.
 *
 * v0.1 treated the mere presence of pyproject.toml as "run pytest", which is
 * wrong for unittest/tox/nox projects and for machines without pytest installed —
 * where it crashed with ENOENT and blocked the push.
 */
export function detectPython({ fs }: DetectContext): TestPlan | null {
  if (fs.exists("pytest.ini")) return pytest("python:pytest.ini");

  const pyproject = fs.read("pyproject.toml");
  if (pyproject && /\[tool\.pytest|(?:^|["'\s,=[])pytest\b/m.test(pyproject)) {
    return pytest("python:pyproject");
  }

  const setupCfg = fs.read("setup.cfg");
  if (setupCfg && /\[tool:pytest\]/.test(setupCfg)) {
    return pytest("python:setup.cfg");
  }

  const tox = fs.read("tox.ini");
  if (tox && /\[pytest\]/.test(tox)) {
    return pytest("python:tox.ini");
  }

  return null;
}

export function detectMaven({ fs }: DetectContext): TestPlan | null {
  return fs.exists("pom.xml") ? plan("mvn", ["-q", "test"], "java:maven") : null;
}

/**
 * Gradle, preferring the wrapper — which is `gradlew.bat` on Windows. The `./`
 * marks it as living in the repository: it is resolved against the repo root,
 * never looked up on PATH.
 */
export function detectGradle({ fs, platform }: DetectContext): TestPlan | null {
  const wrapper = platform === "win32" ? "gradlew.bat" : "gradlew";
  if (fs.exists(wrapper)) {
    return plan(`./${wrapper}`, ["test"], "java:gradle-wrapper");
  }
  if (fs.exists("build.gradle") || fs.exists("build.gradle.kts")) {
    return plan("gradle", ["test"], "java:gradle");
  }
  return null;
}

/**
 * A Makefile with a real `test` target.
 *
 * The negative lookahead rejects make's assignment operators, so `test := unit`
 * is not mistaken for a target the way v0.1's `/^test\s*:/m` did.
 */
const MAKE_TEST_TARGET = /^test[ \t]*:(?!:?=)/m;

export function detectMake({ fs }: DetectContext): TestPlan | null {
  const makefile = fs.read("Makefile") ?? fs.read("makefile");
  if (makefile && MAKE_TEST_TARGET.test(makefile)) {
    return plan("make", ["test"], "make:target");
  }
  return null;
}

/**
 * A Rakefile that defines a `test` task: `Rake::TestTask` (which names its task
 * "test" by default), an explicit `task :test` / `task "test"` / `task test:`,
 * or a Rails app, whose `load_tasks` provides one.
 */
const RAKE_TEST_TASK =
  /Rake::TestTask|\btask\s*\(?\s*(?::test\b|["']test["']|test:)|\.load_tasks\b/;

/**
 * Ruby: RSpec when a spec *directory* exists, else `rake test` — but only when
 * the Rakefile has a test task. A Gemfile alone often means Bundler for tooling
 * (fastlane, Jekyll), where `rake test` fails and would block every push.
 */
export function detectRuby({ fs }: DetectContext): TestPlan | null {
  if (!fs.exists("Gemfile")) return null;
  if (fs.isDirectory("spec")) {
    return plan("bundle", ["exec", "rspec"], "ruby:rspec");
  }
  const rakefile = fs.read("Rakefile") ?? fs.read("rakefile") ?? fs.read("Rakefile.rb");
  if (rakefile && RAKE_TEST_TASK.test(rakefile)) {
    return plan("bundle", ["exec", "rake", "test"], "ruby:rake");
  }
  return null;
}
