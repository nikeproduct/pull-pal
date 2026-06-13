#!/usr/bin/env bun
/**
 * Single source of truth for pull-pal's version.
 *
 * The canonical version lives in the root package.json. Every other channel
 * manifest (npm shim, platform packages, Python, Homebrew) is derived from it,
 * so they can never drift apart again.
 *
 * Usage:
 *   bun run scripts/set-version.ts 0.1.4   # set canonical version and propagate
 *   bun run scripts/set-version.ts         # re-propagate the current root version
 *   bun run scripts/set-version.ts --check # verify every manifest matches (CI/publish guard)
 */

import { join, dirname } from "path";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A file plus the patterns whose captured group should equal the version. */
interface Target {
  file: string;
  // Each regex must have exactly one capture group wrapping the version literal.
  patterns: RegExp[];
}

const TARGETS: Target[] = [
  { file: "package.json", patterns: [/"version":\s*"([^"]+)"/] },
  {
    file: "npm/package.json",
    patterns: [
      /"version":\s*"([^"]+)"/,
      // optionalDependencies pins to the four platform packages
      /"@nikeproduct\/pull-pal-(?:darwin-arm64|darwin-x64|linux-x64|win32-x64)":\s*"([^"]+)"/g,
    ],
  },
  { file: "npm-packages/darwin-arm64/package.json", patterns: [/"version":\s*"([^"]+)"/] },
  { file: "npm-packages/darwin-x64/package.json", patterns: [/"version":\s*"([^"]+)"/] },
  { file: "npm-packages/linux-x64/package.json", patterns: [/"version":\s*"([^"]+)"/] },
  { file: "npm-packages/win32-x64/package.json", patterns: [/"version":\s*"([^"]+)"/] },
  { file: "python/pyproject.toml", patterns: [/^version = "([^"]+)"/m] },
  { file: "python/pull_pal/__init__.py", patterns: [/__version__ = "([^"]+)"/] },
  { file: "python/pull_pal/cli.py", patterns: [/^VERSION = "([^"]+)"/m] },
  { file: "Formula/pull-pal.rb", patterns: [/^  version "([^"]+)"/m] },
];

function rootVersion(): string {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

/** Replace the captured version literal in `text` for every match of `pattern`. */
function applyPattern(text: string, pattern: RegExp, version: string): string {
  return text.replace(pattern, (match, captured) =>
    match.replace(`"${captured}"`, `"${version}"`),
  );
}

function collectVersions(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push(m[1]);
    if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width loops
  }
  return found;
}

function isValidSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);
}

const arg = process.argv[2];
const checkMode = arg === "--check";

if (checkMode) {
  const expected = rootVersion();
  const mismatches: string[] = [];
  for (const { file, patterns } of TARGETS) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const pattern of patterns) {
      for (const v of collectVersions(text, pattern)) {
        if (v !== expected) mismatches.push(`  ${file}: found ${v}, expected ${expected}`);
      }
    }
  }
  if (mismatches.length > 0) {
    console.error(`Version drift detected (canonical = ${expected}):\n${mismatches.join("\n")}`);
    console.error(`\nRun "bun run scripts/set-version.ts" to fix.`);
    process.exit(1);
  }
  console.log(`All manifests are consistent at ${expected}.`);
  process.exit(0);
}

// Mutation mode: pick the target version (CLI arg, else current root) and propagate.
const version = arg ?? rootVersion();
if (!isValidSemver(version)) {
  console.error(`Invalid version "${version}". Expected semver like 0.1.3.`);
  process.exit(1);
}

console.log(`Setting version to ${version} across all channels...\n`);
for (const { file, patterns } of TARGETS) {
  const path = join(ROOT, file);
  let text = readFileSync(path, "utf8");
  for (const pattern of patterns) {
    text = applyPattern(text, pattern, version);
  }
  writeFileSync(path, text, "utf8");
  console.log(`  updated ${file}`);
}
console.log(`\nDone. Canonical version is now ${version}.`);
