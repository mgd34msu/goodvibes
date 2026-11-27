/**
 * run-by-itself.ts, the files a program runs by itself later: a shell's start-up files, a folder's environment, a
 * repository's hooks and configuration, a project's own runners and test set-up, an editor's tasks, the login's ssh
 * and git configuration, the service and timer folders, and everything GoodVibes itself loads from a `.goodvibes`
 * folder (its hooks, settings, tool servers, the worktree setup in its project settings, plugins and skills).
 * Writing one installs something that runs without the gate seeing what it runs then, so the write is put to the
 * owner as one that loosens a protection: the model's file writes (gate/classify.ts `installsRunByItself`), a
 * capability given such a file by path (capabilities/risk.ts), and `do` typed at a terminal (capability-cli.ts).
 *
 * Pure text, no file system and no node modules: the web UI's form reads the same rule through `effectiveRisk`.
 * A path is read with either separator; a relative path counts by its own folders and name.
 */

/** File names that run by themselves wherever they are. */
const NAMES: ReadonlySet<string> = new Set([
  // Shell start-up files and a folder's environment (direnv).
  '.envrc', '.direnvrc', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases', '.profile', '.zshrc', '.zprofile',
  '.zshenv', '.zlogin', '.zlogout', '.kshrc', '.mkshrc', '.cshrc', '.tcshrc', '.login', '.logout', 'config.fish', '.inputrc',
  '.xprofile', '.xinitrc', '.xsession', '.xsessionrc', '.pam_environment', '.vimrc', '.exrc', '.gvimrc', '.nanorc', '.wgetrc', '.curlrc',
  // A repository's configuration that runs commands (hooks path, aliases, filters, fsmonitor, ssh command).
  '.gitattributes', '.gitmodules', '.gitconfig', '.lefthook.yml', 'lefthook.yml', '.pre-commit-config.yaml', '.pre-commit-hooks.yaml',
  // Package managers and project runners.
  'package.json', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'bunfig.toml', 'Makefile', 'makefile', 'GNUmakefile', 'justfile',
  'Justfile', '.justfile', 'Taskfile.yml', 'Taskfile.yaml', 'Rakefile', 'Gemfile', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini',
  'noxfile.py', 'conftest.py', 'pytest.ini', 'sitecustomize.py', 'usercustomize.py', 'Cargo.toml', 'build.rs', 'build.gradle',
  'build.gradle.kts', 'settings.gradle', 'pom.xml', 'CMakeLists.txt', 'meson.build', 'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml', 'devcontainer.json', '.devcontainer.json',
  // Lockfiles and requirement lists: a new worktree's setup installs from them by itself (runtime/worktree/setup.ts,
  // `auto`), and an install runs the packages' own scripts.
  'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'requirements.txt',
  // Tool servers and hooks any agent program loads.
  'hooks.json', 'mcp.json', '.mcp.json', 'claude_desktop_config.json',
  // Timers.
  'crontab', 'anacrontab',
]);

/** Name endings that run by themselves (make files under any name, a python path hook). */
const ENDINGS: readonly string[] = ['.mk', '.make', '.pth'];

/** Folders (as path segments) whose files run by themselves later. */
const FOLDERS: readonly (readonly string[])[] = [
  ['.git', 'hooks'], ['.git', 'config'], ['.git', 'info', 'attributes'], ['.husky'], ['.githooks'],
  ['.vscode', 'settings.json'], ['.vscode', 'tasks.json'], ['.vscode', 'launch.json'], ['.idea'], ['.devcontainer'],
  ['.cargo', 'config.toml'], ['.cargo', 'config'],
  ['.ssh'], ['.config', 'git'], ['.config', 'direnv'], ['.config', 'fish'], ['.config', 'autostart'], ['.config', 'systemd'],
  ['.config', 'environment.d'], ['.config', 'plasma-workspace', 'env'], ['.local', 'share', 'systemd'], ['Library', 'LaunchAgents'],
  ['etc', 'cron.d'], ['etc', 'cron.hourly'], ['etc', 'cron.daily'], ['etc', 'cron.weekly'], ['etc', 'cron.monthly'],
  ['var', 'spool', 'cron'], ['etc', 'profile.d'], ['etc', 'systemd'],
  // GoodVibes' own: hooks, settings (the worktree setup in a project's settings), tool servers, plugins and skills.
  ['.goodvibes'],
];

function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.');
}

function containsRun(segments: readonly string[], run: readonly string[]): boolean {
  for (let at = 0; at + run.length <= segments.length; at += 1) {
    if (run.every((word, offset) => segments[at + offset] === word)) return true;
  }
  return false;
}

/**
 * Whether a file at `path` is one a program runs by itself later (by its name, its ending, or a folder it is in).
 * `searchPath`: the folders on the program search path, written as absolute paths; a file put in one runs whenever its
 * name is typed.
 */
export function pathRunsByItself(path: string, searchPath: readonly string[] = []): boolean {
  const segments = segmentsOf(path);
  const name = segments.at(-1);
  if (name === undefined) return false;
  if (NAMES.has(name) || ENDINGS.some((ending) => name.endsWith(ending) && name.length > ending.length)) return true;
  if (FOLDERS.some((run) => containsRun(segments, run))) return true;
  const normal = `/${segments.join('/')}`;
  return searchPath.some((folder) => {
    const at = `/${segmentsOf(folder).join('/')}`;
    return at !== '/' && normal.startsWith(`${at}/`) && !normal.slice(at.length + 1).includes('/');
  });
}
