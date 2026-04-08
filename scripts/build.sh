#!/usr/bin/env bash
# Build self-contained pull-pal binaries for all platforms using Bun.
# Must be run on Linux, macOS, or WSL — Bun cross-compilation is not
# supported on a native Windows host.
#
# Usage:
#   bash scripts/build.sh
#
# Output:
#   dist/                          compiled binaries (git-ignored)
#   dist/tarballs/                 macOS tarballs ready for Homebrew
#   npm-packages/*/                platform-specific npm packages
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
TARBALLS="$DIST/tarballs"
SRC="$ROOT/src/index.ts"

mkdir -p "$DIST" "$TARBALLS" \
  "$ROOT/npm-packages/darwin-arm64" \
  "$ROOT/npm-packages/darwin-x64" \
  "$ROOT/npm-packages/linux-x64" \
  "$ROOT/npm-packages/win32-x64"

echo "Building pull-pal binaries with Bun..."
echo ""

build_target() {
  local target="$1"
  local outfile="$2"
  echo -n "  Building $target ... "
  bun build --compile --target="$target" "$SRC" --outfile "$DIST/$outfile"
  echo "done"
}

build_target "bun-darwin-arm64" "pull-pal-darwin-arm64"
build_target "bun-darwin-x64"   "pull-pal-darwin-x64"
build_target "bun-linux-x64"    "pull-pal-linux-x64"
build_target "bun-windows-x64"  "pull-pal-windows-x64.exe"

echo ""
echo "Copying binaries to npm-packages/ ..."
cp "$DIST/pull-pal-darwin-arm64"     "$ROOT/npm-packages/darwin-arm64/pull-pal"
cp "$DIST/pull-pal-darwin-x64"       "$ROOT/npm-packages/darwin-x64/pull-pal"
cp "$DIST/pull-pal-linux-x64"        "$ROOT/npm-packages/linux-x64/pull-pal"
cp "$DIST/pull-pal-windows-x64.exe"  "$ROOT/npm-packages/win32-x64/pull-pal.exe"
echo "  Done"

echo ""
echo "Creating macOS tarballs for Homebrew ..."
tar -czf "$TARBALLS/pull-pal-darwin-arm64.tar.gz" -C "$DIST" pull-pal-darwin-arm64
tar -czf "$TARBALLS/pull-pal-darwin-x64.tar.gz"   -C "$DIST" pull-pal-darwin-x64
echo "  Done"

echo ""
echo "SHA256 hashes (paste into Formula/pull-pal.rb):"
shasum -a 256 "$TARBALLS/pull-pal-darwin-arm64.tar.gz"
shasum -a 256 "$TARBALLS/pull-pal-darwin-x64.tar.gz"

echo ""
echo "All done! Artifacts:"
echo "  Binaries      → $DIST/"
echo "  Platform pkgs → $ROOT/npm-packages/"
echo "  Tarballs      → $TARBALLS/"
