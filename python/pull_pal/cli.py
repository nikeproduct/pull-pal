"""
Entry point for the pip-distributed pull-pal package.

On first run, downloads the correct pre-compiled binary from GitHub Releases
and caches it in ~/.pull-pal/bin/. Subsequent calls exec the cached binary
directly with no network access required.
"""

from __future__ import annotations

import os
import platform
import stat
import subprocess
import sys
import urllib.request
from pathlib import Path

VERSION = "0.1.3"
GITHUB_REPO = "nikeproduct/pull-pal"
RELEASE_BASE = (
    f"https://github.com/{GITHUB_REPO}/releases/download/v{VERSION}"
)
CACHE_DIR = Path.home() / ".pull-pal" / "bin"


def _get_binary_name() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "darwin":
        return (
            "pull-pal-darwin-arm64"
            if machine in ("arm64", "aarch64")
            else "pull-pal-darwin-x64"
        )
    if system == "linux":
        return "pull-pal-linux-x64"
    if system == "windows":
        return "pull-pal-windows-x64.exe"

    raise RuntimeError(
        f"pull-pal: unsupported platform {system}/{machine}\n"
        "Please open an issue at https://github.com/nikeproduct/pull-pal"
    )


def _make_executable(path: Path) -> None:
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _get_or_download_binary() -> Path:
    binary_name = _get_binary_name()
    cached = CACHE_DIR / binary_name

    if cached.exists():
        return cached

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    url = f"{RELEASE_BASE}/{binary_name}"

    print(f"[pull-pal] Downloading binary from GitHub Releases...", file=sys.stderr)
    print(f"[pull-pal] {url}", file=sys.stderr)

    try:
        urllib.request.urlretrieve(url, cached)
    except Exception as exc:
        # Clean up partial download
        if cached.exists():
            cached.unlink()
        raise RuntimeError(
            f"[pull-pal] Failed to download binary: {exc}\n"
            f"[pull-pal] URL: {url}\n"
            "[pull-pal] Check your internet connection or install via npm instead:\n"
            "  npm install -g pull-pal"
        ) from exc

    if platform.system() != "Windows":
        _make_executable(cached)

    print("[pull-pal] Binary cached — future calls will be instant.", file=sys.stderr)
    return cached


def main() -> None:
    try:
        binary = _get_or_download_binary()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    env = {**os.environ, "PULLPAL_INSTALL_SOURCE": "pip"}
    result = subprocess.run([str(binary)] + sys.argv[1:], env=env)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
