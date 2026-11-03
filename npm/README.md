# pull-pal

A `git push` that first checks your branch still merges cleanly with `main`, and
that your tests pass on exactly the commit you are pushing.

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
