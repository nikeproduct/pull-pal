import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface TestRunner {
  command: string;
  args: string[];
  label: string;
}

function has(file: string): boolean {
  return existsSync(join(process.cwd(), file));
}

function hasDir(dir: string): boolean {
  const full = join(process.cwd(), dir);
  try {
    return existsSync(full) && Bun.file(full).size === 0
      ? false
      : existsSync(full);
  } catch {
    return existsSync(full);
  }
}

function fileContains(file: string, pattern: RegExp): boolean {
  try {
    return pattern.test(
      readFileSync(join(process.cwd(), file), "utf-8")
    );
  } catch {
    return false;
  }
}

export function detectTestRunner(): TestRunner | null {
  // Node / Bun
  if (has("package.json") && fileContains("package.json", /"test"\s*:/)) {
    const hasBun = Bun.which("bun") !== null;
    return hasBun
      ? { command: "bun", args: ["test"], label: "bun test" }
      : { command: "npm", args: ["test"], label: "npm test" };
  }

  // Rust
  if (has("Cargo.toml")) {
    return { command: "cargo", args: ["test"], label: "cargo test" };
  }

  // Go
  if (has("go.mod")) {
    return { command: "go", args: ["test", "./..."], label: "go test ./..." };
  }

  // Python
  if (
    has("pyproject.toml") ||
    has("pytest.ini") ||
    has("setup.py") ||
    has("setup.cfg")
  ) {
    return { command: "pytest", args: [], label: "pytest" };
  }

  // Java / Maven
  if (has("pom.xml")) {
    return { command: "mvn", args: ["test"], label: "mvn test" };
  }

  // Java / Gradle — prefer wrapper over system gradle
  if (has("gradlew") || has("build.gradle") || has("build.gradle.kts")) {
    const cmd = has("gradlew") ? "./gradlew" : "gradle";
    return { command: cmd, args: ["test"], label: `${cmd} test` };
  }

  // Make
  if (has("Makefile") && fileContains("Makefile", /^test\s*:/m)) {
    return { command: "make", args: ["test"], label: "make test" };
  }

  // Ruby — RSpec if spec/ dir exists, else Rake
  if (has("Gemfile")) {
    if (hasDir("spec")) {
      return {
        command: "bundle",
        args: ["exec", "rspec"],
        label: "bundle exec rspec",
      };
    }
    return {
      command: "bundle",
      args: ["exec", "rake", "test"],
      label: "bundle exec rake test",
    };
  }

  return null;
}
