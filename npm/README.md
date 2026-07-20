# pull-pal

A `git push` wrapper that keeps your branch in sync and gates the push on your
test suite.

```sh
npm install -g pull-pal
pull-pal
```

The right pre-compiled binary for your platform is installed as an optional
dependency, so there is no download step and no network access at run time.

Full documentation, configuration, and the pre-push hook:
<https://github.com/nikeproduct/pull-pal>

## Analytics

pull-pal collects anonymous, non-identifying usage data (OS, version, and
command outcomes — never repository names, paths, branches, or code). Opt out
with `pull-pal analytics off`, or by setting `DO_NOT_TRACK=1`.

## License

MIT
