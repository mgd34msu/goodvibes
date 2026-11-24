import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync, listBuiltinSubscriptionProviders } from '@goodvibes/engine/platform/platform/config';
import { PREVIOUS_FILE_SUFFIX } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { describeDaemonUpdates, type DaemonUpdateVerbs } from './daemon-update-status.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { CommandActionContext, InputDescription } from './command-actions/types.js';
import { choiceInput, readAction, textInput } from './described-command-kit.js';
import { detectInstallKind } from '@goodvibes/engine/platform/platform/runtime/install-kind';
import type { InstallKind } from '@goodvibes/engine/platform/platform/runtime/operations';
import {
  compareVersions,
  suiteUpdateRequiresRecovery,
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
 * What `/update review` prints and `/update save-review` saves, built once for
 * both. The saved file is this record as JSON; `/update read-review` reads any
 * file in this shape, whichever app saved it.
 */
interface UpdateReview {
  readonly version: 2;
  readonly exportedAt: number;
  readonly appVersion: string;
  readonly installKind: InstallKind;
  /** The newest published release, or why it could not be read. */
  readonly latest: { readonly tag: string; readonly isCurrent: boolean } | { readonly unknown: string };
  /** Where updates come from: the project's published releases. */
  readonly channel: string;
  /** True when a previous program is kept beside this one, so /update rollback has something to restore. */
  readonly rollbackRetained: boolean;
  readonly subscriptionProviders: readonly string[];
  readonly sandboxProfile: string;
}

/** The two sandbox settings the review names. */
export interface SandboxSettingsReader {
  get(key: 'sandbox.enabled' | 'sandbox.mcpIsolation'): unknown;
}

/** What one app supplies for its install review: where its facts are read and how a typed path is resolved. */
export interface InstallReviewSource<Context> {
  /** The release page the newest release is read from. */
  readonly channel: string;
  /** A typed file path, resolved against this app's working folder. */
  readonly resolvePath: (context: Context, path: string) => string;
  readonly settings: (context: Context) => SandboxSettingsReader;
  /** The subscription providers signed in or added here; the built-in ones are added to them. */
  readonly subscriptionProviders: (context: Context) => readonly string[];
  /** How many saved settings profiles this install keeps. */
  readonly savedProfiles: (context: Context) => number;
  /** How many secrets this install stores (their names only are counted). */
  readonly storedSecrets: (context: Context) => Promise<number>;
}

function buildUpdateReview<Context>(
  source: InstallReviewSource<Context>, context: Context, appVersion: string, latest: UpdateReview['latest'],
): UpdateReview {
  const config = source.settings(context);
  const builtinProviders = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
  return {
    version: 2,
    exportedAt: Date.now(),
    appVersion,
    installKind: detectInstallKind(process.execPath),
    latest,
    channel: source.channel,
    rollbackRetained: existsSync(`${process.execPath}${PREVIOUS_FILE_SUFFIX}`),
    subscriptionProviders: [...new Set([...builtinProviders, ...source.subscriptionProviders(context)])],
    sandboxProfile: `commands ${config.get('sandbox.enabled') === false ? 'host' : 'contained'}/mcp ${String(config.get('sandbox.mcpIsolation'))}`,
  };
}

function formatUpdateReview(review: UpdateReview, title: string): string {
  const latest = 'tag' in review.latest
    ? `${review.latest.tag}${review.latest.isCurrent ? ' (this is current)' : ' (newer than this one: /update apply installs it)'}`
    : `unknown (${review.latest.unknown})`;
  return [
    title,
    `  installed version: ${review.appVersion}`,
    `  latest release: ${latest}`,
    `  channel: ${review.channel}`,
    `  install kind: ${review.installKind}`,
    `  rollback copy: ${review.rollbackRetained ? 'kept beside this program; /update rollback restores it' : 'none kept (/update apply keeps one)'}`,
    `  subscription providers: ${review.subscriptionProviders.length}${review.subscriptionProviders.length > 0 ? ` (${review.subscriptionProviders.join(', ')})` : ''}; sign-ins survive an update`,
    `  sandbox profile: ${review.sandboxProfile}`,
  ].join('\n');
}

/** Parse a saved update review, refusing anything that is not one rather than printing "undefined" fields. */
function parseUpdateReview(text: string): UpdateReview {
  const value: unknown = JSON.parse(text);
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  const latest = record?.latest as Record<string, unknown> | undefined;
  if (
    !record
    || record.version !== 2
    || typeof record.appVersion !== 'string'
    || typeof record.installKind !== 'string'
    || typeof record.channel !== 'string'
    || typeof record.rollbackRetained !== 'boolean'
    || typeof record.sandboxProfile !== 'string'
    || !Array.isArray(record.subscriptionProviders)
    || !latest || (typeof latest.tag !== 'string' && typeof latest.unknown !== 'string')
  ) {
    throw new Error('the file is not an update state saved by /update save-review');
  }
  return record as unknown as UpdateReview;
}

/**
 * `/update`, described once (command-actions/) for both terminal apps: look
 * for a newer release, install it, go back to the kept previous version, see
 * the daemon's own updates, and see this install's update state and keep it
 * in a file. `/install`'s facts are in "See this install".
 */
export function createSelfUpdateCommand<Context extends CommandActionContext & { print(message: string): void }>(policy: {
  readonly workspaceDistribution: boolean;
  readonly workspaceGuidance: string;
  readonly version: string;
  readonly check: (fetchImpl: UpdateFetchLike, version: string) => Promise<ReleaseUpdateCheck>;
  readonly apply: (options: SelfUpdateInvocation, context: Context) => Promise<void>;
  readonly rollback: (options: Omit<SelfUpdateInvocation, 'fetchImpl' | 'currentVersion'>, context: Context) => Promise<void>;
  readonly onRecovery?: ((error: unknown, context: Context) => void) | undefined;
  readonly repairRequired?: ((tag: string, context: Context) => boolean) | undefined;
  /** The connected daemon's own update loop, which this app's update does not cover. */
  readonly daemon?: ((context: Context) => DaemonUpdateVerbs) | undefined;
  /** Where this install's update state is read, for the review, save-review and read-review actions. */
  readonly install: InstallReviewSource<Context>;
}): DescribedCommand<Context> {
  const install = policy.install;
  /** The newest published release, read once; a failed read is named, not guessed. */
  const readLatestRelease = async (): Promise<UpdateReview['latest']> => {
    try {
      const result = await policy.check(fetch as UpdateFetchLike, policy.version);
      return { tag: result.latestTag, isCurrent: result.isCurrent };
    } catch (error) {
      return { unknown: error instanceof Error ? error.message : String(error) };
    }
  };
  const inWorkspace = (): void => {
    if (policy.workspaceDistribution) throw commandRefusal(policy.workspaceGuidance);
  };
  const pathInput = (help: string): InputDescription => textInput({ id: 'path', label: 'File', help, why: 'a file path', kind: 'path', typed: { position: 1 } });
  const terminal = { terminalOnly: 'It updates the programs on the terminal app\'s machine.' } as const;
  return defineCommand<Context>({
    name: 'update',
    title: 'Updates',
    summary: 'See whether a newer release is out, install it, or go back to the version before',
    group: 'Product',
    report: 'check',
    actions: [
      readAction<Context>({
        id: 'check', label: 'See whether a newer release is out', word: 'check',
        sentence: 'Asks the release page for the newest release and compares it with the one running.',
        operator: terminal,
        async run(_values, context) {
          inWorkspace();
          let result: ReleaseUpdateCheck;
          try {
            result = await policy.check(fetch as UpdateFetchLike, policy.version);
          } catch (error) {
            throw commandRefusal(`Could not check for updates: ${error instanceof Error ? error.message : String(error)}`);
          }
          const repair = result.isCurrent && compareVersions(policy.version, result.latestTag) === 0 && policy.repairRequired?.(result.latestTag, context) === true;
          if (repair) return `The installed programs need repair at ${result.latestTag}. Align them: /update apply`;
          return result.isCurrent
            ? `Already current: running v${normalizeVersion(policy.version)} (latest release is ${result.latestTag}).`
            : `Update available: ${result.latestTag} (running v${normalizeVersion(policy.version)}). Install it: /update apply`;
        },
      }),
      {
        id: 'apply', label: 'Install the newer release', word: 'apply', inputs: [],
        sentence: 'The newest release is downloaded, checked and installed for every GoodVibes program here, until you change it; the version replaced is kept for going back.',
        done: '', touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'rollback',
        ownerOnly: { reason: 'it replaces the programs you are running', instead: 'Ask the owner to run /update apply.' },
        operator: terminal, example: {},
        async run(_values, context) {
          inWorkspace();
          try {
            await policy.apply({ fetchImpl: fetch as UpdateFetchLike, execPath: process.execPath, platform: process.platform, arch: process.arch, currentVersion: policy.version, print: context.print }, context);
          } catch (error) {
            if (suiteUpdateRequiresRecovery(error)) policy.onRecovery?.(error, context);
            throw commandRefusal(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      },
      {
        id: 'rollback', label: 'Go back to the previous version', word: 'rollback', inputs: [],
        sentence: 'The version kept by the last update is put back for every GoodVibes program here, until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'apply',
        ownerOnly: { reason: 'it replaces the programs you are running', instead: 'Ask the owner to run /update rollback.' },
        operator: terminal, example: {},
        async run(_values, context) {
          inWorkspace();
          try {
            await policy.rollback({ execPath: process.execPath, platform: process.platform, arch: process.arch, print: context.print }, context);
          } catch (error) {
            if (suiteUpdateRequiresRecovery(error)) policy.onRecovery?.(error, context);
            throw commandRefusal(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      },
      readAction<Context>({
        id: 'daemon', label: 'See the daemon\'s updates', word: 'daemon',
        inputs: [choiceInput({
          id: 'now', label: 'Check now', help: 'Ask the daemon to look for a newer release now', typed: { flag: '--check', switchOn: 'yes' },
          choices: [{ value: 'no', label: 'Show what it last found' }, { value: 'yes', label: 'Look now' }],
          optional: { default: 'no', means: 'show what it last found' },
        })],
        sentence: 'Shows the connected daemon\'s own update state: its version, the newest release it found and when it looks again.',
        operator: terminal, example: { now: 'yes' },
        async run(values, context) {
          if (!policy.daemon) throw commandRefusal('This program reaches no daemon of its own.');
          // A person at the terminal sees an install through to the new version; a model's run answers at once.
          return describeDaemonUpdates(policy.daemon(context), values.now === 'yes', context.invokedByModel === true ? undefined : { print: context.print, printLive: context.printLive });
        },
      }),
      readAction<Context>({
        id: 'review', label: 'See this install', word: 'review',
        sentence: 'Shows the version installed, the newest release, how it was installed, whether a previous version is kept and what an update keeps.',
        operator: terminal,
        async run(_values, context) {
          // What /install showed (saved profiles, stored secret names) sits with the update state.
          const profiles = install.savedProfiles(context);
          const secretKeys = await install.storedSecrets(context);
          return [
            formatUpdateReview(buildUpdateReview(install, context, policy.version, await readLatestRelease()), 'This install'),
            `  saved settings profiles: ${profiles}`,
            `  stored secrets: ${secretKeys}`,
          ].join('\n');
        },
      }),
      {
        id: 'save-review', label: 'Save this install\'s update state to a file', word: 'save-review',
        inputs: [
          pathInput('Where to write it; it holds no secret'),
          choiceInput({
            id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', typed: { flag: '--replace', switchOn: 'yes' },
            choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' }],
            optional: { default: 'no', means: 'keep it and stop' },
          }),
        ],
        sentence: 'What "See this install" shows will be written to {path}, until you change it; it is a record, not an update.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: terminal, example: { path: 'update-review.json' },
        async run(values, context) {
          const targetPath = install.resolvePath(context, values.path!);
          if (values.replace !== 'yes' && existsSync(targetPath)) {
            throw commandRefusal(`${values.path} already exists; nothing was written.`, `Write over it: /update save-review ${values.path} --replace`);
          }
          const review = buildUpdateReview(install, context, policy.version, await readLatestRelease());
          const text = JSON.stringify(review, null, 2) + '\n';
          if (values.replace === 'yes') {
            // Replaced whole or not at all: a crash leaves the earlier record readable.
            atomicWriteFileSync(targetPath, text, { mkdirp: true, mode: 0o644 });
          } else {
            // The check above answers before the release is fetched; this one, at the write, holds for a file made during the fetch.
            mkdirSync(dirname(targetPath), { recursive: true });
            try {
              writeFileSync(targetPath, text, { encoding: 'utf-8', flag: 'wx' });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw commandRefusal(`${values.path} already exists; nothing was written.`, `Write over it: /update save-review ${values.path} --replace`);
              }
              throw error;
            }
          }
          return `Saved this install's update state to ${targetPath}. It records the update state for support or before an upgrade; nothing applies it.`;
        },
      },
      readAction<Context>({
        id: 'read-review', label: 'Read a saved update state', word: 'read-review',
        inputs: [pathInput('An update state saved earlier')],
        sentence: 'Reads the update state saved in {path} and shows what it recorded.',
        operator: terminal, example: { path: 'update-review.json' },
        async run(values, context) {
          const targetPath = install.resolvePath(context, values.path!);
          try {
            return formatUpdateReview(parseUpdateReview(readFileSync(targetPath, 'utf-8')), `Update state (saved ${targetPath})`);
          } catch (error) {
            throw commandRefusal(`Cannot read ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
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
    import('./managed-daemon-service.js'),
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
