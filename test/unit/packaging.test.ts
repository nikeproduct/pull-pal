/**
 * Cross-manifest consistency.
 *
 * v0.1's distribution broke in the gaps *between* files: the formula installed a
 * binary name the tarball did not contain, the launcher named packages nobody
 * published, and version numbers drifted across five manifests. None of that is
 * visible from inside any single file, so these tests read them together.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;

const PLATFORMS = [
  { dir: "darwin-arm64", pkg: "@nikeproduct/pull-pal-darwin-arm64", bin: "pull-pal", os: "darwin" },
  { dir: "darwin-x64", pkg: "@nikeproduct/pull-pal-darwin-x64", bin: "pull-pal", os: "darwin" },
  { dir: "linux-x64", pkg: "@nikeproduct/pull-pal-linux-x64", bin: "pull-pal", os: "linux" },
  { dir: "win32-x64", pkg: "@nikeproduct/pull-pal-win32-x64", bin: "pull-pal.exe", os: "win32" },
] as const;

interface PackageJson {
  name?: string;
  version: string;
  bin?: Record<string, string>;
  files?: string[];
  os?: string[];
  cpu?: string[];
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const rootPkg = readJson<PackageJson>("package.json");

describe("version consistency", () => {
  // check-version enforces this in CI too; asserting it here means a drifted
  // version fails the suite rather than only the release.
  test.each([
    ["npm/package.json", () => readJson<PackageJson>("npm/package.json").version],
    ["src/version.ts", () => read("src/version.ts").match(/VERSION = "([^"]+)"/)?.[1]],
    [
      "python/pyproject.toml",
      () => read("python/pyproject.toml").match(/^version = "([^"]+)"/m)?.[1],
    ],
    [
      "python/pull_pal/cli.py",
      () => read("python/pull_pal/cli.py").match(/^VERSION = "([^"]+)"/m)?.[1],
    ],
    [
      "python/pull_pal/__init__.py",
      () => read("python/pull_pal/__init__.py").match(/"([^"]+)"/)?.[1],
    ],
    [
      "Formula/pull-pal.rb",
      () => read("Formula/pull-pal.rb").match(/^ {2}version "([^"]+)"/m)?.[1],
    ],
  ])("%s matches the root package.json", (_file, extract) => {
    expect(extract()).toBe(rootPkg.version);
  });

  for (const { dir } of PLATFORMS) {
    test(`${dir} platform package matches`, () => {
      expect(readJson<PackageJson>(`npm-packages/${dir}/package.json`).version).toBe(
        rootPkg.version,
      );
    });
  }

  test("the npm shim pins its platform packages to the same version", () => {
    const deps = readJson<PackageJson>("npm/package.json").optionalDependencies ?? {};
    for (const version of Object.values(deps)) {
      expect(version).toBe(rootPkg.version);
    }
  });
});

describe("npm packaging", () => {
  const shim = readJson<PackageJson>("npm/package.json");

  test("the shim declares every platform package as optional", () => {
    expect(Object.keys(shim.optionalDependencies ?? {}).sort()).toEqual(
      PLATFORMS.map((p) => p.pkg).sort(),
    );
  });

  for (const { dir, pkg, os, bin } of PLATFORMS) {
    test(`${pkg} is constrained to its own platform`, () => {
      const manifest = readJson<PackageJson>(`npm-packages/${dir}/package.json`);
      expect(manifest.name).toBe(pkg);
      expect(manifest.os).toEqual([os]);
      // Shipping the binary is the entire purpose of the package.
      expect(manifest.files).toContain(bin);
    });
  }

  test.each(["npm/run.js", "npm/install.js"])("%s knows every platform package", (file) => {
    const source = read(file);
    for (const { pkg } of PLATFORMS) {
      expect(source).toContain(pkg);
    }
  });

  test("the launcher resolves the right binary name per platform", () => {
    const source = read("npm/run.js");
    expect(source).toContain("pull-pal.exe");
    expect(source).toContain("win32");
  });

  test("the launcher tags its install source for analytics", () => {
    expect(read("npm/run.js")).toContain("PULLPAL_INSTALL_SOURCE");
  });

  test("published files exist in the shim's file list", () => {
    expect(shim.files).toEqual(expect.arrayContaining(["run.js", "install.js"]));
    expect(shim.bin).toEqual({ "pull-pal": "run.js" });
  });
});

describe("homebrew formula", () => {
  const formula = read("Formula/pull-pal.rb");

  // The v0.1 formula installed "pull-pal" from a tarball whose only member was
  // "pull-pal-darwin-arm64", so `brew install` failed for everyone.
  test("installs the binary name the build actually puts in the tarball", () => {
    expect(formula).toContain('bin.install "pull-pal"');
    expect(read("scripts/build.ts")).toContain('const POSIX_BIN = "pull-pal"');
  });

  test("points at both macOS tarballs", () => {
    expect(formula).toContain("pull-pal-darwin-arm64.tar.gz");
    expect(formula).toContain("pull-pal-darwin-x64.tar.gz");
  });

  test("its checksums are placeholders that the release workflow must fill", () => {
    const placeholders = formula.match(/REPLACED_ON_RELEASE/g) ?? [];
    expect(placeholders).toHaveLength(2);
    expect(read(".github/workflows/release.yml")).toContain("REPLACED_ON_RELEASE_DARWIN_ARM64");
  });
});

describe("python packaging", () => {
  test("the release URL is derived from the declared version", () => {
    const cli = read("python/pull_pal/cli.py");
    expect(cli).toContain(
      'RELEASE_BASE = f"https://github.com/{GITHUB_REPO}/releases/download/v{VERSION}"',
    );
  });

  test("the launcher verifies what it downloads", () => {
    const cli = read("python/pull_pal/cli.py");
    expect(cli).toContain("hashlib.sha256");
    expect(cli).toContain("checksum verification");
    // Atomic install: never leave a half-written executable in the cache.
    expect(cli).toContain("os.replace");
    expect(cli).toContain("DOWNLOAD_TIMEOUT_SECONDS");
  });

  test("the wheel is configured to ship the checksum manifest", () => {
    // It is git-ignored, so hatchling would otherwise drop it silently.
    expect(read("python/pyproject.toml")).toContain('artifacts = ["pull_pal/SHA256SUMS"]');
  });

  test("the readme pyproject declares actually exists", () => {
    expect(read("python/pyproject.toml")).toContain('readme = "README.md"');
    expect(read("python/README.md")).toContain("pull-pal");
  });
});

describe("repository hygiene", () => {
  test("a LICENSE exists and matches what the manifests claim", () => {
    expect(read("LICENSE")).toContain("MIT License");
    expect(rootPkg.version).toBeTruthy();
    expect(readJson<PackageJson>("npm/package.json").name).toBe("pull-pal");
  });

  test("generated artifacts are not committed", () => {
    const ignore = read(".gitignore");
    for (const path of ["dist/", "node_modules/", "python/pull_pal/SHA256SUMS"]) {
      expect(ignore).toContain(path);
    }
  });

  test("there is exactly one build path", () => {
    // v0.1 had build.sh and build.ts; only one of them embedded the version.
    expect(rootPkg.scripts?.build).toBe("bun run scripts/build.ts");
    expect(rootPkg.scripts?.["build:sh"]).toBeUndefined();
  });
});
