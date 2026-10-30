# pull-pal v0.2 — Ground-Up Rebuild Plan

**Status:** implemented on `v2` — M0–M7 landed, all 24 ledger rows closed
**Owner:** Jude · **Created:** 2026-07-20
**Supersedes:** v0.1.x implementation (kept on `main` until v0.2 ships from the `v2` branch)

> **Implementation notes.** Two design decisions in §5 changed once the tests
> could speak:
>
> 1. **The lease is bare, not pinned.** §5.2 proposed pinning
>    `--force-with-lease` to the pre-fetch sha. In the ordinary "behind → rebase"
>    case those fetched commits *are* incorporated by the rebase, so the pin is
>    stale and rejects every legitimate push. The semantic risk is instead
>    covered by the divergence guard (which blocks force-pushing over
>    unincorporated commits), leaving the bare lease to do what it is actually
>    good at: catching a race between our fetch and our push.
> 2. **The divergence guard is scoped to force-pushes.** Blocking every
>    merely-behind push duplicated git's own non-fast-forward rejection and made
>    pull-pal obstructive where plain git is already correct.
>
> **Post-review changes (2026-10).** A product review changed the shape of §5
> and §8 before release; the CHANGELOG has the user-facing detail:
>
> 3. **The default sync is `check`, not rebase.** Being behind is reported;
>    only a conflict with the base branch (found in memory by
>    `git merge-tree --write-tree`) blocks. Rebasing is opt-in
>    (`pullpal.sync=rebase`), and the hook no longer blocks on behind-ness.
> 4. **pull-pal vouches only for the checked-out branch.** A push of anything
>    else gets no sync, tests, or lease; long-lived branches are never synced
>    with the default branch; `branch.<name>.pullpalBase` overrides the base.
> 5. **Tests run on exactly the pushed commit** (uncommitted and untracked
>    changes are stashed around the run), and passing trees are cached.
> 6. **The pip channel was dropped** (§8); a linux-arm64 binary was added.
>
> Before shipping, the release still needs three things only a human can do:
> create the `nikeproduct/homebrew-pull-pal` tap repository, add the
> `NPM_TOKEN` / `TAP_TOKEN` secrets, and bump the version with
> `bun run set-version 0.2.0`.

---

## 1. Product definition

### Goal

A `git push` replacement that guarantees two things before anything reaches the remote:

1. **Your branch is synced** — fetched, and rebased per a configurable policy.
2. **Your tests pass** — auto-detected per ecosystem, with a config override.

One binary, three install channels (npm, pip, Homebrew), zero required configuration.

### Non-goals

- Not a git GUI, merge tool, or CI replacement.
- No conflict resolution — on conflict we abort cleanly and hand back a normal git state.
- No daemon/watcher mode. pull-pal runs, finishes, exits.
- No Windows arm64 / Linux arm64 in v0.2 (add when someone asks).

### Why rebuild instead of patch

The v0.1.3 review found the flagship flow (hook-mode rebase) broken *by design* — it pushes mid-`pre-push`, which races git's already-resolved SHAs and passes the hook's URL argument as a refspec. Fixing that means re-deciding what the hook *is*, which cascades into the CLI contract, the workflow engine, and the test strategy. The surface area is small (~600 LOC core); rebuilding on a tested foundation is cheaper than retrofitting tests onto wrong semantics.

---

## 2. Defect ledger → design remedies

Every defect from the v0.1.3 review, its remedy in v0.2, and the test that locks it in.
This table is the rebuild's acceptance checklist — **v0.2 does not ship until every row's test exists and passes.**

| # | v0.1.3 defect | v0.2 remedy | Locked in by |
|---|---|---|---|
| 1 | Hook mode pushed remote URL as refspec | Hook never pushes (§5.3); hook args are consumed, never forwarded | `integration/hook.test.ts` |
| 2 | In-hook rebase invalidates the in-flight push | Hook is gate-only; all mutation happens in direct-command mode | `integration/hook.test.ts` |
| 3 | Homebrew: tap repo missing; tarball binary name ≠ formula name | Tarball contains a binary named exactly `pull-pal`; tap repo created; formula bumped by release automation (§8.3) | `release.yml` smoke job |
| 4 | pip package never published; `python/README.md` missing breaks hatch | PyPI publish is a release-workflow step; packaging built + installed in CI | `release.yml` + `ci.yml` pip job |
| 5 | `bun test` ≠ the package's `test` script; runner chosen by user's PATH | Runner chosen from project signals (lockfiles, `packageManager`); script runners invoke the script (`bun run test`, `npm test`) | `unit/detect.test.ts` |
| 6 | npm-init default test stub blocks pushes; regex matched `"test":` anywhere | Parse `package.json`, read `scripts.test`, treat the `echo "Error: no test specified"` stub as *no runner* | `unit/detect.test.ts` |
| 7 | Dirty tree breaks rebase with wrong advice | Preflight checks (§5.2) + `git rebase --autostash`; conflict path aborts to clean state with correct instructions | `integration/sync.test.ts` |
| 8 | Hook + direct use = double fetch/tests | `PULLPAL_INTERNAL=1` set on spawned `git push`; hook exits 0 instantly when present | `integration/recursion.test.ts` |
| 9 | `--no-rebase` didn't skip fetch (README lied) | `--no-sync` skips fetch *and* rebase; docs generated from the same flag table the parser uses | `unit/cli.test.ts` |
| 10 | `core.hooksPath` / worktrees / submodules broke `setup` | Hook dir resolved via `git rev-parse --git-path hooks` | `integration/setup.test.ts` |
| 11 | Hook required `pull-pal` on PATH (GUI clients fail) | Generated hook embeds absolute `process.execPath`, with PATH lookup as fallback | `integration/setup.test.ts` |
| 12 | Hardcoded `origin`; `git remote show` network call per push | Remote resolved from args → branch upstream → single remote → `origin` (§5.2); default branch from local `origin/HEAD`, else one cached `ls-remote --symref` | `unit/remote.test.ts` |
| 13 | Missing test tool (pytest etc.) crashed and blocked push | `which(command)` before run; missing tool ⇒ warn + skip, never crash | `unit/detect.test.ts` |
| 14 | pip wrapper: no checksum, no timeout, cache race | SHA256SUMS embedded in wheel per release; timeout; download to temp + verify + atomic rename | `python/tests/test_download.py` |
| 15 | `build.sh` skipped version embed; drift risk | One build script (TS only, runs everywhere Bun does); `version.ts` generated by build *and* verified by `check-version` in CI | `ci.yml` version job |
| 16 | `-v`/`-h` stolen from git passthrough | Only long-form `--version`/`--help` are pull-pal's; unknown flags pass through; `--` forces passthrough | `unit/cli.test.ts` |
| 17 | `hasDir` dead logic; file named `spec` selected rspec | `statSync().isDirectory()` | `unit/detect.test.ts` |
| 18 | `./gradlew` unusable on Windows | `gradlew.bat` on win32 | `unit/detect.test.ts` (win CI leg) |
| 19 | Makefile regex matched `test := ...` variables | Target regex excludes `:=`/`::=` assignments | `unit/detect.test.ts` |
| 20 | Hook-mode stdin leaked git's ref lines into test runners | Hook mode drains stdin; test runner gets `stdin: "ignore"` in hook mode | `integration/hook.test.ts` |
| 21 | Errors silently became "✓ Up to date" | Query failures reported distinctly ("could not determine — skipping sync") | `unit/workflow.test.ts` |
| 22 | No LICENSE file | `LICENSE` (MIT) at root, included in all packages | repo lint job |
| 23 | Analytics undisclosed in README | README "Analytics" section; same copy as first-run notice | docs review |
| 24 | Zero tests, zero CI, tool couldn't gate itself | This entire plan; root `package.json` gets a real `test` script so pull-pal dogfoods itself | everything below |

---

## 3. Stack decision

**Keep: TypeScript on Bun, compiled to standalone binaries.**

- Rationale: single-file cross-compile (`bun build --compile`) already proved out; the npm optionalDependencies distribution layer from v0.1 was reviewed as *correct* and carries over nearly unchanged; team familiarity; `bun test` is a fast built-in runner (and yes — pull-pal will run its own tests with the very runner-detection logic it ships).
- Rejected: Go/Rust (better single-binary story but total rewrite of working distribution scripts + new toolchain for marginal gain at this size).
- Constraint accepted: Bun's ~50 MB binaries. Acceptable for a dev tool; revisit if it matters.

Tooling baseline: `strict` TS, `noUncheckedIndexedAccess`, Biome (lint + format), `bun test` with coverage, GitHub Actions.

---

## 4. Architecture

The v0.1 codebase interleaved decisions with I/O, which is why nothing was testable. v0.2 separates a **pure decision core** from thin **effect adapters**.

```
src/
  index.ts            # entry: wire adapters, run CLI, top-level error boundary
  cli/
    args.ts           # parse argv → Command (pure; single flag table drives parser AND help text)
    help.ts           # generated from the flag table
    ui.ts             # step/ok/warn/fail output; honors NO_COLOR, non-TTY
  core/
    workflow.ts       # THE push pipeline as a pure state machine (§5.2)
    plan.ts           # decides actions (rebase? push args? force-lease?) from RepoState — no I/O
    errors.ts         # typed errors: UserFacing vs Unexpected
  git/
    exec.ts           # single spawn wrapper (injectable → fake in unit tests)
    queries.ts        # repoState(): branch, upstream, remotes, dirty, detached, rebase-in-progress
    actions.ts        # fetch, rebase --autostash, push (sets PULLPAL_INTERNAL=1)
    hooks-path.ts     # rev-parse --git-path hooks
  detect/
    index.ts          # ordered detector list → TestPlan | null
    node.ts …         # one module per ecosystem; each detector is pure given a FsView
    fsview.ts         # tiny fs facade (exists/isDir/read) → trivially fakeable
  hooks/
    template.ts       # hook script generation (embeds execPath)
    install.ts        # setup / remove-hook
  telemetry/          # ported from v0.1 (reviewed good), README disclosure added
    config.ts  posthog.ts
  config.ts           # reads `git config pullpal.*` + env overrides (§6)
  version.ts          # AUTO-GENERATED (build + CI check)
test/
  unit/               # pure modules, faked adapters — runs in ms
  integration/        # real git: temp repo + local bare "remote" (§7.2)
  helpers/fixture.ts  # makeRepo(): {repo, remote, run(), commit(), …}
python/               # pip launcher + its own tests
scripts/              # build.ts, set-version.ts, publish-npm.ts (single, cross-platform)
```

Rules:
- **Only `git/exec.ts` and `detect/fsview.ts` touch the OS.** Everything in `core/` and `detect/` is a pure function of inputs — unit-testable without a git repo.
- One error boundary at the entry point. `UserFacingError` prints its message; anything else prints a bug-report banner. No module swallows errors except telemetry (by contract).

---

## 5. Behavior specification

### 5.1 CLI contract

```
pull-pal [flags] [git push args...]     # the push pipeline (default command)
pull-pal setup                          # install pre-push hook
pull-pal remove-hook                    # uninstall pre-push hook
pull-pal analytics <on|off|status>
pull-pal doctor                         # env sanity: git version, remote, hook state, detected runner, config
pull-pal --version | --help
```

- pull-pal owns **only**: `--no-sync` (skip fetch+rebase — both, fixing defect 9), `--no-tests`, `--dry-run` (print the plan, do nothing), `--hook-mode` (internal), `--help`, `--version`. Long-form only; `-v` and every unknown flag pass through to `git push` untouched. `--` ends pull-pal's parsing entirely.
- `--no-rebase` kept as a deprecated alias for `--no-sync` (warns once).
- `--dry-run` exists because it makes the workflow honest: it prints exactly the plan `core/plan.ts` computed, which is also what integration tests assert against.

### 5.2 The push pipeline (direct mode)

```
parse args → read RepoState → preflight → sync → test → push
```

**RepoState** (one batch of git queries): current branch, detached?, upstream ref + remote, remote list, default branch of target remote, ahead/behind vs upstream, behind vs default branch, dirty?, rebase/merge in progress?

**Preflight** (fail fast, clear message, exit 2):
- not a git repo / detached HEAD / rebase or merge already in progress → explain and stop.
- no remotes → stop ("nothing to push to").

**Remote resolution** (defect 12): first positional git arg if it names a remote → else the branch's upstream remote → else the only remote → else `origin`.

**Default branch resolution:** local `refs/remotes/<remote>/HEAD` if set → else one `git ls-remote --symref <remote> HEAD`, then persist via `git remote set-head` so the network hit happens at most once per clone → else skip default-branch sync with a visible "could not determine" warning (defect 21 — never a silent "✓").

**Sync step** (policy from config, §6):
| policy | behavior |
|---|---|
| `default` *(default)* | rebase onto `<remote>/<default-branch>` when behind it |
| `upstream` | rebase only onto the branch's own upstream when behind it |
| `off` | fetch still runs (unless `--no-sync`), no rebase |

- All rebases use `--autostash` (defect 7). Conflict ⇒ `git rebase --abort`, restore stash, print the three commands to do it manually, exit 2. **Never leave a mid-rebase state.**
- The safety check v0.1 never did: if the branch's own upstream has diverged (remote has commits we don't, and no user force flag), stop before rebasing/pushing and say so — that's the clobber case `--force-with-lease` exists for; make the user acknowledge it.

**Test step:** detection per §5.4 → if runner found but its command isn't on PATH: warn + skip (defect 13). If found and runnable: run (stdio inherited, cwd = repo root). Non-zero ⇒ push blocked, exit = runner's code.

**Push step:** `git push [--force-with-lease]? <user args>` — lease added only when we rebased *and* the user passed no force flag. Spawn env gets `PULLPAL_INTERNAL=1` (defect 8).

### 5.3 Hook mode — the load-bearing design change

**The pre-push hook is a pure gate. It never mutates the repo and never pushes.** (Defects 1, 2, 8.)

Rationale: git resolves the SHAs it will push *before* invoking `pre-push`. Any rebase inside the hook therefore either strands the push (stale SHAs → non-fast-forward reject) or requires pull-pal to race git's own push — v0.1 tried the latter, and it cannot work. A gate is the only shape a pre-push hook can correctly have.

Hook-mode behavior:
1. If `PULLPAL_INTERNAL=1` → exit 0 immediately (this push came from pull-pal itself; it already did the work).
2. Drain stdin (git's ref lines — defect 20; also lets us skip everything on branch deletions).
3. Fetch; compute behind-ness. If sync policy says a rebase is needed → **fail the push** (exit 1) with exactly what to run: `pull-pal` (which rebases *and* pushes correctly, lease included). One command, not a git lecture.
4. Run tests (stdin ignored). Fail ⇒ block push.
5. Exit 0 → git's own push proceeds untouched.

Trade-off, stated honestly: `git push` from a GUI *blocks* with instructions when a rebase is needed rather than magically rebasing. That's the correct trade — the v0.1 "magic" variant shipped a flow that had never once worked. README documents this explicitly.

Generated hook (defects 10, 11): written to `git rev-parse --git-path hooks` (honors `core.hooksPath`, worktrees, submodules); invokes the absolute `process.execPath` with a PATH-lookup fallback line; marker comment (`# pull-pal hook v2`) so setup/remove can recognize and safely upgrade their own hook, appending to a foreign hook only with explicit instructions (v0.1's refusal behavior was fine — keep it).

### 5.4 Test detection

Ordered detectors; first match wins; each returns `{command, args, label, source}` or null. `--dry-run` and `doctor` print which detector fired and why.

| Signal (in priority order) | Command |
|---|---|
| `git config pullpal.testCommand` / package.json `"pull-pal": {"test": …}` | as configured (via shell) — the monorepo/override escape hatch |
| `package.json` with real `scripts.test` (JSON-parsed; npm-init stub ⇒ *no runner*, defect 6) | `bun run test` if project signals bun (`bun.lockb`/`bun.lock`, or `packageManager: "bun@…"`), else pnpm/yarn/npm by the same signal class (defect 5) |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `pytest.ini` / `tox.ini` / `pyproject.toml` **declaring pytest** (in deps or `[tool.pytest.ini_options]`) | `pytest` — bare `pyproject.toml` is *not* enough (defect 13's root cause) |
| `pom.xml` | `mvn -q test` |
| `gradlew` (`gradlew.bat` on win32, defect 18) / `build.gradle(.kts)` | wrapper preferred, else `gradle test` |
| `Makefile` with a real `test:` target (regex excludes `:=` assignments, defect 19) | `make test` |
| `Gemfile` + `spec/` *directory* (`isDirectory()`, defect 17) | `bundle exec rspec`, else `bundle exec rake test` |

Every detector runs against the injectable `FsView`, so the entire table is unit-tested from fixtures without touching the real fs.

### 5.5 Telemetry

Port v0.1's implementation (reviewed as exemplary) with three changes: README disclosure section (defect 23), events gain a `hook_gate_result` property (the new hook semantics are the thing we most need signal on), and the module gets unit tests — opt-out matrix (`DO_NOT_TRACK` variants, env var, persisted flag) and a payload-shape test against a local `Bun.serve()` mock asserting **zero requests** when opted out.

---

## 6. Configuration

Via `git config` — free per-repo/global layering, no new file format, discoverable in `doctor`:

```
git config pullpal.sync default|upstream|off     # sync policy (default: "default")
git config pullpal.testCommand "make check"      # override detection
git config pullpal.tests on|off                  # default: on
```

Env: `PULLPAL_NO_ANALYTICS`, `DO_NOT_TRACK`, `NO_COLOR`, `PULLPAL_INSTALL_SOURCE` (launchers), `PULLPAL_INTERNAL` (internal guard). Precedence: flags > env > repo config > global config > defaults. One `config.ts` module owns this; nothing else reads `process.env`.

---

## 7. Test strategy

Target: **core/detect/cli at ~100% branch coverage; every defect-ledger row has a named regression test; every workflow outcome has an integration test.** CI gates on coverage for `src/core` + `src/detect` + `src/cli` (the pure layers — where coverage is meaningful, not theater).

### 7.1 Unit (`bun test`, no I/O, milliseconds)
- `cli/args`: every flag, passthrough incl. `-v`, `--`, deprecated alias warning (defects 9, 16).
- `core/plan`: RepoState → action table: behind/ahead/diverged × policy × force-flag × dirty × detached — enumerated exhaustively.
- `detect/*`: fixture `FsView`s per row of §5.4, plus the false-positive cases from the review (npm stub, `"test":` in deps, `spec` file-not-dir, Makefile `test :=`).
- `config`, `telemetry`, `hooks/template` (execPath embedding, marker).

### 7.2 Integration (real git, temp dirs — the layer v0.1 lacked entirely)

Fixture helper: `makeRepo()` → temp dir with `git init --bare remote.git`, a clone wired to it, commit/branch/run helpers, auto-cleanup. Runs the real compiled pipeline against real git.

Scenarios (each maps to workflow outcomes and ledger rows):
- up-to-date → tests run → push lands on bare remote
- behind default → rebase → push carries `--force-with-lease` → remote has rebased SHA
- behind with dirty tree → autostash → stash restored after (defect 7)
- rebase conflict → aborted, tree clean, exit 2, no push (defect 7)
- diverged upstream, no force flag → blocked with lease warning
- failing test suite → push blocked, remote unchanged
- `--no-sync` offline (remote URL unreachable) → still pushes to reachable local remote / skips fetch (defect 9)
- `setup`/`remove-hook`: plain repo, `core.hooksPath` repo, worktree, foreign existing hook (defect 10)
- hook gate: real `git push` in hooked repo — up-to-date passes; behind blocks with instructions; `PULLPAL_INTERNAL` skips; ref lines drained (defects 1, 2, 8, 20)
- detached HEAD / mid-rebase / no-remote preflights

### 7.3 Packaging & E2E
- CI builds all four binaries; per-OS leg runs the native binary through `--version`, `--help`, `doctor`, and one full fixture push.
- npm: `npm pack` + install the tarball into a temp prefix → run `pull-pal --version` (validates launcher + optionalDeps wiring).
- pip: build wheel, install in venv, run against a fixture with a pre-seeded fake "downloaded" binary; `test_download.py` covers checksum-mismatch rejection, timeout, atomic-rename race (defect 14).
- Homebrew: release workflow asserts tarball contains a member named exactly `pull-pal` before uploading (defect 3 can never recur).

### 7.4 CI (`ci.yml`, every PR)
Matrix ubuntu / macos / windows: typecheck → lint → unit → integration → build → binary smoke. Plus: `set-version --check` (now covering `src/version.ts`, defect 15), repo lint (LICENSE present, README flag table matches parser table).

---

## 8. Distribution & release

### 8.1 Channels (npm layout carries over from v0.1 — it was reviewed as correct)
- **npm:** `pull-pal` shim + 4 platform packages via pinned `optionalDependencies`, postinstall chmod, launcher fallback. Unchanged except launcher tests.
- **pip:** launcher downloads from GitHub Releases on first run — now verifying against `SHA256SUMS` embedded in the wheel at release-build time, with timeout + temp-file + atomic rename. `python/README.md` added (fixes hatch build, defect 4).
- **Homebrew:** tarballs repackaged so the binary inside is named `pull-pal`; create `nikeproduct/homebrew-pull-pal` tap; formula updated by automation.

### 8.2 Versioning
`package.json` stays canonical; `set-version.ts` propagates (add `src/version.ts` + `SHA256SUMS` template to its targets); `check-version` runs in CI *and* before publish. `build.sh` is deleted — one cross-platform `build.ts` (defect 15).

### 8.3 Release automation (`release.yml`, on tag `v*`) — manual releasing caused defects 3, 4, 15; automation is the fix
1. check-version → full CI suite
2. build binaries + tarballs (validated member names) + `SHA256SUMS`
3. GitHub Release with all assets
4. npm publish (platform pkgs → shim, idempotent-skip logic from v0.1)
5. PyPI publish (embed SHA256SUMS first)
6. Bump tap formula (version + sha256s) via automated PR to the tap repo
7. Post-release smoke: `npm i -g pull-pal && pull-pal --version`; `pip install pull-pal` in a container; `brew install nikeproduct/pull-pal/pull-pal` on the macos runner

---

## 9. Milestones

Each milestone lands as a reviewed PR to `v2` with its tests; the ledger table is the running scorecard.

| | Scope | Done when |
|---|---|---|
| **M0** | Scaffold: layout, strict TS, Biome, bun test + coverage gates, `ci.yml` matrix, LICENSE, fixture helper | CI green on hello-world pipeline; `makeRepo()` used by a proof test |
| **M1** | `git/` adapters + `core/` state machine + preflights + sync policies | §7.1 plan table + §7.2 sync/preflight scenarios pass; ledger 7, 12, 21 |
| **M2** | `detect/` engine | §5.4 table fully fixture-tested; ledger 5, 6, 13, 17, 18, 19 |
| **M3** | `cli/` + ui + `--dry-run` + `doctor` + config module | ledger 9, 16; help generated from flag table; doctor output snapshot-tested |
| **M4** | Hooks: template, setup/remove, gate mode | §7.2 hook scenarios incl. GUI-PATH simulation (empty-PATH env run); ledger 1, 2, 8, 10, 11, 20 |
| **M5** | Telemetry port + tests; README analytics section | opt-out matrix + mock-server tests; ledger 23 |
| **M6** | Packaging: build.ts, launchers + tests, pip checksums, tarball fix, `release.yml`, tap repo | dry-run release on a `v0.2.0-rc` tag passes end-to-end incl. §8.3 step 7; ledger 3, 4, 14, 15, 22 |
| **M7** | Docs (README rewritten against real behavior), CHANGELOG, dogfood period, ship **v0.2.0** | pull-pal pushes pull-pal (hook installed, own suite gating) for a full week of daily use; all 24 ledger rows checked off |

Sequencing note: M1–M3 are parallelizable after M0; M4 depends on M1; M6 depends on all code milestones.

---

## 10. Open questions (defaults chosen; revisit before M1 freeze)

1. **Default sync policy** — `default` (rebase onto default branch) preserves the product's identity but is aggressive for shared/stacked branches; `upstream` is the conservative choice. **Going with `default`** since it's the tool's reason to exist, now one `git config pullpal.sync` away from tame — but if dogfooding (M7) shows force-lease surprises, flip to `upstream` before GA.
2. **Hook strictness** — should behind-ness *block* (chosen) or merely warn? A `pullpal.hookGate = block|warn` config can ship in M4 for cheap if wanted.
3. **npm shim latency** — the Node launcher adds ~50 ms/run. esbuild-style postinstall bin-replacement would fix it; deferred unless it annoys.
