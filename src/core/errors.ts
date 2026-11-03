/**
 * Two error classes, one boundary.
 *
 * `UserFacingError` is a condition we anticipated and can explain — the entry
 * point prints its message (plus optional hint) and exits with its code, with no
 * stack trace and no bug-report banner. Anything else escaping to the boundary
 * is a bug in pull-pal and is reported as such.
 */

/** Exit codes are part of the CLI contract — the pre-push hook depends on them. */
export const EXIT = {
  ok: 0,
  /** Tests failed, or a gate blocked the push. */
  blocked: 1,
  /** Repo/env is not in a state pull-pal can work with (preflight failures). */
  preflight: 2,
  /** Interrupted (Ctrl+C) while the tests ran — 128 + SIGINT, by convention. */
  interrupted: 130,
  /** Unexpected internal error. */
  internal: 70,
} as const;

export class UserFacingError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(message: string, opts: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.name = "UserFacingError";
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? EXIT.preflight;
  }
}

export function isUserFacing(e: unknown): e is UserFacingError {
  return e instanceof UserFacingError;
}
