/**
 * sandbox-home.ts, what a sandbox boundary shows of the home directory.
 *
 * Every bubblewrap boundary the product builds (the exec tool's per-command
 * boundary, sandbox sessions, and `runContained` for programs a project, model
 * or plugin chose, contract gates among them) masks $HOME with a private tmpfs
 * (exec/sandbox.ts `buildBwrapArgv`). This is the one policy for what comes
 * back through that mask, applied by `buildBwrapArgv` itself so no caller has
 * a second copy. It is one table, {@link HOME_BINDS}: a toolchain's install
 * and shims are shown read-only, its caches writable (a build outside the
 * sandbox writes them anyway, and they hold nothing secret). A new toolchain
 * is a new row.
 *
 * The owner's secrets are never shown (the GoodVibes state directory, ssh and
 * gpg keys, cloud and registry credentials, browser profiles and caches, shell
 * history): a row that is one of them, lies inside one, or contains home itself
 * is left out, and a secret inside a shown folder is covered again.
 *
 * A folder a row names that does not exist is skipped; the mask is a writable
 * tmpfs, so a cache a build creates there works for that run and is discarded.
 *
 * Cost: a few stat calls per boundary built.
 */
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

/** Paths under home the boundary never shows, relative to home. */
const HOME_SECRETS: readonly string[] = [
  '.goodvibes', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store',
  '.config/gcloud', '.config/gh', '.config/hub', '.config/op', '.local/share/keyrings',
  '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.yarnrc', '.yarnrc.yml', '.gem/credentials',
  '.cargo/credentials', '.cargo/credentials.toml',
  '.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge',
  '.cache/google-chrome', '.cache/chromium', '.cache/mozilla', '.cache/BraveSoftware', '.cache/microsoft-edge',
  '.bash_history', '.zsh_history', '.local/share/fish/fish_history', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history',
];

/** Paths the boundary already binds read-only from the host. */
const SYSTEM_ROOTS: readonly string[] = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];

/** The setting that adds a writable path to every sandbox boundary the exec tool and contract gates run in. */
export const SANDBOX_EXTRA_PATH_SETTING = 'sandbox.workspaceWritable';

/** Where the table's rows resolve from: home, the environment, and the XDG folders with their defaults. */
interface HomeContext {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cache: string;
  readonly config: string;
  readonly data: string;
  readonly gopath: readonly string[];
  readonly cargo: string;
  readonly bun: string;
}

interface HomeBindRow {
  readonly paths: (context: HomeContext) => readonly (string | undefined)[];
  readonly access: 'read' | 'write';
  /** Why the row exists, in one line. */
  readonly why: string;
}

/** An absolute path from a variable, else undefined. */
function envPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && isAbsolute(value) ? resolve(value) : undefined;
}

/** What comes back through the home mask. Each row resolves its variable with its documented default. */
const HOME_BINDS: readonly HomeBindRow[] = [
  // Installs and shims: read-only.
  { access: 'read', paths: (c) => [envPath(c.env, 'RUSTUP_HOME') ?? join(c.home, '.rustup')], why: 'rustup toolchains the cargo and rustc shims run' },
  { access: 'read', paths: (c) => [join(c.cargo, 'bin'), join(c.cargo, 'config.toml'), join(c.cargo, 'config')], why: 'cargo shims and installed binaries, and cargo configuration' },
  { access: 'read', paths: (c) => [envPath(c.env, 'NVM_DIR') ?? join(c.home, '.nvm')], why: 'node versions nvm installed' },
  { access: 'read', paths: (c) => [envPath(c.env, 'PYENV_ROOT') ?? join(c.home, '.pyenv')], why: 'python versions and shims pyenv installed' },
  { access: 'read', paths: (c) => [envPath(c.env, 'ASDF_DATA_DIR') ?? join(c.home, '.asdf')], why: 'tool versions and shims asdf installed' },
  { access: 'read', paths: (c) => [envPath(c.env, 'MISE_DATA_DIR') ?? join(c.data, 'mise')], why: 'tool versions and shims mise installed' },
  { access: 'read', paths: (c) => [join(c.bun, 'bin')], why: 'the bun binary and globally installed bun tools' },
  { access: 'read', paths: (c) => c.gopath.map((entry) => join(entry, 'bin')), why: 'go tools installed with go install' },
  { access: 'read', paths: (c) => [join(c.home, '.gitconfig'), join(c.config, 'git')], why: 'the user-level git configuration builds and tools read' },
  { access: 'read', paths: (c) => (c.env.PATH ?? '').split(delimiter).filter((entry) => isAbsolute(entry)).map((entry) => resolve(entry)).filter((entry) => within(entry, c.home)), why: 'programs on PATH installed inside home' },
  // Caches: writable.
  { access: 'write', paths: (c) => [envPath(c.env, 'GOCACHE') ?? join(c.cache, 'go-build')], why: 'go build cache' },
  { access: 'write', paths: (c) => [envPath(c.env, 'GOMODCACHE') ?? join(c.gopath[0]!, 'pkg', 'mod'), ...c.gopath.map((entry) => join(entry, 'pkg'))], why: 'go module download cache' },
  { access: 'write', paths: (c) => [join(c.cargo, 'registry'), join(c.cargo, 'git')], why: 'cargo registry index, crate downloads and git checkouts' },
  { access: 'write', paths: (c) => [envPath(c.env, 'BUN_INSTALL_CACHE_DIR') ?? join(c.bun, 'install', 'cache')], why: 'bun install package cache' },
  { access: 'write', paths: (c) => [envPath(c.env, 'npm_config_cache') ?? envPath(c.env, 'NPM_CONFIG_CACHE') ?? join(c.home, '.npm')], why: 'npm package cache' },
  { access: 'write', paths: (c) => [envPath(c.env, 'PNPM_STORE_DIR') ?? join(c.data, 'pnpm', 'store')], why: 'pnpm content-addressed store' },
  { access: 'write', paths: (c) => [envPath(c.env, 'YARN_CACHE_FOLDER') ?? join(c.cache, 'yarn'), join(c.home, '.yarn', 'berry', 'cache')], why: 'yarn package cache' },
  { access: 'write', paths: (c) => [envPath(c.env, 'PIP_CACHE_DIR') ?? join(c.cache, 'pip'), envPath(c.env, 'UV_CACHE_DIR') ?? join(c.cache, 'uv')], why: 'pip and uv download and wheel caches' },
  { access: 'write', paths: (c) => [c.cache], why: 'the XDG cache folder other tools fill (its browser caches stay hidden)' },
];

export interface SandboxHomeBind {
  readonly path: string;
  readonly access: 'read' | 'write';
}

export interface SandboxHomeView {
  /** Shown after the mask, shallowest first, so a deeper bind of other access wins inside its parent. */
  readonly binds: readonly SandboxHomeBind[];
  /** Secrets inside a shown folder, covered again after everything is shown. */
  readonly hidden: readonly { readonly path: string; readonly kind: 'file' | 'dir' }[];
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function contextOf(home: string, env: NodeJS.ProcessEnv): HomeContext {
  const gopath = (env.GOPATH ?? '').split(delimiter).filter((entry) => isAbsolute(entry)).map((entry) => resolve(entry));
  return {
    home,
    env,
    cache: envPath(env, 'XDG_CACHE_HOME') ?? join(home, '.cache'),
    config: envPath(env, 'XDG_CONFIG_HOME') ?? join(home, '.config'),
    data: envPath(env, 'XDG_DATA_HOME') ?? join(home, '.local', 'share'),
    gopath: gopath.length > 0 ? gopath : [join(home, 'go')],
    cargo: envPath(env, 'CARGO_HOME') ?? join(home, '.cargo'),
    bun: envPath(env, 'BUN_INSTALL') ?? join(home, '.bun'),
  };
}

/** What the boundary shows of `home`: the table's paths that exist, outside the system roots and the secrets. */
export function sandboxHomeView(home: string, env: NodeJS.ProcessEnv = process.env): SandboxHomeView {
  const context = contextOf(resolve(home), env);
  const root = context.home;
  const secrets = [...HOME_SECRETS.map((relative) => join(root, relative)),
    // Cargo keeps registry tokens in its home, wherever CARGO_HOME puts it.
    join(context.cargo, 'credentials'), join(context.cargo, 'credentials.toml'),
    // Git's credential store keeps tokens under the XDG config folder, wherever XDG_CONFIG_HOME puts it.
    join(context.config, 'git', 'credentials')];
  const candidates: SandboxHomeBind[] = [];
  for (const row of HOME_BINDS) {
    for (const path of row.paths(context)) {
      if (path === undefined || path === '/' || within(root, path)) continue; // home itself, or above it
      if (SYSTEM_ROOTS.some((system) => within(path, system))) continue;
      if (secrets.some((secret) => within(path, secret)) || !existsSync(path)) continue;
      candidates.push({ path, access: row.access });
    }
  }
  // Shallowest first; a path whose nearest shown ancestor has the same access needs no bind of its own.
  const depth = (path: string): number => path.split(sep).length;
  candidates.sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const binds: SandboxHomeBind[] = [];
  for (const candidate of candidates) {
    const parent = [...binds].reverse().find((shown) => within(candidate.path, shown.path));
    if (parent !== undefined && (parent.access === candidate.access || parent.path === candidate.path)) continue;
    binds.push(candidate);
  }
  const hidden: { path: string; kind: 'file' | 'dir' }[] = [];
  for (const secret of secrets) {
    if (!binds.some((shown) => within(secret, shown.path))) continue;
    try { hidden.push({ path: secret, kind: statSync(secret).isDirectory() ? 'dir' : 'file' }); } catch { /* absent: nothing to cover */ }
  }
  return { binds, hidden };
}

/** The bubblewrap arguments that show the view's folders through the home mask, in order. */
export function sandboxHomeBindArgs(view: SandboxHomeView): string[] {
  return view.binds.flatMap((bind) => [bind.access === 'write' ? '--bind-try' : '--ro-bind-try', bind.path, bind.path]);
}

/** The bubblewrap arguments that cover the secrets inside the shown folders again; emitted after every other bind. */
export function sandboxHomeCoverArgs(view: SandboxHomeView): string[] {
  return view.hidden.flatMap((secret) => secret.kind === 'dir' ? ['--tmpfs', secret.path] : ['--ro-bind', '/dev/null', secret.path]);
}

const MISSING = /no such file|not found|cannot access|enoent|does not exist|could not (?:open|read|find)/i;
const REFUSED_WRITE = /read-only file system|erofs|permission denied|eacces|operation not permitted|eperm/i;

/** The first path under `root` a line names. */
function pathIn(line: string, root: string): string | undefined {
  const start = line.indexOf(`${root}${sep}`);
  return start < 0 ? undefined : line.slice(start).split(/[\s'"`:,;)\]]/)[0];
}

/**
 * One sentence for a contained command whose output names a path in the home
 * directory it could not reach: a missing path the boundary hides, or a write
 * refused in a folder it shows read-only. Undefined when the output names
 * neither. `settingApplies` is false for a caller that does not apply
 * sandbox.workspaceWritable, which then is not named.
 */
export function hiddenHomePathHint(output: string, home: string, view: SandboxHomeView, extraShown: readonly string[] = [], settingApplies = true): string | undefined {
  const root = resolve(home);
  const extra = extraShown.map((path) => resolve(path));
  const shownBy = (path: string): SandboxHomeBind | undefined => [...view.binds].reverse().find((bind) => within(path, bind.path));
  for (const line of output.split('\n')) {
    const path = pathIn(line, root);
    if (path === undefined || extra.some((shown) => within(path, shown))) continue;
    const bind = shownBy(path);
    if (REFUSED_WRITE.test(line) && bind?.access === 'read') {
      return settingApplies
        ? `${path} is in ${bind.path}, which the sandbox shows read-only (a toolchain install, not a cache); change it outside the sandbox, or add ${bind.path} to ${SANDBOX_EXTRA_PATH_SETTING} to make it writable.`
        : `${path} is in ${bind.path}, which the sandbox shows read-only (a toolchain install, not a cache); change it outside the sandbox.`;
    }
    if (MISSING.test(line) && bind === undefined) {
      return settingApplies
        ? `${path} is in the home directory, which the sandbox hides except its toolchain installs and caches; add it to ${SANDBOX_EXTRA_PATH_SETTING} to show it (it is then writable), or move what the command needs into the workspace.`
        : `${path} is in the home directory, which the sandbox hides except its toolchain installs and caches; move what the command needs into its working directory.`;
    }
  }
  return undefined;
}
