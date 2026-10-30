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

/** Did pull-pal write this hook? */
export function isOurHook(content: string): boolean {
  return content.includes(HOOK_MARKER);
}

/** Version of a pull-pal-written hook, or null when unrecognised. */
export function hookVersionOf(content: string): number | null {
  const match = content.match(/# pull-pal hook v(\d+)/);
  const version = match?.[1];
  return version ? Number.parseInt(version, 10) : null;
}
