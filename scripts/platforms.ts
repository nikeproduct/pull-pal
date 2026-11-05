/**
 * The platforms pull-pal ships for — the one list build, set-version and
 * publish-npm read. The npm launcher (npm/run.js, npm/install.js) cannot import
 * this, so it derives the same list from npm/package.json's
 * optionalDependencies; test/unit/packaging.test.ts checks the two agree.
 */

export interface Platform {
  /** Node's `${process.platform}-${process.arch}`, and the npm-packages/ directory. */
  key: string;
  /** `bun build --target` */
  bunTarget: string;
  /** Release asset name in dist/ */
  asset: string;
  /** The binary's name inside its npm package. */
  bin: "pull-pal" | "pull-pal.exe";
}

export const NPM_SCOPE = "@nikeproduct";

export function npmPackageName(platform: Platform): string {
  return `${NPM_SCOPE}/pull-pal-${platform.key}`;
}

export const PLATFORMS: readonly Platform[] = [
  {
    key: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    asset: "pull-pal-darwin-arm64",
    bin: "pull-pal",
  },
  {
    key: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    asset: "pull-pal-darwin-x64",
    bin: "pull-pal",
  },
  {
    key: "linux-x64",
    bunTarget: "bun-linux-x64",
    asset: "pull-pal-linux-x64",
    bin: "pull-pal",
  },
  {
    key: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    asset: "pull-pal-linux-arm64",
    bin: "pull-pal",
  },
  {
    key: "win32-x64",
    bunTarget: "bun-windows-x64",
    asset: "pull-pal-windows-x64.exe",
    bin: "pull-pal.exe",
  },
];
