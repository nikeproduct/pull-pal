"""
Tests for the pip launcher's download path.

The launcher fetches an executable over the network and then runs it, so the
integrity checks are the whole point: a wrong or truncated download must be
rejected and discarded, never cached and never executed.

Run with: python -m pytest python/tests
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pull_pal import cli  # noqa: E402


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeResponse:
    """Minimal stand-in for the object urlopen returns."""

    def __init__(self, payload: bytes):
        self._payload = payload
        self._offset = 0

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            chunk, self._offset = self._payload[self._offset :], len(self._payload)
            return chunk
        chunk = self._payload[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.fixture
def payload() -> bytes:
    return b"#!/bin/sh\necho pull-pal\n"


@pytest.fixture
def serve(monkeypatch, payload):
    """Make urlopen return `payload` (or whatever the test substitutes)."""

    def _serve(data: bytes = payload):
        monkeypatch.setattr(
            cli.urllib.request, "urlopen", lambda url, timeout=None: FakeResponse(data)
        )

    return _serve


def test_downloads_and_verifies_a_matching_checksum(tmp_path, serve, payload):
    serve()
    destination = tmp_path / "bin" / "pull-pal"

    cli._download_verified("https://example.test/pull-pal", destination, sha256_of(payload))

    assert destination.read_bytes() == payload


def test_rejects_a_mismatched_checksum_and_caches_nothing(tmp_path, serve, payload):
    serve()
    destination = tmp_path / "bin" / "pull-pal"
    wrong = "0" * 64

    with pytest.raises(cli.PullPalError, match="checksum verification"):
        cli._download_verified("https://example.test/pull-pal", destination, wrong)

    # Nothing was cached, so the next run retries cleanly rather than executing
    # a binary that failed verification.
    assert not destination.exists()


def test_leaves_no_temporary_files_behind_on_failure(tmp_path, serve):
    serve(b"corrupted")
    destination = tmp_path / "bin" / "pull-pal"

    with pytest.raises(cli.PullPalError):
        cli._download_verified("https://example.test/pull-pal", destination, "1" * 64)

    leftovers = list((tmp_path / "bin").glob(".download-*"))
    assert leftovers == []


def test_download_failure_is_reported_as_a_user_facing_error(tmp_path, monkeypatch):
    def explode(url, timeout=None):
        raise cli.urllib.error.URLError("network down")

    monkeypatch.setattr(cli.urllib.request, "urlopen", explode)
    destination = tmp_path / "bin" / "pull-pal"

    with pytest.raises(cli.PullPalError, match="failed to download"):
        cli._download_verified("https://example.test/pull-pal", destination, None)

    assert not destination.exists()


def test_missing_checksum_manifest_still_downloads(tmp_path, serve, payload):
    """A wheel built without a manifest warns, but must remain usable."""
    serve()
    destination = tmp_path / "bin" / "pull-pal"

    cli._download_verified("https://example.test/pull-pal", destination, None)

    assert destination.read_bytes() == payload


def test_expected_checksum_is_read_from_the_shipped_manifest(tmp_path, monkeypatch):
    manifest = tmp_path / "SHA256SUMS"
    manifest.write_text(
        "aaa  pull-pal-linux-x64\nbbb  pull-pal-darwin-arm64\n", encoding="utf-8"
    )
    monkeypatch.setattr(cli, "_CHECKSUMS_FILE", manifest)

    assert cli._expected_checksum("pull-pal-linux-x64") == "aaa"
    assert cli._expected_checksum("pull-pal-darwin-arm64") == "bbb"
    assert cli._expected_checksum("pull-pal-windows-x64.exe") is None


def test_absent_manifest_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "_CHECKSUMS_FILE", tmp_path / "does-not-exist")
    assert cli._expected_checksum("pull-pal-linux-x64") is None


@pytest.mark.parametrize(
    ("system", "machine", "expected"),
    [
        ("Darwin", "arm64", "pull-pal-darwin-arm64"),
        ("Darwin", "x86_64", "pull-pal-darwin-x64"),
        ("Linux", "x86_64", "pull-pal-linux-x64"),
        ("Windows", "AMD64", "pull-pal-windows-x64.exe"),
    ],
)
def test_platform_mapping(monkeypatch, system, machine, expected):
    monkeypatch.setattr(cli.platform, "system", lambda: system)
    monkeypatch.setattr(cli.platform, "machine", lambda: machine)
    assert cli._binary_name() == expected


@pytest.mark.parametrize(
    ("system", "machine"),
    [("Linux", "armv7l"), ("FreeBSD", "x86_64")],
)
def test_unsupported_platforms_fail_with_guidance(monkeypatch, system, machine):
    monkeypatch.setattr(cli.platform, "system", lambda: system)
    monkeypatch.setattr(cli.platform, "machine", lambda: machine)

    with pytest.raises(cli.PullPalError, match="unsupported"):
        cli._binary_name()


def test_version_matches_the_release_url():
    assert cli.RELEASE_BASE.endswith(f"/v{cli.VERSION}")


def test_cache_dir_is_versioned_so_upgrades_refresh_the_binary():
    assert cli.CACHE_DIR == cli.CACHE_ROOT / cli.VERSION


def test_prune_removes_other_versions_and_the_old_flat_layout(tmp_path, monkeypatch):
    root = tmp_path / "bin"
    (root / "0.1.3").mkdir(parents=True)
    (root / "0.1.3" / "pull-pal-linux-x64").write_bytes(b"old")
    (root / cli.VERSION).mkdir()
    (root / cli.VERSION / "pull-pal-linux-x64").write_bytes(b"current")
    (root / "pull-pal-linux-x64").write_bytes(b"pre-0.2 layout")
    (root / "unrelated.txt").write_text("keep", encoding="utf-8")
    monkeypatch.setattr(cli, "CACHE_ROOT", root)
    monkeypatch.setattr(cli, "CACHE_DIR", root / cli.VERSION)

    cli._prune_old_versions()

    assert sorted(p.name for p in root.iterdir()) == sorted([cli.VERSION, "unrelated.txt"])
    assert (root / cli.VERSION / "pull-pal-linux-x64").read_bytes() == b"current"
