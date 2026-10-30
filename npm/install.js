#!/usr/bin/env node
"use strict";

const { chmodSync } = require("fs");
const { join, dirname } = require("path");
const os = require("os");

const platform = os.platform();
const arch = os.arch();

const PLATFORM_PACKAGES = {
  "darwin-arm64": "@nikeproduct/pull-pal-darwin-arm64",
  "darwin-x64":   "@nikeproduct/pull-pal-darwin-x64",
  "linux-x64":    "@nikeproduct/pull-pal-linux-x64",
  "linux-arm64":  "@nikeproduct/pull-pal-linux-arm64",
  "win32-x64":    "@nikeproduct/pull-pal-win32-x64",
};

try {
  const key = `${platform}-${arch}`;
  const pkgName = PLATFORM_PACKAGES[key];
  if (!pkgName) {
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
