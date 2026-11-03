import { describe, expect, test } from "bun:test";
import { allDeletions, isDeletion, parsePushRefs } from "../../src/core/gate";
import {
  HOOK_VERSION,
  LEGACY_HOOK,
  hookMatches,
  hookVersionOf,
  isOurHook,
  renderHook,
  shellPath,
} from "../../src/hooks/template";

describe("hook template", () => {
  const hook = renderHook(["/usr/local/bin/pull-pal"]);

  // Defect 11: GUI git clients launch with a minimal PATH.
  test("invokes pull-pal by absolute path", () => {
    expect(hook).toContain('exec "/usr/local/bin/pull-pal" --hook-mode "$@"');
  });

  test("falls back to PATH lookup if the absolute path is gone", () => {
    expect(hook).toContain("command -v pull-pal");
    expect(hook).toContain('exec pull-pal --hook-mode "$@"');
  });

  // Defect 8: pull-pal's own push must not re-enter the hook.
  test("stands down when PULLPAL_INTERNAL is set", () => {
    expect(hook).toContain("PULLPAL_INTERNAL");
    expect(hook.indexOf("PULLPAL_INTERNAL")).toBeLessThan(hook.indexOf("exec"));
  });

  test("exits 0 when pull-pal cannot be found at all", () => {
    // An uninstalled tool must not permanently break the user's pushes.
    expect(hook.trimEnd().endsWith("exit 0")).toBe(true);
  });

  test("forwards git's hook arguments, never a constructed push command", () => {
    expect(hook).toContain('--hook-mode "$@"');
    expect(hook).not.toContain("git push");
  });

  test("starts with a POSIX shebang and carries a version marker", () => {
    expect(hook.startsWith("#!/bin/sh\n")).toBe(true);
    expect(isOurHook(hook)).toBe(true);
    expect(hookVersionOf(hook)).toBe(HOOK_VERSION);
  });

  test("supports a multi-part invocation (running from source)", () => {
    const fromSource = renderHook(["/opt/bun/bun", "run", "/src/index.ts"]);
    expect(fromSource).toContain('exec "/opt/bun/bun" "run" "/src/index.ts" --hook-mode "$@"');
    expect(fromSource).toContain('[ -x "/opt/bun/bun" ]');
  });

  test("windows paths are converted for sh", () => {
    expect(shellPath("C:\\Users\\me\\pull-pal.exe")).toBe("C:/Users/me/pull-pal.exe");
    expect(renderHook(["C:\\bin\\pull-pal.exe"])).toContain('"C:/bin/pull-pal.exe"');
  });

  test("a foreign hook is not mistaken for ours", () => {
    expect(isOurHook("#!/bin/sh\nnpm run lint\n")).toBe(false);
    expect(hookVersionOf("#!/bin/sh\nnpm run lint\n")).toBeNull();
  });

  test("a hook that merely mentions pull-pal hook is not ours", () => {
    expect(isOurHook("#!/bin/sh\n# runs the pull-pal hook, then lint\nnpm run lint\n")).toBe(false);
  });

  // Every 0.1.x user has this file; without recognising it, setup and
  // remove-hook both refused and the PATH-dependent hook stayed forever.
  describe("the 0.1 hook", () => {
    test("is ours, as version 0", () => {
      expect(isOurHook(LEGACY_HOOK)).toBe(true);
      expect(hookVersionOf(LEGACY_HOOK)).toBe(0);
    });

    test("whatever its line endings", () => {
      expect(isOurHook(LEGACY_HOOK.replace(/\n/g, "\r\n"))).toBe(true);
    });

    test("but a user's own hook containing the same line is theirs", () => {
      const composite = `${LEGACY_HOOK}npm run lint\n`;
      expect(isOurHook(composite)).toBe(false);
    });
  });

  describe("hookMatches", () => {
    test("is true for exactly what setup would write", () => {
      expect(hookMatches(hook, ["/usr/local/bin/pull-pal"])).toBe(true);
    });

    // A Homebrew upgrade moves the Cellar path; the old hook then falls back to
    // PATH, which GUI clients lack — so setup must notice and rewrite it.
    test("is false once the binary has moved", () => {
      expect(hookMatches(hook, ["/opt/homebrew/Cellar/pull-pal/0.2.1/bin/pull-pal"])).toBe(false);
    });

    test("ignores line-ending differences", () => {
      expect(hookMatches(hook.replace(/\n/g, "\r\n"), ["/usr/local/bin/pull-pal"])).toBe(true);
    });
  });
});

describe("push ref parsing", () => {
  const ZERO = "0000000000000000000000000000000000000000";
  const SHA = "1111111111111111111111111111111111111111";

  test("parses git's four-field lines", () => {
    const refs = parsePushRefs(
      `refs/heads/main ${SHA} refs/heads/main ${ZERO}\n` +
        `refs/heads/dev ${SHA} refs/heads/dev ${SHA}\n`,
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      localRef: "refs/heads/main",
      localSha: SHA,
      remoteRef: "refs/heads/main",
      remoteSha: ZERO,
    });
  });

  test("ignores blank lines and trailing newlines", () => {
    expect(parsePushRefs("\n\n")).toEqual([]);
    expect(parsePushRefs("")).toEqual([]);
  });

  test("handles CRLF line endings", () => {
    const refs = parsePushRefs(`a ${SHA} b ${SHA}\r\n`);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.remoteSha).toBe(SHA);
  });

  test("an all-zero local sha is a deletion", () => {
    expect(isDeletion({ localRef: "", localSha: ZERO, remoteRef: "", remoteSha: SHA })).toBe(true);
    expect(isDeletion({ localRef: "", localSha: SHA, remoteRef: "", remoteSha: SHA })).toBe(false);
  });

  test("allDeletions is true only when every ref is a deletion", () => {
    const del = { localRef: "", localSha: ZERO, remoteRef: "", remoteSha: SHA };
    const add = { localRef: "", localSha: SHA, remoteRef: "", remoteSha: ZERO };
    expect(allDeletions([del, del])).toBe(true);
    expect(allDeletions([del, add])).toBe(false);
    // No refs at all (manual invocation) is not "only deletions".
    expect(allDeletions([])).toBe(false);
  });
});
