import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The TUI's own `.goodvibes/` directory (logs, overflow buffers, exec output,
 * cache, session state, etc.) is transient scratch space, not project source,
 * and must stay out of the project's git history: any `git add -A`
 * (write-quit's auto-commit, a WRFC chain's own commit, etc.) would otherwise
 * sweep it in.
 *
 * The rule goes in the clone's own exclude file (`<git dir>/info/exclude`),
 * never in the project's `.gitignore`: that file is tracked, so editing it
 * would change the person's project without asking and show up as one of
 * their changes. Idempotent and append-only; nothing is written when the
 * project's ignore rules already cover the directory, or outside a git repo.
 */
const GOODVIBES_IGNORE_PATTERN = /(^|\n)[ \t]*\/?\.goodvibes\/?\*?[ \t]*(\n|$)/;

/**
 * The common git directory of the repository rooted at `projectRoot`, or null
 * when it is not a git checkout. A linked worktree's `.git` is a file naming
 * its own git dir, whose `commondir` names the repository's.
 */
function commonGitDir(projectRoot: string): string | null {
  const dotGit = join(projectRoot, '.git');
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf-8'));
  if (!pointer) return null;
  const gitDir = isAbsolute(pointer[1]!) ? pointer[1]! : resolve(projectRoot, pointer[1]!);
  const commonFile = join(gitDir, 'commondir');
  if (!existsSync(commonFile)) return gitDir;
  const common = readFileSync(commonFile, 'utf-8').trim();
  return isAbsolute(common) ? common : resolve(gitDir, common);
}

/**
 * Ensures git ignores `.goodvibes/` in this clone, adding the rule to
 * `<git dir>/info/exclude` exactly once when neither that file nor the
 * project's `.gitignore` already has it.
 *
 * @returns true only when this call wrote the rule; false when it was already
 * there, the directory is not a git repo, or the write failed. The caller uses
 * this to print a one-time notice.
 */
export function ensureGoodvibesGitignore(projectRoot: string): boolean {
  try {
    const gitDir = commonGitDir(projectRoot);
    if (gitDir === null) return false; // only matters for git projects
    const gitignorePath = join(projectRoot, '.gitignore');
    if (existsSync(gitignorePath) && GOODVIBES_IGNORE_PATTERN.test(readFileSync(gitignorePath, 'utf-8'))) return false;
    const excludePath = join(gitDir, 'info', 'exclude');
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    if (GOODVIBES_IGNORE_PATTERN.test(existing)) return false; // already excluded
    const rule = '# goodvibes-tui transient state\n.goodvibes/\n';
    if (existing.length === 0) {
      mkdirSync(dirname(excludePath), { recursive: true });
      writeFileSync(excludePath, rule);
      return true;
    }
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    appendFileSync(excludePath, separator + rule);
    return true;
  } catch {
    // Best-effort only, never block startup on an exclude write failure.
    return false;
  }
}
