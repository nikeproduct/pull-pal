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
  if (fs.exists("pytest.ini")) return plan("pytest", [], "python:pytest.ini");

  const pyproject = fs.read("pyproject.toml");
  if (pyproject && /\[tool\.pytest|(?:^|["'\s,=[])pytest\b/m.test(pyproject)) {
    return plan("pytest", [], "python:pyproject");
  }

  const setupCfg = fs.read("setup.cfg");
  if (setupCfg && /\[tool:pytest\]/.test(setupCfg)) {
    return plan("pytest", [], "python:setup.cfg");
  }

  const tox = fs.read("tox.ini");
  if (tox && /\[pytest\]/.test(tox)) {
    return plan("pytest", [], "python:tox.ini");
  }

  return null;
}

export function detectMaven({ fs }: DetectContext): TestPlan | null {
  return fs.exists("pom.xml") ? plan("mvn", ["-q", "test"], "java:maven") : null;
}

/** Gradle, preferring the wrapper — which is `gradlew.bat` on Windows. */
export function detectGradle({ fs, platform }: DetectContext): TestPlan | null {
  const wrapper = platform === "win32" ? "gradlew.bat" : "gradlew";
  if (fs.exists(wrapper)) {
    const command = platform === "win32" ? wrapper : `./${wrapper}`;
    return plan(command, ["test"], "java:gradle-wrapper");
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

/** Ruby: RSpec when a spec *directory* exists, else rake. */
export function detectRuby({ fs }: DetectContext): TestPlan | null {
  if (!fs.exists("Gemfile")) return null;
  if (fs.isDirectory("spec")) {
    return plan("bundle", ["exec", "rspec"], "ruby:rspec");
  }
  return plan("bundle", ["exec", "rake", "test"], "ruby:rake");
}
