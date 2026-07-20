"""
Entry point for the pip-distributed pull-pal package.

On first run this downloads the pre-compiled binary for the current platform
from GitHub Releases and caches it in ~/.pull-pal/bin/. Later runs exec the
cached binary directly and touch the network not at all.

The download is verified against SHA256SUMS, which is generated at release-build
time and shipped *inside this wheel*. That matters: without it, first run
fetches an executable over the network and runs it with no integrity check at
all, which is what v0.1 did.
"""

from __future__ import annotations

import hashlib
import os
import platform
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "0.2.0"
GITHUB_REPO = "nikeproduct/pull-pal"
RELEASE_BASE = f"https://github.com/{GITHUB_REPO}/releases/download/v{VERSION}"
CACHE_DIR = Path.home() / ".pull-pal" / "bin"
DOWNLOAD_TIMEOUT_SECONDS = 60
_CHECKSUMS_FILE = Path(__file__).with_name("SHA256SUMS")


class PullPalError(RuntimeError):
    """An error worth showing the user verbatim."""


def _binary_name() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "darwin":
        if machine in ("arm64", "aarch64"):
            return "pull-pal-darwin-arm64"
        return "pull-pal-darwin-x64"
    if system == "linux":
        if machine in ("x86_64", "amd64"):
            return "pull-pal-linux-x64"
        raise PullPalError(
            f"pull-pal: unsupported Linux architecture {machine}\n"
            f"Please open an issue at https://github.com/{GITHUB_REPO}/issues"
        )
    if system == "windows":
        return "pull-pal-windows-x64.exe"

    raise PullPalError(
        f"pull-pal: unsupported platform {system}/{machine}\n"
        f"Please open an issue at https://github.com/{GITHUB_REPO}/issues"
    )


def _expected_checksum(binary_name: str) -> str | None:
    """The published SHA256 for this asset, or None if the wheel has no manifest."""
    try:
        content = _CHECKSUMS_FILE.read_text(encoding="utf-8")
    except OSError:
        return None

    for line in content.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == binary_name:
            return parts[0].lower()
    return None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _make_executable(path: Path) -> None:
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _download_verified(url: str, destination: Path, expected: str | None) -> None:
    """
    Download to a temporary file beside the destination, verify it, then move it
    into place. Downloading straight to the cache path would let a failed or
    concurrent download leave a half-written binary that later runs would happily
    execute.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=str(destination.parent), prefix=".download-")
    os.close(handle)
    tmp_path = Path(tmp_name)

    try:
        with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            with tmp_path.open("wb") as out:
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    out.write(chunk)

        if expected is not None:
            actual = _sha256(tmp_path)
            if actual != expected:
                raise PullPalError(
                    "pull-pal: downloaded binary failed checksum verification.\n"
                    f"  expected {expected}\n"
                    f"  actual   {actual}\n"
                    "The download was discarded. Please retry, and report this if it persists."
                )

        if platform.system() != "Windows":
            _make_executable(tmp_path)

        # os.replace is atomic, so concurrent first runs cannot tear.
        os.replace(tmp_path, destination)
    except urllib.error.URLError as exc:
        raise PullPalError(
            f"pull-pal: failed to download the binary: {exc}\n"
            f"  url: {url}\n"
            "Check your connection, or install via npm instead:\n"
            "  npm install -g pull-pal"
        ) from exc
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def _get_or_download_binary() -> Path:
    binary_name = _binary_name()
    cached = CACHE_DIR / binary_name
    if cached.exists():
        return cached

    url = f"{RELEASE_BASE}/{binary_name}"
    print("[pull-pal] Downloading binary from GitHub Releases...", file=sys.stderr)
    print(f"[pull-pal] {url}", file=sys.stderr)

    expected = _expected_checksum(binary_name)
    if expected is None:
        print(
            "[pull-pal] warning: no checksum manifest in this package; "
            "skipping integrity verification.",
            file=sys.stderr,
        )

    _download_verified(url, cached, expected)
    print("[pull-pal] Binary cached — future runs are instant.", file=sys.stderr)
    return cached


def main() -> None:
    try:
        binary = _get_or_download_binary()
    except PullPalError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    env = {**os.environ, "PULLPAL_INSTALL_SOURCE": "pip"}
    result = subprocess.run([str(binary), *sys.argv[1:]], env=env)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
