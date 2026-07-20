# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.2.0

A ground-up rebuild. The behaviour you rely on is the same — sync, test, push —
but almost everything underneath changed, and several things that never worked
now do.

### Breaking

- **The pre-push hook no longer rebases or pushes.** It validates and blocks.
  When your branch is behind, the hook stops the push and tells you to run
  `pull-pal`, which rebases and pushes correctly. This is the fix for the hook
  leaving you rebased-but-unpushed; see *Fixed* below.
- **`--no-rebase` is now `--no-sync`**, and it skips the fetch as well as the
  rebase — which is what the old flag's documentation always claimed. The old
  spelling still works and prints a deprecation notice.
- **`-v` and `-h` now belong to `git push`.** Use `--version` and `--help` for
  pull-pal. Anything pull-pal does not recognise is forwarded to git, and `--`
  forces full passthrough.
- **`bun test` is no longer used to run Node projects.** pull-pal now runs the
  project's own `test` script (`bun run test`, `npm test`, …). Projects that
  relied on the old behaviour of running Bun's built-in test runner should set
  `git config pullpal.testCommand "bun test"`.

### Added

- `pull-pal doctor` — reports the repo, config, detected test runner and why it
  matched, and hook status. Every value it prints is one the push pipeline
  actually uses.
- `--dry-run` — prints the exact plan (remote, sync decision, test command, push
  arguments) and changes nothing.
- Configuration via `git config`, layering per-repo over global:
  `pullpal.sync` (`default` | `upstream` | `off`), `pullpal.tests`,
  `pullpal.testCommand`, `pullpal.hookGate` (`block` | `warn`).
- A divergence guard: pull-pal refuses to force-push over commits on the remote
  branch that it has not incorporated. `--force-with-lease` cannot catch this,
  because the run just fetched the ref the lease compares against.
- Automatic `--set-upstream` when publishing a branch for the first time.
- Rebases use `--autostash`, so uncommitted work survives; on conflict the
  rebase is aborted and the branch is restored exactly as it was.
- Support for `pnpm`, `yarn`, `tox.ini`, and `setup.cfg` detection signals.
- A `"pull-pal": { "test": "..." }` escape hatch in package.json.
- Release automation: one tag builds, verifies, and publishes to GitHub
  Releases, npm, PyPI, and the Homebrew tap, then installs from each to prove
  the release is usable.
- A LICENSE file (MIT), which the manifests had always claimed.

### Fixed

- **The pre-push hook never worked.** It forwarded git's hook arguments — which
  include a remote *URL* — to `git push` as a refspec, and even without that it
  rebased inside the hook, after git had already resolved the commits it was
  pushing. The result was a rebased branch, nothing pushed, and a rejected
  follow-up push. The hook is now a gate.
- Running `pull-pal` in a repo with the hook installed ran the whole test suite
  twice. pull-pal's own push is now marked and the hook stands down.
- `pull-pal setup` wrote to `.git/hooks` unconditionally, so repos using
  `core.hooksPath` (husky, lefthook) got a hook git never runs, and worktrees —
  where `.git` is a file — crashed. The hooks directory now comes from
  `git rev-parse --git-path hooks`.
- The generated hook required `pull-pal` on `PATH`, so pushes from GUI git
  clients failed with "command not found". It now embeds an absolute path, with
  a `PATH` lookup as fallback, and exits 0 if pull-pal is missing entirely.
- Test detection ran Bun's built-in runner instead of the project's `test`
  script; chose a package manager based on what was installed on the machine
  rather than on the project; treated the `npm init` placeholder and any
  dependency named `test` as a test suite; assumed pytest from a bare
  `pyproject.toml`; emitted `./gradlew` on Windows; matched `test :=`
  assignments as Makefile targets; and selected RSpec for a *file* named `spec`.
- A missing test tool crashed with ENOENT and blocked the push. It now warns and
  skips.
- A dirty working tree broke the rebase and produced advice for the wrong error.
- `origin` was hardcoded, so pushing to any other remote compared against the
  wrong branch. The remote is now resolved from your arguments, upstream, or
  remote list.
- The default branch was looked up with a network round-trip on every single
  push. It is now read locally, resolved once if unknown, and cached.
- Failures were reported as success: an undeterminable default branch printed
  "✓ Up to date".
- Git's ref list on stdin could be consumed by the test runner in hook mode.
- The Homebrew tarballs contained a platform-suffixed binary while the formula
  installed `pull-pal`, so `brew install` could never succeed. The build now
  asserts the archive member name.
- The pip launcher downloaded and executed a binary with no integrity check, no
  timeout, and a cache race. It now verifies against checksums shipped in the
  wheel, downloads to a temporary file, and installs atomically.
- `build.sh` did not regenerate the embedded version, so a release cut with it
  shipped binaries reporting the wrong version. There is now one build path, and
  `check-version` verifies the generated file.

### Changed

- Rewritten around a pure decision core (`src/core/`) that is unit-tested from
  plain data, with all OS access confined to `src/git/` and one filesystem
  facade. This is what made the behaviour above testable.
- Status output goes to stderr, honours `NO_COLOR`, and is plain when piped.
- Exit codes are now part of the contract: `0` success, `1` blocked, `2`
  unusable repository state, and a failing suite's own code is propagated.
- Analytics gained a `hook_gate_result` property, is documented in the README,
  and its privacy guarantees are enforced by tests rather than asserted in a
  comment.

### Testing

From zero tests to a suite covering the decision matrix exhaustively, the whole
detection table against in-memory fixtures, and the full pipeline against real
git repositories with a local bare remote — including hook behaviour driven by
actual `git push` invocations. CI runs on Linux, macOS, and Windows.

## [0.1.3] — 2026-06-13

Initial public release.
