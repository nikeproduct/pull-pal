#!/usr/bin/env bun
/**
 * Publishes all npm packages in the correct order:
 *   1. Four platform-specific packages (@judecodes/pull-pal-*)
 *   2. Main pull-pal package (depends on the above via optionalDependencies)
 *
 * Usage:
 *   bun run scripts/publish-npm.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const packages = [
  join(ROOT, "npm-packages", "darwin-arm64"),
  join(ROOT, "npm-packages", "darwin-x64"),
  join(ROOT, "npm-packages", "linux-x64"),
  join(ROOT, "npm-packages", "win32-x64"),
  join(ROOT, "npm"),
];

for (const pkgDir of packages) {
  const pkgJson = await Bun.file(join(pkgDir, "package.json")).json();
  process.stdout.write(`Publishing ${pkgJson.name}@${pkgJson.version} ... `);

  const result = Bun.spawnSync(["npm", "publish"], {
    cwd: pkgDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  if (result.exitCode !== 0) {
    // "already exists" is fine — skip gracefully
    if (stderr.includes("already exists") || stderr.includes("EPUBLISHCONFLICT")) {
      console.log("already published, skipping.");
      continue;
    }
    console.error("FAILED");
    console.error(stderr);
    process.exit(result.exitCode ?? 1);
  }

  const versionLine = stdout.split("\n").find((l) => l.includes("+ ")) ?? "ok";
  console.log(versionLine.trim() || "ok");
}

console.log("\nAll packages published successfully!");
