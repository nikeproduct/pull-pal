/**
 * The generated pre-push hook.
 *
 * Three properties matter, each one a v0.1 defect:
 *
 *  - It invokes pull-pal by *absolute path*. GUI git clients (and IDEs) launch
 *    with a minimal PATH, so a bare `pull-pal` turned every push into
 *    "pull-pal: command not found".
 *  - It stands down when PULLPAL_INTERNAL is set, so pull-pal's own push does
 *    not re-enter the hook and run the whole suite a second time.
 *  - It exits 0 when pull-pal cannot be found at all. A tool that was uninstalled
 *    must not permanently break the user's ability to push.
 */

export const HOOK_MARKER = "pull-pal hook";
export const HOOK_VERSION = 2;
const VERSION_LINE = `# ${HOOK_MARKER} v${HOOK_VERSION} — managed by pull-pal; edit at your own risk.`;

/**
 * Git for Windows runs hooks under sh, where backslashes are escapes. Forward
 * slashes work on every platform git supports.
 */
export function shellPath(execPath: string): string {
  return execPath.replace(/\\/g, "/");
}

/**
 * @param argv How to invoke pull-pal: `["/usr/local/bin/pull-pal"]` for the
 * shipped binary, or `["/path/to/bun", "run", "/path/to/index.ts"]` when running
 * from source (which is also how the integration tests install a live hook).
 */
export function renderHook(argv: string[]): string {
  const [binary = "pull-pal", ...rest] = argv.map(shellPath);
  const prefix = [binary, ...rest].map((part) => `"${part}"`).join(" ");
  return `#!/bin/sh
${VERSION_LINE}
#
# Validates the push: checks the branch still merges with its base, and runs the
# test suite against exactly the commit being pushed.
# It never pushes anything itself — git owns the push that is already in flight.
#
# Uninstall with: pull-pal remove-hook

# pull-pal's own push already ran these checks.
if [ -n "\${PULLPAL_INTERNAL:-}" ]; then
  exit 0
fi

if [ -x "${binary}" ]; then
  exec ${prefix} --hook-mode "$@"
fi

if command -v pull-pal >/dev/null 2>&1; then
  exec pull-pal --hook-mode "$@"
fi

echo "pull-pal: not found — skipping pre-push checks." >&2
echo "pull-pal: remove this hook with 'pull-pal remove-hook', or reinstall pull-pal." >&2
exit 0
`;
}

/**
 * The hook pull-pal 0.1.x wrote. It has no marker and calls pull-pal off PATH
 * (the GUI-client "command not found" bug), so `setup` must recognise it to
 * replace it. Only this exact file counts: a user's own hook that happens to
 * contain the same line is theirs.
 */
export const LEGACY_HOOK = '#!/bin/sh\npull-pal --hook-mode "$@"\n';

function normalize(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

export function isLegacyHook(content: string): boolean {
  return normalize(content) === normalize(LEGACY_HOOK);
}

const VERSION_PATTERN = /^# pull-pal hook v(\d+) — managed by pull-pal/m;

/** Did pull-pal write this hook? */
export function isOurHook(content: string): boolean {
  return VERSION_PATTERN.test(content) || isLegacyHook(content);
}

/** Version of a pull-pal-written hook (0 for the 0.1 hook), or null when unrecognised. */
export function hookVersionOf(content: string): number | null {
  if (isLegacyHook(content)) return 0;
  const version = content.match(VERSION_PATTERN)?.[1];
  return version ? Number.parseInt(version, 10) : null;
}

/** True when `content` is exactly the hook `setup` would write for `argv`. */
export function hookMatches(content: string, argv: string[]): boolean {
  return normalize(content) === normalize(renderHook(argv));
}
