import { PREVIOUS_FILE_SUFFIX } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { detectInstallKind, type InstallKind } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import {
  compareVersions,
  normalizeVersion,
  resolveLatestReleaseTag,
  type UpdateFetchLike,
} from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
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
  },
): Promise<{ readonly latestTag: string; readonly asset: Asset; readonly baseUrl: string } | null> {
  if (!requireBinaryUpdateInstall(options.execPath, options.print, policy.fallback)) return null;
  policy.assertActive?.();
  const latestTag = await resolveLatestReleaseTag(options.fetchImpl, policy.latestUrl, options.signal ? { signal: options.signal } : {});
  policy.assertActive?.();
  if (compareVersions(options.currentVersion, latestTag) >= 0) {
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
  options.print(`Update available: ${latestTag} (running v${normalizeVersion(options.currentVersion)}). Downloading and verifying...`);
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
export function createSelfUpdateCommand<Context extends { print(message: string): void }>(policy: {
  readonly description: string;
  readonly usage: string;
  readonly help: string;
  readonly workspaceDistribution: boolean;
  readonly workspaceGuidance: string;
  readonly version: string;
  readonly check: (fetchImpl: UpdateFetchLike, version: string) => Promise<ReleaseUpdateCheck>;
  readonly apply: (options: SelfUpdateInvocation, context: Context) => Promise<void>;
  readonly rollback: (options: Omit<SelfUpdateInvocation, 'fetchImpl' | 'currentVersion'>, context: Context) => void;
  readonly extra?: ((args: string[], context: Context) => Promise<boolean>) | undefined;
}): import('./command-registry.js').TerminalSlashCommand<Context> {
  return {
    name: 'update',
    aliases: ['upgrade'],
    description: policy.description,
    usage: policy.usage,
    async handler(args, context) {
      if (policy.workspaceDistribution) {
        context.print(policy.workspaceGuidance);
        return;
      }
      const sub = args[0] ?? 'check';
      if (sub === 'check') {
        try {
          const result = await policy.check(fetch as UpdateFetchLike, policy.version);
          context.print(
            result.isCurrent
              ? `Already current: running v${normalizeVersion(policy.version)} (latest release is ${result.latestTag}).`
              : `Update available: ${result.latestTag} (running v${normalizeVersion(policy.version)}). Run /update apply to install it.`,
          );
        } catch (error) {
          context.print(`Could not check for updates: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (sub === 'apply') {
        try {
          await policy.apply(
            {
              fetchImpl: fetch as UpdateFetchLike,
              execPath: process.execPath,
              platform: process.platform,
              arch: process.arch,
              currentVersion: policy.version,
              print: context.print,
            },
            context,
          );
        } catch (error) {
          context.print(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (sub === 'rollback') {
        try {
          policy.rollback({ execPath: process.execPath, platform: process.platform, arch: process.arch, print: context.print }, context);
        } catch (error) {
          context.print(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (await policy.extra?.(args, context)) return;
      context.print(policy.help);
    },
  };
}
