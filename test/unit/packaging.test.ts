/**
 * Cross-manifest consistency.
 *
 * v0.1's distribution broke in the gaps *between* files: the formula installed a
 * binary name the tarball did not contain, the launcher named packages nobody
 * published, and version numbers drifted across five manifests. None of that is
 * visible from inside any single file, so these tests read them together.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORMS as SHIPPED, npmPackageName } from "../../scripts/platforms";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;

// scripts/platforms.ts is the one list; everything below is checked against it.
const PLATFORMS = SHIPPED.map((p) => ({
  dir: p.key,
  pkg: npmPackageName(p),
  bin: p.bin,
  os: p.key.slice(0, p.key.indexOf("-")),
}));

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
      expect(manifest.cpu).toEqual([dir.slice(dir.indexOf("-") + 1)]);
      // Shipping the binary is the entire purpose of the package.
      expect(manifest.files).toContain(bin);
    });
  }

  test.each(["scripts/build.ts", "scripts/publish-npm.ts", "scripts/set-version.ts"])(
    "%s takes its platforms from the shared list",
    (file) => {
      expect(read(file)).toContain('import { PLATFORMS } from "./platforms"');
    },
  );

  test("every platform has a package directory, and its binary is never committed", () => {
    for (const { dir } of PLATFORMS) {
      expect(readJson<PackageJson>(`npm-packages/${dir}/package.json`).name).toBeDefined();
    }
    const ignore = read(".gitignore");
    expect(ignore).toContain("npm-packages/*/pull-pal\n");
    expect(ignore).toContain("npm-packages/*/pull-pal.exe\n");
  });

  // The launcher cannot import scripts/, so it reads the same list from the
  // optionalDependencies that ship beside it — checked against PLATFORMS above.
  test.each(["npm/run.js", "npm/install.js"])(
    "%s derives its platforms from package.json",
    (file) => {
      const source = read(file);
      expect(source).toContain('require("./package.json").optionalDependencies');
      expect(source).toContain("`@nikeproduct/pull-pal-${platform}-${arch}`");
    },
  );

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

describe("dropped channels", () => {
  // pip was never published; it shipped a downloader for a binary npm already
  // delivers. It can come back when someone asks for it.
  test("nothing still builds, versions, or releases a pip package", () => {
    for (const file of ["scripts/build.ts", "scripts/set-version.ts", ".github/workflows/ci.yml"]) {
      expect(read(file)).not.toMatch(/python|pypi/i);
    }
    expect(read(".github/workflows/release.yml")).not.toContain("twine");
  });

  // npm is the one install channel. The formula was never kept current (the tap
  // it targeted did not exist), so it is gone rather than left to rot.
  test("nothing still builds, versions, or releases a Homebrew formula", () => {
    expect(existsSync(join(ROOT, "Formula"))).toBe(false);
    for (const file of [
      "scripts/build.ts",
      "scripts/set-version.ts",
      ".github/workflows/release.yml",
    ]) {
      expect(read(file)).not.toMatch(/homebrew|tarball|Formula\//i);
    }
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
    for (const path of ["dist/", "node_modules/"]) {
      expect(ignore).toContain(path);
    }
  });

  test("there is exactly one build path", () => {
    // v0.1 had build.sh and build.ts; only one of them embedded the version.
    expect(rootPkg.scripts?.build).toBe("bun run scripts/build.ts");
    expect(rootPkg.scripts?.["build:sh"]).toBeUndefined();
  });
});
