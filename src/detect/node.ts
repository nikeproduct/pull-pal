/**
 * JavaScript / TypeScript projects.
 *
 * Two v0.1 defects lived here:
 *
 *  - It ran `bun test`, which is Bun's *built-in* runner and ignores
 *    `scripts.test` entirely — so a jest/vitest project silently ran the wrong
 *    thing. The package script is the contract; we invoke it (`bun run test`).
 *
 *  - It matched `"test"\s*:` with a regex, which hits the `npm init` placeholder
 *    (`echo "Error: no test specified" && exit 1`) and any dependency named
 *    "test". Both produced blocked pushes on projects with no tests at all.
 */

import type { TestPlan } from "../core/types";
import type { FsView } from "./fsview";

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
}

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/** The placeholder `npm init` writes. Present ≠ "this project has tests". */
function isPlaceholderScript(script: string): boolean {
  return /no test specified/i.test(script);
}

/**
 * Which package manager runs the script.
 *
 * Decided from *project* signals only. v0.1 keyed this on whether the user
 * happened to have bun installed, so the same repo behaved differently on two
 * machines.
 */
export function choosePackageManager(fs: FsView, pkg: PackageJson): PackageManager {
  // Corepack's `packageManager: "pnpm@9.0.0"` is the most explicit signal there is.
  const declared = pkg.packageManager?.split("@")[0]?.trim().toLowerCase();
  if (declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm") {
    return declared;
  }

  if (fs.exists("bun.lockb") || fs.exists("bun.lock")) return "bun";
  if (fs.exists("pnpm-lock.yaml")) return "pnpm";
  if (fs.exists("yarn.lock")) return "yarn";
  return "npm";
}

/** `bun run test` — never `bun test`, which would bypass the project's script. */
function commandFor(pm: PackageManager): { command: string; args: string[] } {
  if (pm === "bun") return { command: "bun", args: ["run", "test"] };
  return { command: pm, args: ["test"] };
}

export function detectNode(fs: FsView): TestPlan | null {
  const pkg = fs.readJson<PackageJson>("package.json");
  if (!pkg) return null;

  const script = pkg.scripts?.test;
  if (typeof script !== "string" || script.trim() === "") return null;
  if (isPlaceholderScript(script)) return null;

  const pm = choosePackageManager(fs, pkg);
  const { command, args } = commandFor(pm);
  return {
    command,
    args,
    label: `${command} ${args.join(" ")}`,
    source: `node:${pm}`,
  };
}
