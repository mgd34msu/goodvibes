/**
 * The managed daemon service definition every path installs: the daemon
 * CLI's service subcommands and the terminal app's `service` commands build
 * the one `PlatformServiceManager` here, under the platform's one unit name
 * (daemon-service-default.ts), so every path installs, reports and starts the
 * identical unit.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveDaemonServiceDefault } from '@goodvibes-jev/engine/platform/platform/daemon/daemon-service-default';
import { PlatformServiceManager } from '@goodvibes-jev/engine/platform/platform/daemon/service-manager';

/** Structurally derived from `PlatformServiceManager`'s own constructor, the
 * platform's public `platform/daemon` entry point only re-exports the class and
 * `ManagedServiceStatus`, not the options/definition/action-runner interfaces
 * by name, so we pull their shapes off the class itself rather than reaching
 * past the package's declared export map. */
type ManagedServiceManagerOptions = ConstructorParameters<typeof PlatformServiceManager>[1];
type ManagedServiceDefinition = NonNullable<ManagedServiceManagerOptions['definitionOverride']>;
export type ManagedServiceActionRunner = NonNullable<ManagedServiceManagerOptions['actionRunner']>;

// The daemon's one unit name on this platform, owned by the platform
// (daemon-service-default.ts). Any explicit stored name or invocation overlay
// outranks this fallback.
export const MANAGED_SERVICE_NAME = resolveDaemonServiceDefault();
export const MANAGED_SERVICE_DESCRIPTION = 'GoodVibes daemon (shared session broker + companion host)';

/** The description the daemon's own `--install-service` and service routes give the unit they write. */
const DAEMON_ROUTE_SERVICE_DESCRIPTION = 'goodvibes omnichannel daemon host';

/**
 * Who wrote the service definition at a path: `absent` (nothing there),
 * `product` (this product's own definition: it names
 * {@link MANAGED_SERVICE_DESCRIPTION} or the daemon routes' description; a
 * LaunchAgent carries it in its `GoodVibesManagedBy` key), `other` (anything
 * else, a symlink included: a definition the owner keeps elsewhere is never
 * written through), or `unreadable`.
 */
export type ManagedDefinitionOwner = 'absent' | 'product' | 'other' | 'unreadable';

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlUnescape(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? '');
}

type DefinitionFile = { readonly contents: string } | { readonly state: Exclude<ManagedDefinitionOwner, 'product'> };

function readDefinitionFile(path: string): DefinitionFile {
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry === undefined) return { state: 'absent' };
    if (!entry.isFile()) return { state: 'other' };
    return { contents: readFileSync(path, 'utf-8') };
  } catch {
    return { state: 'unreadable' };
  }
}

/** One read of the definition file; the service manager is not asked. */
export function readManagedDefinitionOwner(path: string): ManagedDefinitionOwner {
  const file = readDefinitionFile(path);
  if ('state' in file) return file.state;
  return [MANAGED_SERVICE_DESCRIPTION, DAEMON_ROUTE_SERVICE_DESCRIPTION].some((mark) => file.contents.includes(mark)) ? 'product' : 'other';
}

/**
 * The absolute working directory an existing unit or plist names, or undefined
 * when it names none or one this reader cannot take literally (a `-`/`~` prefixed systemd value).
 */
export function readDefinitionWorkingDirectory(path: string): string | undefined {
  const file = readDefinitionFile(path);
  if ('state' in file) return undefined;
  const { contents } = file;
  const systemd = /^WorkingDirectory=(.*)$/m.exec(contents)?.[1]?.replaceAll('%%', '%');
  const launchd = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  const value = systemd ?? (launchd === undefined ? undefined : xmlUnescape(launchd));
  return value !== undefined && isAbsolute(value) ? value : undefined;
}

/**
 * Resolve the unit name the platform's `PlatformServiceManager` would actually
 * manage, from config alone. Mirrors the platform's own internal `resolveServiceName()` precedence exactly:
 * the product default replaces only the shared schema's pure default origin;
 * configured names and overlays remain first, with the product fallback when
 * unset or blank. Takes a minimal accessor/provenance shape rather than the full ConfigManager class so
 * snapshot code and tests can pass whatever config accessor they already
 * hold.
 */
export function resolveConfiguredServiceName(config: {
  get(key: string): unknown;
  describeConfigKeySource?(key: 'service.serviceName'): { readonly tier: string; readonly effectiveOrigin?: string };
}, defaultServiceName: string = MANAGED_SERVICE_NAME): string {
  const source = config.describeConfigKeySource?.('service.serviceName');
  if (source?.tier === 'default' && (source.effectiveOrigin === undefined || source.effectiveOrigin === 'default')) return defaultServiceName;
  const raw = config.get('service.serviceName');
  const configured = raw === undefined || raw === null ? '' : String(raw).trim();
  return configured || defaultServiceName;
}

export interface BuildManagedDaemonServiceManagerParams {
  readonly binaryPath: string;
  /**
   * The GoodVibes tree home, GOODVIBES_HOME-overridable, used to root the
   * ConfigManager and the daemon's own `--daemon-home` state directory. NEVER
   * used for unit-file path resolution: see `unitHomeDir` for that. A unit
   * path search rooted here would look for `~/.config/systemd/user/` under
   * whatever GOODVIBES_HOME points at instead of the real login home systemd
   * actually reads.
   */
  readonly homeDir: string;
  /** Resolved identity/settings tier; independent of the tree and login homes. */
  readonly daemonHomeDirectory?: string | undefined;
  /**
   * The LOGIN user's home, where `~/.config/systemd/user/` (or the launchd/
   * Windows equivalent) actually lives, regardless of any GOODVIBES_HOME/
   * GOODVIBES_DAEMON_HOME override in effect. Threaded through to
   * `PlatformServiceManager`'s own `homeDirectory` option, which resolves the
   * unit file PATH directly from it. Required (no default to `homeDir`) so a
   * caller cannot silently reintroduce the GOODVIBES_HOME-rooted bug by
   * omission.
   */
  readonly unitHomeDir: string;
  /** Defaults to `homeDir`, overridable so tests can scope both to one tempdir. */
  readonly workingDirectory?: string | undefined;
  /** The caller's own settings; a read-only `ConfigManager` rooted at `homeDir` otherwise. */
  readonly configManager?: ConfigManager | undefined;
  /** The settings surface a default `ConfigManager` reads. Both products keep their state under `tui`. */
  readonly surfaceRoot?: string | undefined;
  /** Injectable systemctl/launchctl/schtasks runner so tests never touch the host. */
  readonly actionRunner?: ManagedServiceActionRunner | undefined;
  /** Optional retained executable restriction, checked by the native service owner. */
  readonly assertCurrent?: (() => void) | undefined;
}

/**
 * Build the ONE `PlatformServiceManager` this tool manages, the single
 * source of truth for the unit's definition (`ExecStart` command/args, name,
 * description). The daemon CLI and the terminal app's onboarding call this,
 * so every path installs the identical unit.
 */
export function buildManagedDaemonServiceManager(params: BuildManagedDaemonServiceManagerParams): PlatformServiceManager {
  const workingDirectory = params.workingDirectory ?? params.homeDir;
  const configManager = params.configManager ?? new ConfigManager({
    workingDir: workingDirectory,
    homeDir: params.homeDir,
    surfaceRoot: params.surfaceRoot ?? 'tui',
    readOnly: true,
  });
  // The unit's ExecStart deliberately carries NO endpoint flags
  // (--hostname/--port): the daemon resolves controlPlane.hostMode/host/port
  // from the user's settings at boot, so a later config change (or a host
  // already configured for hostMode=network / a non-default port) keeps its
  // endpoint without a unit rewrite. Baking endpoint values here is what
  // silently re-pinned custom-configured hosts back to the values current at
  // install time. scripts/install.sh writes no unit of its own: it runs
  // `goodvibes-daemon install-service` and `refresh-service`, so this is the
  // one definition on every path.
  // `--daemon-home` names the daemon's own STATE directory (operator tokens,
  // the daemon settings tier). The default one, `<home>/.goodvibes/daemon`, is
  // what the daemon resolves with no flag, so the unit carries the flag only
  // for a selected directory: any explicit daemon home marks the process as
  // relocated, and a relocated daemon never updates itself.
  const defaultDaemonHome = join(params.homeDir, '.goodvibes', 'daemon');
  const daemonHome = params.daemonHomeDirectory ?? defaultDaemonHome;
  const definition: ManagedServiceDefinition = {
    name: resolveConfiguredServiceName(configManager),
    description: MANAGED_SERVICE_DESCRIPTION,
    workingDirectory,
    command: params.binaryPath,
    args: daemonHome === defaultDaemonHome ? [] : ['--daemon-home', daemonHome],
    // Service managers do not inherit the invoking shell's relocated tree.
    env: params.homeDir === params.unitHomeDir ? {} : { GOODVIBES_HOME: params.homeDir },
    // The owner's restart policy, the same one every other path honours.
    restartOnFailure: configManager.get('service.restartOnFailure') !== false,
  };
  return new PlatformServiceManager(configManager, {
    workingDirectory,
    // Unit paths resolve from the LOGIN home, never the (possibly
    // GOODVIBES_HOME-relocated) tree home above, see `unitHomeDir`'s doc.
    homeDirectory: params.unitHomeDir,
    definitionOverride: definition,
    defaultServiceName: MANAGED_SERVICE_NAME,
    defaultServiceDescription: MANAGED_SERVICE_DESCRIPTION,
    actionRunner: params.actionRunner,
    assertCurrent: params.assertCurrent,
    // No `featureFlags` passed: `isFeatureGateEnabled` treats a missing reader
    // as always-open. Both consumers here are the user's explicit request to
    // manage the service, unlike the daemon's own HTTP /api/service/* routes
    // (which gate on the real, config-backed 'service-management' flag).
  });
}

export interface ResolveDaemonBinaryOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** `import.meta.url` of the caller so the packaged `bin/goodvibes-daemon` can be located. */
  readonly moduleUrl?: string | undefined;
  readonly execPath?: string | undefined;
  readonly fileExists?: ((path: string) => boolean) | undefined;
}

/**
 * Resolve the absolute path to the installed daemon binary used for the unit's
 * `ExecStart`. Preference order:
 *   1. `GOODVIBES_DAEMON_BINARY` env override.
 *   2. The packaged `bin/goodvibes-daemon` launcher next to this checkout.
 *   3. `process.execPath` when this IS the compiled daemon binary.
 *   4. Bare `goodvibes-daemon` (resolved on PATH by systemd's service environment).
 *
 * It carries no CLI-specific dependency: it only needs the CALLER's own
 * `import.meta.url` to locate the packaged `bin/` directory two levels up
 * from any `src/<layer>/*.ts` file of a product.
 */
export function resolveInstalledDaemonBinary(options: ResolveDaemonBinaryOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.GOODVIBES_DAEMON_BINARY?.trim();
  if (override) return override;

  const fileExists = options.fileExists ?? existsSync;
  if (options.moduleUrl) {
    try {
      // e.g. src/daemon/service-commands.ts -> package root is two directories up.
      const here = dirname(fileURLToPath(options.moduleUrl));
      const launcher = join(here, '..', '..', 'bin', 'goodvibes-daemon');
      if (fileExists(launcher)) return launcher;
    } catch {
      // fall through to execPath / PATH resolution
    }
  }

  const execPath = options.execPath ?? process.execPath;
  if (execPath && basename(execPath) === 'goodvibes-daemon') return execPath;

  return 'goodvibes-daemon';
}

