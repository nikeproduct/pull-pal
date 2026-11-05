# pull-pal

A `git push` that first checks two things git does not: that your branch still
merges cleanly with `main`, and that your tests pass on exactly what you are
pushing.

```sh
pull-pal
```

It fetches, checks your branch against the default branch for conflicts, runs
your test suite (auto-detected) against the commit being pushed, and pushes.
It never rewrites your history unless you ask it to.

pull-pal fetches into its own refs (`refs/pull-pal/*`) and never moves your
remote-tracking branches, so `--force-with-lease` protects exactly what it
would with plain `git push`.

Works with any language. Nothing to configure.

---

## Install

```sh
npm install -g pull-pal
```

Binaries for macOS (arm64, x64), Linux (x64, arm64), and Windows (x64) are
also attached to every [GitHub release](https://github.com/nikeproduct/pull-pal/releases),
with a `SHA256SUMS` file to verify them.

---

## Usage

Use it wherever you would have typed `git push`:

```sh
pull-pal
pull-pal origin my-feature
pull-pal --force-with-lease
```

Anything pull-pal does not recognise goes straight to `git push`, including
`-v` and `-h`. Use `--` to force everything after it through untouched.

### Options

| Flag | Description |
|---|---|
| `--no-sync` | Skip the fetch and sync steps entirely |
| `--no-tests` | Skip the test runner step |
| `--retest` | Run the tests even if this commit already passed |
| `--dry-run` | Print exactly what would happen, change nothing |
| `--help` | Show help |
| `--version` | Print the version |

### Commands

| Command | Description |
|---|---|
| `pull-pal setup` | Install the pre-push hook in this repo |
| `pull-pal remove-hook` | Uninstall it |
| `pull-pal doctor` | Show what pull-pal sees and what it would do |
| `pull-pal analytics <on\|off\|status>` | Manage anonymous usage analytics |

Start with `pull-pal --dry-run` if you want to see the plan before trusting it.

---

## What it does, step by step

```
→ Fetching origin...
✓ Fetched
✓ behind origin/main by 4 commits — merges cleanly
Set aside uncommitted changes — testing exactly what will be pushed
→ Running bun run test
  ... your test output ...
Restored your uncommitted changes
✓ Tests passed
→ Pushing...
✓ Pushed successfully
```

### It blocks on conflicts, not on being behind

Being behind `main` is normal, and on an active repository it is true of almost
every push. Your CI already tests your branch merged with `main`. What actually
needs your attention is a branch that **no longer merges**, so that is what
pull-pal checks. It runs `git merge-tree` entirely in memory, with no checkout and
nothing to clean up afterwards:

```
✗ Your branch no longer merges cleanly — 2 files conflict with origin/main: src/api.ts, src/db.ts.
  Bring it up to date and resolve them first: git rebase origin/main  (or: git merge origin/main)
```

The conflict check needs git 2.38 or later. On older git, pull-pal says so and
carries on.

### It tests exactly what you push

Tests run against the commit being pushed, not your working directory.
Uncommitted and untracked files are stashed while the suite runs and restored
afterwards, so a file you forgot to `git add` fails here instead of in CI. This
also happens if the tests fail or you press Ctrl+C. Ignored files (build
output, `node_modules`) stay where they are.

If changes ever cannot be restored automatically (for example, the test run
created a file with the same name), pull-pal stops before pushing and tells you
where they are. They are kept in `git stash`, so nothing is lost.

### It does not re-run tests for a commit that already passed

A passing run is remembered by the commit's tree and the test command. Pushing
the same commit again, such as a retry after a network error or a run after the
hook already tested it, skips the suite. Use `--retest` to force a run, or
`git config pullpal.testCache off` to turn this off.

### It only vouches for the branch you have checked out

pull-pal checks your checked-out branch. If you push something else, such as
`pull-pal origin other-branch` or `--all`, it says so and hands the push to git
unchanged: no sync, no tests, and no `--force-with-lease`.

Long-lived branches (`main`, `master`, `develop`, `release/*`, `hotfix/*`, and
similar) are never compared with or rebased onto the default branch. A release
branch is meant to lack `main`'s newer commits.

---

## Rebasing, if you want it

```sh
git config pullpal.sync rebase
```

With `rebase`, pull-pal rebases your branch onto the default branch when it is
behind and the rebase will apply cleanly, then pushes with `--force-with-lease`:

```
→ Rebasing onto origin/main (behind origin/main by 2 commits)...
✓ Rebased onto origin/main
⚠ Rebase rewrote history — pushing with --force-with-lease
```

Rebases run with `--autostash`. If a rebase still conflicts partway through,
pull-pal aborts it and puts your branch back exactly as it was.

It refuses to force-push over commits on your remote branch that you have not
incorporated, such as a teammate's push:

```
✗ origin/my-feature has 1 commit you do not have — the force-push after
  rebasing would destroy them.
  Integrate them first (git pull --rebase origin my-feature), or re-run with
  --force if you are certain you want to replace the remote branch.
```

A lease alone cannot catch this case: pull-pal pins its lease to the commit it
just fetched, which already includes the teammate's work. A bare
`--force-with-lease` of your own does not switch the check off; `--force`, or a
lease naming the exact commit you expect (`--force-with-lease=my-feature:<sha>`),
does.

pull-pal also refuses to start on a detached HEAD, mid-rebase, mid-merge, or in
a repo with no remotes, and prints the command that fixes each one.

---

## Run it on every `git push`

```sh
pull-pal setup
```

This installs a `pre-push` hook, so every push is checked first, whether it
comes from the terminal, an IDE, or a GUI client.

**The hook validates. It never rewrites history and never pushes.** It blocks
for exactly two reasons: your branch conflicts with its base, or the tests fail.

```
✗ Push blocked: Your branch no longer merges cleanly — 1 file conflicts with origin/main: README.md.
  Bring it up to date and resolve them first: git rebase origin/main  (or: git merge origin/main)
  To push anyway, bypass the hook: git push --no-verify
```

Anything else it cannot make sense of produces a warning and lets the push
through. That includes an odd repo state, a missing test tool, an undeterminable
default branch, or a push of a branch you do not have checked out. With
`pullpal.sync=rebase`, a branch that is merely behind gets a reminder to run
`pull-pal`, which does the rebase properly.

Prefer a warning to a block? `git config pullpal.onConflict warn`.

Uninstall with `pull-pal remove-hook`. A pre-push hook pull-pal did not write is
never modified or deleted.

---

## Test detection

The first match wins:

| Signal | Command |
|---|---|
| `pullpal.testCommand` config, or a `"pull-pal": {"test": …}` block in package.json | as configured |
| `package.json` with a real `test` script | `bun run test` / `pnpm test` / `yarn test` / `npm test` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `pytest.ini`, or pytest declared in `pyproject.toml` / `setup.cfg` / `tox.ini` | `pytest` |
| `pom.xml` | `mvn -q test` |
| `gradlew` (`gradlew.bat` on Windows) or `build.gradle` | `./gradlew test`, else `gradle test` |
| `Makefile` with a `test` target | `make test` |
| `Gemfile` + a `spec/` directory | `bundle exec rspec` |
| `Gemfile` + a Rakefile with a `test` task (or a Rails app) | `bundle exec rake test` |

The package manager is chosen from your project (the `packageManager` field,
then lockfiles), not from whatever happens to be installed on your machine.

Two things deliberately count as "no test runner": the placeholder `npm init`
writes (`echo "Error: no test specified" && exit 1`), and a `pyproject.toml`
that never mentions pytest. Neither does a Gemfile on its own: Bundler is often
there only for tools like fastlane or Jekyll. If nothing is detected, or the
detected tool is not on your PATH, pull-pal warns and pushes anyway rather than
blocking you. So does pytest when it finds no tests to run.

A slow suite is the most common reason people bypass a pre-push check. If yours
takes minutes, point pull-pal at a faster subset and leave the full run to CI:

```sh
git config pullpal.testCommand "npm run test:quick"
```

`pull-pal doctor` shows what was detected and which rule matched.

---

## Configuration

Configuration lives in `git config`, so per-repo settings layer over global ones:

```sh
git config pullpal.sync check|rebase|upstream|off   # how to sync (default: check)
git config pullpal.onConflict block|warn            # when the branch no longer merges (default: block)
git config pullpal.tests on|off                     # run tests before pushing (default: on)
git config pullpal.testCommand "make check"         # override detection
git config pullpal.testCache on|off                 # skip a commit that already passed (default: on)
git config pullpal.longLived "release/* develop"    # branches never synced with the default branch
git config branch.my-feature.pullpalBase develop    # what this branch is based on
```

`pullpal.sync`:

- `check`: compare with the base branch and block only on conflicts. Never
  rewrites history. This is the default.
- `rebase`: rebase onto the base branch when behind it and the rebase applies
  cleanly.
- `upstream`: rebase onto your branch's own upstream when behind it (like
  `git pull --rebase`).
- `off`: never fetch, compare, or rebase.

The **base branch** is the remote's default branch. If a branch is based on
something else, such as a stacked PR or a branch cut from `develop`, set
`branch.<name>.pullpalBase`.

`pullpal.longLived` replaces the built-in list (`main master trunk develop
development dev staging production prod release/* releases/* release-*
hotfix/*`). Set it to an empty string to treat no branch as long-lived.

pull-pal pushes where `git push` would: the repository you name, then
`--repo`, `branch.<name>.pushRemote`, `remote.pushDefault`, and the branch's
upstream remote. It fetches and compares on that same remote.

Command-line flags beat config; repo config beats global config.

---

## Analytics

pull-pal collects **anonymous, non-identifying** usage data to understand how it
is used and where it fails: operating system, architecture, version, install
source, and coarse command outcomes (did it rebase, did tests pass, did the push
succeed).

It never sends repository names, paths, remotes, branch names, commit messages,
or code. A configured test command is never sent either, only which rule found
it (for example `config:pullpal.testCommand`). The identifier is a random UUID
generated on your machine.

Opt out at any time:

```sh
pull-pal analytics off       # persisted
DO_NOT_TRACK=1               # honoured, per consoledonottrack.com
PULLPAL_NO_ANALYTICS=1
```

When analytics is off, nothing is sent: no request, no connection. Run
`pull-pal analytics status` to see the current state.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Blocked: conflicts with the base branch, failing tests, or the divergence guard |
| `2` | The repository is not in a state pull-pal can work with |
| `130` | Interrupted (Ctrl+C) while the tests ran; nothing was pushed |
| test runner's code | Propagated when a test suite fails with its own code |

---

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run test      # unit + real-git integration tests (the script sets the timeout the
                  # integration tests need; bare `bun test` cuts them off at 5s)
bun run typecheck
bun run lint
bun run build     # binaries, checksums, npm packages
```

The architecture keeps decisions pure and effects at the edges. `src/core/`
decides what to do from plain data and is unit-tested without a repository,
while `src/git/` and `src/detect/fsview.ts` are the only modules that touch git
and the project files. Integration tests run the real CLI against real
repositories with a local bare remote.

pull-pal gates its own pushes with pull-pal.

## License

MIT
