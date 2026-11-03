#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const { chmodSync } = require("fs");
const { join, dirname } = require("path");
const os = require("os");

const platform = os.platform();
const arch = os.arch();

// One platform package per optionalDependency, named @nikeproduct/pull-pal-<platform>-<arch>.
const PACKAGES = Object.keys(require("./package.json").optionalDependencies || {});

function getBinaryPath() {
  const pkgName = `@nikeproduct/pull-pal-${platform}-${arch}`;

  if (!PACKAGES.includes(pkgName)) {
    const supported = PACKAGES.map((p) => p.replace("@nikeproduct/pull-pal-", ""));
    throw new Error(
      `[pull-pal] Unsupported platform: ${platform}/${arch}\n` +
      `[pull-pal] Supported: ${supported.join(", ")}`
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

// Ctrl+C reaches pull-pal directly (same process group). It may need a moment
// after that — to put back changes it set aside while tests ran — so this
// launcher must not exit first and hand the terminal back mid-restore.
process.on("SIGINT", () => {});

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, PULLPAL_INSTALL_SOURCE: "npm" },
});

if (result.error) {
  console.error(`[pull-pal] Could not run ${binaryPath}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.exit(128 + (os.constants.signals[result.signal] || 1));
}
process.exit(result.status ?? 1);
