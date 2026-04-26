# pull-pal

A `git push` wrapper that automatically:

- Fetches the remote
- Checks if your branch is behind the remote **default branch** (`main`, `master`, etc.)
- Rebases if needed
- Detects and runs your project's test suite
- Blocks the push if tests fail

Works with any language or framework. Installs in under a minute.

---

## Install

### npm (Node.js / Bun projects)

```sh
npm install -g pull-pal
```

### pip (Python projects)

```sh
pip install pull-pal
```

The first run downloads the correct binary for your platform and caches it in `~/.pull-pal/bin/`. Subsequent calls are instant.

### Homebrew (macOS)

```sh
brew tap nikeproduct/pull-pal
brew install pull-pal
```

---

## Usage

Replace `git push` with `pull-pal`:

```sh
pull-pal
```

All standard `git push` flags are passed through:

```sh
pull-pal --force-with-lease
pull-pal origin my-feature-branch
pull-pal origin main --tags
```

### Options

| Flag | Description |
|---|---|
| `--no-rebase` | Skip the fetch + rebase step |
| `--no-tests` | Skip the test runner step |
| `--help` | Show help |

---

## Auto-run on every `git push`

Run this once inside any repo:

```sh
pull-pal setup
```

This installs a `pre-push` git hook so that every `git push` — from the terminal, your IDE, or any GUI — automatically triggers the full pull-pal workflow. To uninstall:

```sh
pull-pal remove-hook
```

---

## What it does, step by step

```
→ Fetching remote...
✓ Fetched

→ Checking against origin/main...
✓ Up to date with origin/main

→ Detecting test runner...
→ Running: bun test
... (test output) ...
✓ Tests passed

→ Pushing...
✓ Pushed successfully!
```

If your branch is behind:

```
→ Behind origin/main — rebasing...
✓ Rebased onto origin/main
```

If tests fail:

```
✗ Tests failed — push blocked.
```

---

## Supported test runners

Detected automatically by project files:

| Project files | Command |
|---|---|
| `package.json` with `"test"` script | `bun test` or `npm test` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `pyproject.toml` / `pytest.ini` / `setup.py` | `pytest` |
| `pom.xml` | `mvn test` |
| `build.gradle` / `gradlew` | `./gradlew test` |
| `Makefile` with `test` target | `make test` |
| `Gemfile` + `spec/` directory | `bundle exec rspec` |
| `Gemfile` (no `spec/`) | `bundle exec rake test` |

If no runner is detected, a warning is shown and the push proceeds.

---

## Build from source

Requires [Bun](https://bun.sh) and Linux/macOS (or WSL on Windows).

```sh
git clone https://github.com/nikeproduct/pull-pal.git
cd pull-pal
bash scripts/build.sh
```

Binaries are written to `dist/`. The script also:
- Copies binaries to `npm/bin/` (for `npm publish`)
- Creates macOS tarballs in `dist/tarballs/` (for the Homebrew formula)
- Prints SHA256 hashes to paste into `Formula/pull-pal.rb`

---

## License

MIT
