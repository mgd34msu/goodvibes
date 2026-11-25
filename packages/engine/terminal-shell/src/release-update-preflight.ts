import { spawnSync } from 'node:child_process';
import { PREVIOUS_FILE_SUFFIX } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { describeDaemonUpdates, type DaemonUpdateVerbs } from './daemon-update-status.js';
import { daemonCapabilityAction, runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import {
  UPDATE_APPLY, UPDATE_CHECK, UPDATE_DAEMON, UPDATE_READ_REVIEW, UPDATE_REVIEW, UPDATE_ROLLBACK, UPDATE_SAVE_REVIEW, type CapabilityDefinition,
} from '@goodvibes/engine/platform/platform/capabilities';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { ActionDescription, CommandActionContext } from './command-actions/types.js';
import { detectInstallKind } from '@goodvibes/engine/platform/platform/runtime/install-kind';
import type { InstallKind } from '@goodvibes/engine/platform/platform/runtime/operations';
import {
  compareVersions,
  normalizeVersion,
  resolveLatestReleaseTag,
  type UpdateFetchLike,
} from '@goodvibes/engine/platform/platform/runtime/self-update';
export interface ReleaseUpdateCheck {
  readonly latestTag: string;
  readonly isCurrent: boolean;
}
export async function checkReleaseUpdate(
  fetchImpl: UpdateFetchLike,
  currentVersion: string,
  latestUrl: string,
): Promise<ReleaseUpdateCheck> {
  const latestTag = await resolveLatestReleaseTag(fetchImpl, latestUrl);
  return { latestTag, isCurrent: compareVersions(currentVersion, latestTag) >= 0 };
}
export function requireBinaryUpdateInstall(
  execPath: string,
  print: (line: string) => void,
  fallback: (kind: Exclude<InstallKind, 'binary'>) => string,
  rollback = false,
): boolean {
  const kind = detectInstallKind(execPath);
  if (kind === 'binary') return true;
  const detected = kind === 'bun-global-package' ? 'bun/npm package install' : 'running from source';
  print(
    [
      `This install is not a self-updatable binary install (detected: ${detected})${rollback ? ', so there is no kept previous binary to roll back to.' : '.'}`,
      rollback ? `Install a specific version with your package manager instead, e.g.: ${fallback(kind)}` : `Update with: ${fallback(kind)}`,
    ].join('\n'),
  );
  return false;
}
/** Resolve and announce a real target before product-specific verified artifact staging. */
export async function prepareReleaseUpdate<Asset extends object | string>(
  options: {
    readonly execPath: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly fetchImpl: UpdateFetchLike;
    readonly currentVersion: string;
    readonly print: (line: string) => void;
    readonly signal?: AbortSignal | undefined;
  },
  policy: {
    readonly latestUrl: string;
    readonly downloadBase: (tag: string) => string;
    readonly asset: (platform: NodeJS.Platform, arch: string) => Asset | null;
    readonly fallback: (kind: Exclude<InstallKind, 'binary'>) => string;
    readonly unsupportedSuffix: string;
    readonly assertActive?: (() => void) | undefined;
    readonly target?: ((tag: string) => void) | undefined;
    readonly repairRequired?: ((tag: string) => boolean) | undefined;
  },
): Promise<{ readonly latestTag: string; readonly asset: Asset; readonly baseUrl: string } | null> {
  if (!requireBinaryUpdateInstall(options.execPath, options.print, policy.fallback)) return null;
  policy.assertActive?.();
  const latestTag = await resolveLatestReleaseTag(options.fetchImpl, policy.latestUrl, options.signal ? { signal: options.signal } : {});
  policy.assertActive?.();
  const comparison = compareVersions(options.currentVersion, latestTag);
  const repair = comparison === 0 && policy.repairRequired?.(latestTag) === true;
  if (comparison > 0 || comparison === 0 && !repair) {
    options.print(`Already current: running v${normalizeVersion(options.currentVersion)}, latest release is ${latestTag}.`);
    return null;
  }
  const asset = policy.asset(options.platform, options.arch);
  if (!asset) {
    options.print(
      `No prebuilt binaries are published for ${options.platform}-${options.arch}; cannot self-update.${policy.unsupportedSuffix}`,
    );
    return null;
  }
  policy.target?.(latestTag);
  options.print(repair ? `Repairing the installed GoodVibes suite at ${latestTag}. Downloading and verifying...`
    : `Update available: ${latestTag} (running v${normalizeVersion(options.currentVersion)}). Downloading and verifying...`);
  return { latestTag, asset, baseUrl: policy.downloadBase(latestTag) };
}

export function reportUpdateRollback(
  options: { readonly execPath: string; readonly print: (line: string) => void },
  restored: readonly { readonly label: string; readonly path: string }[],
  additional: readonly { readonly label: string; readonly path: string }[],
  footer: () => readonly string[],
): void {
  const targets = [...restored, ...additional];
  if (!targets.length) {
    options.print(
      `No previous version is kept beside this install (nothing at ${options.execPath}${PREVIOUS_FILE_SUFFIX}). The previous version is kept from the next update onward.`,
    );
    return;
  }
  options.print(
    [
      'Rolled back to the previously installed version.',
      ...targets.map(
        (target) => `  ${target.label}: ${target.path} (the replaced version is kept at ${target.path}${PREVIOUS_FILE_SUFFIX})`,
      ),
      '',
      ...footer(),
    ].join('\n'),
  );
}
export interface SelfUpdateInvocation {
  readonly fetchImpl: UpdateFetchLike;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly print: (line: string) => void;
}

/**
 * `/update`, described once (command-actions/) for both terminal apps. Typed by a person it opens the System
 * place on Updates (`opens`); its actions are the daemon's capabilities (capabilities/builtin/system-updates.ts,
 * system.ts update.daemon): look for a newer release, install it, go back to the kept previous version, see the
 * daemon's own updates, and see this install's update state and keep it in a file. The daemon holds the install:
 * one suite on this machine.
 */
export function createSelfUpdateCommand<Context extends CommandActionContext & { print(message: string): void }>(policy: {
  /** The connected daemon's own update loop, followed on screen while an install it started runs. */
  readonly daemon?: ((context: Context) => DaemonUpdateVerbs) | undefined;
  /** How this program reaches the daemon for a capability (its `capability-binding.ts`). */
  readonly capability: DaemonCapabilityBinding<Context>;
}): DescribedCommand<Context> {
  const daemonOwn = (definition: CapabilityDefinition<never>): ActionDescription<Context> => daemonCapabilityAction<Context>(definition, policy.capability);
  return defineCommand<Context>({
    name: 'update',
    title: 'Updates',
    summary: 'See whether a newer release is out, install it, or go back to the version before',
    group: 'Product',
    report: 'check',
    opens: 'system/updates',
    actions: [
      daemonOwn(UPDATE_CHECK as CapabilityDefinition<never>),
      daemonOwn(UPDATE_APPLY as CapabilityDefinition<never>),
      daemonOwn(UPDATE_ROLLBACK as CapabilityDefinition<never>),
      // update.daemon (capabilities/builtin/system.ts). A person typing it at a terminal that can redraw a line also sees
      // an install the check started through to the new version (the same update.status and update.check, followed on
      // screen); a place, a model and a script get the capability's answer.
      {
        ...daemonCapabilityAction<Context>(UPDATE_DAEMON, policy.capability),
        async run(values, context) {
          if (policy.daemon && context.invokedByModel !== true && context.printLive) {
            return describeDaemonUpdates(policy.daemon(context), values.now === 'yes', { print: context.print, printLive: context.printLive });
          }
          const answer = await runDaemonCapability(UPDATE_DAEMON.capability.id, values, context, policy.capability);
          return answer.detail ?? '';
        },
      },
      daemonOwn(UPDATE_REVIEW as CapabilityDefinition<never>),
      daemonOwn(UPDATE_SAVE_REVIEW as CapabilityDefinition<never>),
      daemonOwn(UPDATE_READ_REVIEW as CapabilityDefinition<never>),
    ],
  });
}

export { retainSuiteUpdateConfiguration, type SuiteUpdateConfigurationSource } from '@goodvibes/engine/platform/platform/runtime/self-update';

/** Runs a fixed program and reports its exit status and output; injectable so tests never shell out to a real systemctl. */
export type RunCommand = (command: string, args: string[]) => { readonly status: number | null; readonly stdout: string };

const defaultRunCommand: RunCommand = (command, args) => {
  try {
    const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8' });
    return { status: result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

export interface DaemonServiceRestartInfo {
  readonly managed: boolean;
  readonly unitName: string;
  readonly restartCommand: string;
}

/** The settings the daemon's service name is read from; without them the platform's default name is used. */
export interface DaemonServiceNameSource {
  get?(key: string): unknown;
  describeConfigKeySource?(key: 'service.serviceName'): { readonly tier: string; readonly effectiveOrigin?: string | undefined } | undefined;
}

/**
 * Whether the daemon is running as a systemd user service, so the message after
 * an update can name the real restart command instead of assuming one. Only
 * Linux/systemd is checked: launchd and Scheduled Tasks are not restarted with
 * `systemctl`, so there this reports "not managed here" rather than printing a
 * command that would not work.
 */
export async function detectDaemonServiceManaged(
  platform: NodeJS.Platform,
  configManager: DaemonServiceNameSource,
  runCommand: RunCommand = defaultRunCommand,
): Promise<DaemonServiceRestartInfo> {
  // Loaded here, not at start-up: the service module is needed only after an update replaced the daemon.
  const [{ MANAGED_SERVICE_NAME }, { resolveServiceName }] = await Promise.all([
    import('@goodvibes/engine/platform/platform/daemon/managed-daemon-service'),
    import('@goodvibes/engine/platform/platform/daemon/service-manager'),
  ]);
  const unitName = resolveServiceName({
    get: (key) => configManager.get?.(key),
    // A source that cannot say where the name came from is read like one set by the owner: the stored value, else the default.
    describeConfigKeySource: (key) => {
      const source = configManager.describeConfigKeySource?.(key);
      if (source === undefined) return { tier: 'unknown' };
      return source.effectiveOrigin === undefined ? { tier: source.tier } : { tier: source.tier, effectiveOrigin: source.effectiveOrigin };
    },
  }, MANAGED_SERVICE_NAME);
  if (platform !== 'linux') {
    return { managed: false, unitName, restartCommand: '' };
  }
  const result = runCommand('systemctl', ['--user', 'is-active', `${unitName}.service`]);
  const managed = result.status === 0 && result.stdout.trim() === 'active';
  return { managed, unitName, restartCommand: `systemctl --user restart ${unitName}.service` };
}

/**
 * The footer of the update or rollback report: the daemon's restart command
 * when the change replaced goodvibes-daemon and its service is managed here.
 * The service is asked only when the daemon was replaced.
 */
export async function daemonRestartFooter(
  result: { readonly programs: readonly string[] },
  platform: NodeJS.Platform,
  configManager: DaemonServiceNameSource,
  runCommand?: RunCommand,
): Promise<readonly string[]> {
  if (!result.programs.includes('goodvibes-daemon')) return [];
  const service = await detectDaemonServiceManaged(platform, configManager, runCommand);
  return service.managed ? [`Daemon restart: ${service.restartCommand}`] : [];
}
/** Shared terminal report for the actual products/directories the suite changed. */
export function formatSuiteUpdateReport(result: {
  readonly version: string; readonly programs: readonly string[];
  readonly directoryPaths: readonly string[]; readonly preservedPaths: readonly string[];
}, action: 'updated' | 'restored', footer: readonly string[] = []): string {
  const label = action === 'updated' ? 'Updated' : 'Restored';
  return [
    `${label} GoodVibes ${result.version}: ${result.programs.join(', ')}.`,
    ...result.directoryPaths.map(path => `  ${action} directory: ${path}`),
    ...result.preservedPaths.map(path => `  retained earlier backup: ${path}`),
    `Restart the running GoodVibes programs to use the ${action === 'updated' ? 'installed' : 'restored'} release.`,
    ...footer,
  ].join('\n');
}
