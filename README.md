# pull-pal

A `git push` wrapper that keeps your branch in sync and refuses to push code
whose tests fail.

```sh
pull-pal
```

It fetches, rebases onto the default branch if you are behind, runs your test
suite (auto-detected), and pushes — with `--force-with-lease` when the rebase
rewrote history, and never at all if the tests fail.

Works with any language. Nothing to configure.

---

## Install

```sh
npm install -g pull-pal      # Node / Bun projects
pip install pull-pal         # Python projects
brew install nikeproduct/pull-pal/pull-pal
```

The npm package ships the binary for your platform as an optional dependency.
The pip package downloads it on first run, verifies it against checksums shipped
inside the package, and caches it in `~/.pull-pal/bin/<version>/`.

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
| `--no-sync` | Skip the fetch and rebase steps entirely |
| `--no-tests` | Skip the test runner step |
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
→ Rebasing onto origin/main (behind origin/main by 2 commits)...
✓ Rebased onto origin/main
→ Running bun run test
  ... your test output ...
✓ Tests passed
⚠ Rebase rewrote history — pushing with --force-with-lease
→ Pushing...
✓ Pushed successfully
```

If tests fail, the push does not happen and pull-pal exits with the test
runner's own exit code.

### When it refuses

pull-pal stops before doing anything destructive if the remote branch has
commits you have not incorporated:

```
✗ origin/my-feature has 1 commit you do not have — the force-push after
  rebasing would destroy them.
  Integrate them first (git pull --rebase), or re-run with --force-with-lease
  if you are certain you want to replace the remote branch.
```

This is a case `--force-with-lease` alone cannot catch, because pull-pal has
just fetched the very ref the lease compares against.

It also refuses to start on a detached HEAD, mid-rebase, mid-merge, or in a repo
with no remotes — each with the specific command that fixes it.

### Your uncommitted work is safe

Rebases run with `--autostash`, so a dirty working tree is stashed and restored.
If the rebase conflicts, pull-pal aborts it and puts your branch back exactly as
it was — it never leaves you stranded mid-rebase.

---

## Run it on every `git push`

```sh
pull-pal setup
```

This installs a `pre-push` hook, so every push — terminal, IDE, or GUI client —
is checked first.

**The hook validates; it never rewrites history or pushes.** Git decides which
commits it is pushing *before* the hook runs, so a hook that rebased would leave
you rebased and unpushed. Instead, when your branch is behind, the hook blocks
the push and tells you to run `pull-pal`, which does the whole job correctly:

```
✗ Push blocked: your branch is behind origin/main by 2 commits.
  Run pull-pal — it will rebase and push for you.
  To push anyway, bypass the hook: git push --no-verify
```

The hook only blocks for those two reasons — out of sync, or failing tests.
Anything else it cannot make sense of (an odd repo state, a missing test tool,
an undeterminable default branch) produces a warning and lets the push through.

Prefer advice over enforcement? `git config pullpal.hookGate warn`.

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
| `gradlew` (`gradlew.bat` on Windows) or `build.gradle` | wrapper, else `gradle test` |
| `Makefile` with a `test` target | `make test` |
| `Gemfile` + a `spec/` directory | `bundle exec rspec` |
| `Gemfile` | `bundle exec rake test` |

The package manager is chosen from your project — the `packageManager` field,
then lockfiles — not from what happens to be installed on your machine.

Two things deliberately count as "no test runner": the placeholder `npm init`
writes (`echo "Error: no test specified" && exit 1`), and a `pyproject.toml`
that never mentions pytest. If nothing is detected, or the detected tool is not
on your PATH, pull-pal warns and pushes anyway rather than blocking you.

`pull-pal doctor` shows what was detected and which rule matched.

---

## Configuration

Configuration lives in `git config`, so it layers per-repo over global:

```sh
git config pullpal.sync default|upstream|off   # what to rebase onto (default: default)
git config pullpal.tests on|off                # run tests before pushing (default: on)
git config pullpal.testCommand "make check"    # override detection
git config pullpal.hookGate block|warn         # hook behaviour when out of sync
```

`pullpal.sync`:

- `default` — rebase onto the remote's default branch when behind it
- `upstream` — rebase only onto your branch's own upstream
- `off` — still fetch, never rebase

Command-line flags beat config; repo config beats global config.

---

## Analytics

pull-pal collects **anonymous, non-identifying** usage data to understand how it
is used and where it fails: operating system, architecture, version, install
source, and coarse command outcomes (did it rebase, did tests pass, did the push
succeed).

It never sends repository names, paths, remotes, branch names, commit messages,
or code. The identifier is a random UUID generated on your machine.

Opt out at any time:

```sh
pull-pal analytics off       # persisted
DO_NOT_TRACK=1               # honoured, per consoledonottrack.com
PULLPAL_NO_ANALYTICS=1
```

When analytics is off, nothing is sent — no request, no connection. Run
`pull-pal analytics status` to see the current state.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Blocked: tests failed, or the gate stopped the push |
| `2` | The repository is not in a state pull-pal can work with |
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
bun run build     # binaries, tarballs, checksums, npm packages
```

The architecture keeps decisions pure and effects at the edges: `src/core/`
decides what to do from plain data and is unit-tested without a repository,
while `src/git/` and `src/detect/fsview.ts` are the only modules that touch the
operating system. Integration tests run the real CLI against real repositories
with a local bare remote.

pull-pal gates its own pushes with pull-pal.

## License

MIT
