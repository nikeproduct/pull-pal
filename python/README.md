# pull-pal

A `git push` wrapper that keeps your branch in sync and gates the push on your
test suite.

```sh
pip install pull-pal
pull-pal
```

On first run this package downloads the pre-compiled pull-pal binary for your
platform from GitHub Releases, verifies it against the checksums shipped inside
this package, and caches it in `~/.pull-pal/bin/`. Every later run executes the
cached binary directly with no network access.

Full documentation, configuration, and the pre-push hook:
<https://github.com/nikeproduct/pull-pal>

## Analytics

pull-pal collects anonymous, non-identifying usage data (OS, version, and
command outcomes — never repository names, paths, branches, or code). Opt out
with `pull-pal analytics off`, or by setting `DO_NOT_TRACK=1`.

## License

MIT
