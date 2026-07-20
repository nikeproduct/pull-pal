/**
 * Terminal output. The only implementation of the `Reporter` port.
 *
 * Status lines go to stderr so that piping pull-pal's stdout stays useful and
 * the progress chatter never contaminates captured output.
 */

import { colorEnabled } from "../config";
import type { Reporter } from "../core/workflow";

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

export interface UiOptions {
  color?: boolean;
  write?: (line: string) => void;
}

export function createUi(opts: UiOptions = {}): Reporter {
  const color = opts.color ?? colorEnabled();
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const paint = (code: string, text: string) => (color ? `${code}${text}${CODES.reset}` : text);

  return {
    step: (msg) => write(paint(CODES.bold + CODES.cyan, `→ ${msg}`)),
    ok: (msg) => write(paint(CODES.green, `✓ ${msg}`)),
    warn: (msg) => write(paint(CODES.yellow, `⚠ ${msg}`)),
    fail: (msg) => write(paint(CODES.red, `✗ ${msg}`)),
    info: (msg) => write(msg),
    detail: (msg) => write(paint(CODES.dim, `  ${msg}`)),
  };
}

/** A reporter that discards everything — used by `--dry-run` machinery and tests. */
export function silentUi(): Reporter {
  const noop = () => {};
  return { step: noop, ok: noop, warn: noop, fail: noop, info: noop, detail: noop };
}
