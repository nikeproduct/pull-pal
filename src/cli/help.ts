/**
 * Help text, rendered from the same tables the parser uses. A flag cannot exist
 * without being documented, and cannot be documented without existing.
 */

import { FLAGS, SUBCOMMANDS } from "./args";

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function renderHelp(version: string): string {
  const width = 16;
  const flagLines = FLAGS.filter((f) => !f.hidden)
    .map((f) => {
      const alias = f.deprecatedAlias ? ` (alias: ${f.deprecatedAlias}, deprecated)` : "";
      return `  ${pad(f.name, width)}${f.description}${alias}`;
    })
    .join("\n");

  const commandLines = SUBCOMMANDS.map((c) => `  ${pad(c.name, width)}${c.description}`).join("\n");

  return `pull-pal ${version} — git push with automatic sync and test gating

Usage:
  pull-pal [options] [git push args...]

Commands:
${commandLines}

Options:
${flagLines}

Anything pull-pal does not recognise is passed straight to git push, including
-v and -h. Use -- to force everything after it to git.

Configuration (per repo, or --global):
  git config pullpal.sync default|upstream|off   Which branch to rebase onto
  git config pullpal.tests on|off                Run tests before pushing
  git config pullpal.testCommand "<command>"     Override test detection

After a rebase, pull-pal pushes with --force-with-lease. It refuses to do so
when the remote branch has commits you have not incorporated.

Examples:
  pull-pal
  pull-pal origin my-branch
  pull-pal --no-tests
  pull-pal --dry-run
  pull-pal setup
`;
}
