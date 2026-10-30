# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.2.0

A ground-up rebuild. pull-pal still checks your branch, runs your tests, and
pushes, but what it checks has changed, it no longer rewrites history unless
you ask it to, and several things that never worked now do.

### Breaking

- **pull-pal no longer rebases by default.** It compares your branch with the
  default branch and blocks only when they would conflict. Being merely behind
  is reported and the push goes ahead untouched, with no rewritten history and
  no force-push. To get the old behaviour, set `git config pullpal.sync rebase`.
  It now checks for conflicts before it starts a rebase.
- **The pre-push hook no longer rebases or pushes.** It validates and blocks,
  only on conflicts or failing tests. This is the fix for the hook leaving you
  rebased-but-unpushed; see *Fixed* below.
- **The pip package is gone.** It was never published to PyPI, and it only
  downloaded the same binary npm and Homebrew already ship. Use npm, Homebrew,
  or a binary from the GitHub release.
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

- **Conflict detection.** `git merge-tree` checks, in memory, whether your
  branch still merges with its base. A conflict blocks the push, naming the
  files and the command to fix it. `pullpal.onConflict=warn` turns the block
  into a warning.
- **Tests run against exactly what is pushed.** Uncommitted and untracked files
  are stashed while the suite runs and restored afterwards, including when tests
  fail or you press Ctrl+C. A file you forgot to `git add` now fails locally
  instead of in CI.
- **Passing runs are cached** by tree and test command, so pushing a commit
  that already passed does not re-run the suite. `--retest` forces a run, and
  `pullpal.testCache=off` disables the cache.
- **Long-lived branches are left alone.** `main`, `develop`, `release/*`,
  `hotfix/*` and similar are never compared with or rebased onto the default
  branch. Change the list with `pullpal.longLived`.
- `branch.<name>.pullpalBase` names the branch a branch is based on, for
  stacked PRs and branches cut from something other than `main`.
- A Linux arm64 binary, on npm and in GitHub releases.
- `pull-pal doctor` — reports the repo, config, detected test runner and why it
  matched, and hook status. Every value it prints is one the push pipeline
  actually uses.
- `--dry-run` — prints the exact plan (remote, sync decision, test command, push
  arguments) and changes nothing.
- Configuration via `git config`, layering per-repo over global:
  `pullpal.sync` (`check` | `rebase` | `upstream` | `off`),
  `pullpal.onConflict`, `pullpal.tests`, `pullpal.testCommand`,
  `pullpal.testCache`, `pullpal.longLived`.
- A divergence guard: with `pullpal.sync=rebase`, pull-pal refuses to force-push
  over commits on the remote branch that it has not incorporated. `--force-with-lease` cannot catch this,
  because the run just fetched the ref the lease compares against.
- Automatic `--set-upstream` when publishing a branch for the first time.
- Rebases use `--autostash`, so uncommitted work survives; on conflict the
  rebase is aborted and the branch is restored exactly as it was.
- Support for `pnpm`, `yarn`, `tox.ini`, and `setup.cfg` detection signals.
- A `"pull-pal": { "test": "..." }` escape hatch in package.json.
- Release automation: one tag builds, verifies, and publishes to GitHub
  Releases, npm, and the Homebrew tap, then installs from npm on Linux (x64 and
  arm64), macOS, and Windows to prove the release is usable.
- A LICENSE file (MIT), which the manifests had always claimed.

### Fixed

- **Pushing a branch other than the checked-out one borrowed its checks.**
  `pull-pal origin other-branch` used to rebase the *current* branch, run
  *its* tests, and then push `other-branch` with `--force-with-lease`. Because
  the run had just fetched, the lease passed, and new remote commits on
  `other-branch` were overwritten. pull-pal now checks only the checked-out
  branch and hands any other push to git untouched. The hook does the same,
  using the refs git says it is pushing.
- **Release branches were rebased onto main.** On `release/1.0`, pull-pal
  planned `git rebase origin/main` followed by a force-push, which turned the
  release branch into `main` plus its fixes.
- **Tests ran against the working directory**, so uncommitted edits and files
  never added to git could make a suite pass that would fail on the pushed
  commit.
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
- `build.sh` did not regenerate the embedded version, so a release cut with it
  shipped binaries reporting the wrong version. There is now one build path, and
  `check-version` verifies the generated file.

### Changed

- Rewritten around a pure decision core (`src/core/`) that is unit-tested from
  plain data, with all OS access confined to `src/git/` and one filesystem
  facade. This is what made the behaviour above testable.
- Status output goes to stderr, honours `NO_COLOR`, and is plain when piped.
- Exit codes are now part of the contract: `0` success, `1` blocked, `2`
  unusable repository state, `130` interrupted during tests, and a failing
  suite's own code is propagated.
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
