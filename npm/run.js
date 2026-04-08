#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const { chmodSync } = require("fs");
const { join, dirname } = require("path");
const os = require("os");

const platform = os.platform();
const arch = os.arch();

const PLATFORM_PACKAGES = {
  "darwin-arm64": "@judecodes/pull-pal-darwin-arm64",
  "darwin-x64":   "@judecodes/pull-pal-darwin-x64",
  "linux-x64":    "@judecodes/pull-pal-linux-x64",
  "win32-x64":    "@judecodes/pull-pal-win32-x64",
};

function getBinaryPath() {
  const key = `${platform}-${arch}`;
  const pkgName = PLATFORM_PACKAGES[key];

  if (!pkgName) {
    throw new Error(
      `[pull-pal] Unsupported platform: ${platform}/${arch}\n` +
      `[pull-pal] Supported: ${Object.keys(PLATFORM_PACKAGES).join(", ")}`
    );
  }

  const binaryName = platform === "win32" ? "pull-pal.exe" : "pull-pal";

  try {
    const pkgDir = dirname(require.resolve(`${pkgName}/package.json`));
    return join(pkgDir, binaryName);
  } catch {
    throw new Error(
      `[pull-pal] Platform package ${pkgName} is not installed.\n` +
      `[pull-pal] Try reinstalling: npm install -g pull-pal`
    );
  }
}

let binaryPath;
try {
  binaryPath = getBinaryPath();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (platform !== "win32") {
  try {
    chmodSync(binaryPath, 0o755);
  } catch {
    // Non-fatal — may already be set
  }
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);
