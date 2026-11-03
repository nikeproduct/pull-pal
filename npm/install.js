#!/usr/bin/env node
"use strict";

const { chmodSync } = require("fs");
const { join, dirname } = require("path");
const os = require("os");

const platform = os.platform();
const arch = os.arch();

// One platform package per optionalDependency, named @nikeproduct/pull-pal-<platform>-<arch>.
const PACKAGES = Object.keys(require("./package.json").optionalDependencies || {});

try {
  const pkgName = `@nikeproduct/pull-pal-${platform}-${arch}`;
  if (!PACKAGES.includes(pkgName)) {
    console.warn(`[pull-pal] Unsupported platform ${platform}/${arch} — skipping binary setup.`);
    process.exit(0);
  }

  const binaryName = platform === "win32" ? "pull-pal.exe" : "pull-pal";
  const pkgDir = dirname(require.resolve(`${pkgName}/package.json`));
  const binaryPath = join(pkgDir, binaryName);

  if (platform !== "win32") {
    chmodSync(binaryPath, 0o755);
  }

  console.log(`[pull-pal] Ready (${pkgName})`);
} catch (err) {
  // Non-fatal: optional dependency may not be installed in unsupported environments
  console.warn(`[pull-pal] postinstall warning: ${err.message}`);
  process.exit(0);
}
