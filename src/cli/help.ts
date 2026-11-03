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

  return `pull-pal ${version} — git push that checks your branch merges and your tests pass

Usage:
  pull-pal [options] [git push args...]

Commands:
${commandLines}

Options:
${flagLines}

Anything pull-pal does not recognise is passed straight to git push, including
-v and -h. Use -- to force everything after it to git.

Configuration (per repo, or --global):
  git config pullpal.sync check|rebase|upstream|off   How to sync (default: check)
  git config pullpal.onConflict block|warn            When the branch no longer merges
  git config pullpal.tests on|off                     Run tests before pushing
  git config pullpal.testCommand "<command>"          Override test detection
  git config pullpal.testCache on|off                 Skip tests for a commit that passed
  git config pullpal.longLived "release/* develop"    Branches never synced with main
  git config branch.<name>.pullpalBase <branch>       Base to sync this branch with

By default pull-pal only checks that your branch still merges with its base
and never rewrites history. With pullpal.sync=rebase it rebases when that
applies cleanly, then pushes with --force-with-lease — and refuses when the
remote branch has commits you have not incorporated.

Tests run against exactly the commit being pushed: uncommitted and untracked
changes are set aside while they run, then restored.

Examples:
  pull-pal
  pull-pal origin my-branch
  pull-pal --no-tests
  pull-pal --dry-run
  pull-pal setup
`;
}
