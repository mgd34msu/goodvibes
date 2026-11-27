/**
 * System, updates (home `daemon`): whether a newer release is out, installing
 * it and going back, and this install's update state, read and kept as a file.
 *
 * The daemon holds the install: one suite on this machine (the daemon, the
 * terminal app, the Agent and their companions, from the same release). A
 * check and the review read the daemon's own update state (`update.status`)
 * and the release page it reads. Installing runs through the daemon's own
 * update path when its update loop is on (`update.check`, which installs what
 * it finds and restarts into it); with the loop off, the daemon replaces the
 * whole suite itself, as a terminal program did before (`applySuiteUpdate`),
 * and the programs use it from their next start. Going back puts back the
 * version the last update kept, for every program (`rollbackSuiteUpdate`).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readCallerJson, unreadableFile } from '../path-inputs.js';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { detectInstallKind, type InstallKind } from '../../runtime/install-kind.js';
import { compareVersions, normalizeVersion, PREVIOUS_FILE_SUFFIX, resolveArtifactNames, resolveLatestReleaseTag, type UpdateFetchLike } from '../../runtime/self-update.js';
import { applySuiteUpdate, retainSuiteUpdateConfiguration, rollbackSuiteUpdate, type SuiteUpdateResult } from '../../runtime/suite-update.js';
import { DAEMON_RELEASES_LATEST_URL } from '../../config/schema-domain-update.js';
import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.js';
import { CapabilityRefusal, REPLACED_DONE, type CapabilityCaller, type CapabilityDefinition, type InputDescription } from '../types.js';

/** What the update capabilities read of the daemon besides its methods: its settings, its sign-ins, and where a file goes. */
export interface SystemUpdatesCapabilityServices {
  readonly systemUpdates?: {
    /** The daemon's settings (the web UI's served folder, the sandbox settings the review names). */
    get(key: string): unknown;
    /** The subscription providers signed in on the daemon. */
    subscriptionProviders(): readonly string[];
    /** A path the caller gave, in its project folder when it is not absolute. */
    resolvePath(caller: CapabilityCaller, path: string): string;
  } | undefined;
}

type Def = CapabilityDefinition<SystemUpdatesCapabilityServices>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).trim().replace(/[.?!]+$/, '');

async function method(caller: CapabilityCaller, id: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  return record(await caller.method(id, body));
}

function updatesOf(services: SystemUpdatesCapabilityServices): NonNullable<SystemUpdatesCapabilityServices['systemUpdates']> {
  if (!services.systemUpdates) throw new CapabilityRefusal('This daemon was started without its update facts; nothing was read or changed.', undefined, 'UNAVAILABLE');
  return services.systemUpdates;
}

/** The daemon's version and its release page, from its own update state. */
async function installOf(caller: CapabilityCaller): Promise<{ readonly version: string | null; readonly releasesUrl: string; readonly status: Record<string, unknown> }> {
  const status = await method(caller, 'update.status');
  return { version: text(status.currentVersion) || null, releasesUrl: text(status.releasesUrl) || DAEMON_RELEASES_LATEST_URL, status };
}

type Latest = { readonly tag: string; readonly isCurrent: boolean } | { readonly unknown: string };

async function latestOf(releasesUrl: string, version: string | null): Promise<Latest> {
  try {
    const tag = await resolveLatestReleaseTag(fetch as UpdateFetchLike, releasesUrl);
    return { tag, isCurrent: version !== null && compareVersions(version, tag) >= 0 };
  } catch (error) {
    return { unknown: unreachedWords(error) ?? errorText(error) };
  }
}

/**
 * A release page that did not answer at all, in words: the fetch layer's own text ("Unable to connect. Is the computer
 * able to access the url?", "Was there a typo in the url or port?") says nothing a person can act on.
 */
function unreachedWords(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code;
  const said = errorText(error);
  const unreached = (typeof code === 'string' && /^(ConnectionRefused|ConnectionClosed|FailedToOpenSocket|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT)$/.test(code))
    || /Unable to connect|typo in the url|fetch failed|network is unreachable|getaddrinfo/i.test(said);
  return unreached ? 'the release page could not be reached from this computer (no connection to it)' : undefined;
}

/** This install's update state: what the review shows and save-review keeps (version 2, the same shape a terminal program saved). */
interface UpdateReview {
  readonly version: 2;
  readonly exportedAt: number;
  readonly appVersion: string;
  readonly installKind: InstallKind;
  readonly latest: Latest;
  readonly channel: string;
  readonly rollbackRetained: boolean;
  readonly subscriptionProviders: readonly string[];
  readonly sandboxProfile: string;
}

async function reviewOf(services: SystemUpdatesCapabilityServices, caller: CapabilityCaller): Promise<UpdateReview> {
  return (await reviewAndStatusOf(services, caller)).review;
}

/** This install's review, with the daemon's own update state it was read from (the Updates tab shows both). */
async function reviewAndStatusOf(services: SystemUpdatesCapabilityServices, caller: CapabilityCaller): Promise<{ readonly review: UpdateReview; readonly status: Record<string, unknown> }> {
  const updates = updatesOf(services);
  const install = await installOf(caller);
  return { status: install.status, review: {
    version: 2,
    exportedAt: Date.now(),
    appVersion: install.version ?? 'unknown (not an installed release)',
    installKind: detectInstallKind(process.execPath),
    latest: await latestOf(install.releasesUrl, install.version),
    channel: install.releasesUrl,
    rollbackRetained: existsSync(`${process.execPath}${PREVIOUS_FILE_SUFFIX}`),
    subscriptionProviders: [...new Set([...listBuiltinSubscriptionProviders().map((entry) => entry.provider), ...updates.subscriptionProviders()])],
    sandboxProfile: `commands ${updates.get('sandbox.enabled') === false ? 'host' : 'contained'}/mcp ${String(updates.get('sandbox.mcpIsolation'))}`,
  } };
}

const INSTALL_KIND_WORDS: Readonly<Record<InstallKind, string>> = {
  binary: 'installed release files', 'bun-global-package': 'a bun or npm package', source: 'running from source',
};

function reviewLines(review: UpdateReview, title: string): string[] {
  const latest = 'tag' in review.latest
    ? `${review.latest.tag}${review.latest.isCurrent ? ' (this is current)' : ' (newer than this one; Install it is on the Updates tab)'}`
    : `unknown (${review.latest.unknown})`;
  return [
    title,
    `  installed version: ${review.appVersion}`,
    `  latest release: ${latest}`,
    `  channel: ${review.channel}`,
    `  install kind: ${INSTALL_KIND_WORDS[review.installKind] ?? review.installKind}`,
    `  rollback copy: ${review.rollbackRetained ? 'kept beside the programs; Go back puts it back' : 'none kept (an update keeps one)'}`,
    `  subscription providers: ${review.subscriptionProviders.length}${review.subscriptionProviders.length > 0 ? ` (${review.subscriptionProviders.join(', ')})` : ''}; sign-ins survive an update`,
    `  sandbox profile: ${review.sandboxProfile}`,
  ];
}

/** A saved update state, refused when the file is not one rather than shown with missing fields. */
function parseReview(value: unknown): UpdateReview {
  const review = record(value);
  const latest = record(review.latest);
  if (review.version !== 2 || typeof review.appVersion !== 'string' || typeof review.installKind !== 'string' || typeof review.channel !== 'string'
    || typeof review.rollbackRetained !== 'boolean' || typeof review.sandboxProfile !== 'string' || !Array.isArray(review.subscriptionProviders)
    || (typeof latest.tag !== 'string' && typeof latest.unknown !== 'string')) {
    throw new Error('the file is not a saved update state');
  }
  return review as unknown as UpdateReview;
}

const FILE = (help: string): InputDescription => ({ id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 } });

export const UPDATE_CHECK: Def = {
  capability: { id: 'update.check', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'check', label: 'See whether a newer release is out', word: 'check', inputs: [],
  sentence: 'Asks the release page for the newest release and compares it with the one installed here.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['control-plane.read'], example: {},
  async run(_values, _services, caller) {
    const install = await installOf(caller);
    const latest = await latestOf(install.releasesUrl, install.version);
    if ('unknown' in latest) throw new CapabilityRefusal(`Could not check for updates: ${latest.unknown}.`);
    const running = install.version ? `v${normalizeVersion(install.version)}` : 'a version that is not an installed release';
    return {
      text: latest.isCurrent ? `Already current: ${running} is installed (the latest release is ${latest.tag}).` : `A newer release is out: ${latest.tag} (${running} is installed).`,
      data: { installed: install.version, latest: latest.tag, current: latest.isCurrent },
    };
  },
};

export const UPDATE_REVIEW: Def = {
  capability: { id: 'update.review', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'review', label: 'See this install', word: 'review', inputs: [],
  sentence: 'Shows the version installed, the newest release, how it was installed, whether a previous version is kept and what an update keeps.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['control-plane.read'], example: {},
  async run(_values, services, caller) {
    const { review, status } = await reviewAndStatusOf(services, caller);
    return { text: reviewLines(review, 'This install').join('\n'), data: { review, status } };
  },
};

export const UPDATE_SAVE_REVIEW: Def = {
  capability: { id: 'update.save-review', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'save-review', label: 'Save this install\'s update state to a file', word: 'save-review',
  inputs: [{ ...FILE('Where to write it; it holds no secret'), file: 'written' }, {
    id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', kind: 'choice', typed: { flag: '--replace', switchOn: 'yes' },
    choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', help: 'What the file holds now is lost.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }],
    required: { default: 'no', defaultMeans: 'keep it and stop' },
  }],
  sentence: 'What "See this install" shows will be written to {path}, until you change it; it is a record, not an update.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'update-review.json' },
  async run(values, services, caller) {
    const target = updatesOf(services).resolvePath(caller, values.path!);
    if (values.replace !== 'yes' && existsSync(target)) throw new CapabilityRefusal(`${target} already exists; nothing was written. Choose "Write over it" to replace it.`);
    const body = JSON.stringify(await reviewOf(services, caller), null, 2) + '\n';
    if (values.replace === 'yes') {
      atomicWriteFileSync(target, body, { mkdirp: true, mode: 0o644 });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      try { writeFileSync(target, body, { encoding: 'utf-8', flag: 'wx' }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CapabilityRefusal(`${target} already exists; nothing was written.`);
        throw error;
      }
    }
    return { text: `Saved this install's update state to ${target}. It is a record for support or before an upgrade; nothing applies it.`, data: { path: target } };
  },
};

export const UPDATE_READ_REVIEW: Def = {
  capability: { id: 'update.read-review', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'read-review', label: 'Read a saved update state', word: 'read-review', inputs: [FILE('An update state saved earlier')],
  sentence: 'Reads the update state saved in {path} and shows what it recorded.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'update-review.json' },
  async run(values, services, caller) {
    const target = updatesOf(services).resolvePath(caller, values.path!);
    // Never the system's or the parser's words (capabilities/path-inputs.ts).
    const value = readCallerJson(target, 'a saved update state', caller, 'Nothing was read from it.');
    let review: UpdateReview;
    try { review = parseReview(value); } catch (error) { throw unreadableFile(target, 'a saved update state', caller, error, 'Nothing was read from it.'); }
    return { text: reviewLines(review, `Update state (saved ${target})`).join('\n') };
  },
};

/** Installing or going back replaces the programs you are running: only the owner does it, and it is asked first. */
const REPLACES = { reason: 'it replaces the programs you are running', instead: 'Say that a newer release is out; the owner installs it.' };

const replaced = (result: SuiteUpdateResult, action: 'updated' | 'restored'): string => [
  `${action === 'updated' ? 'Updated' : 'Restored'} GoodVibes ${result.version}: ${result.programs.join(', ')}.`,
  ...result.directoryPaths.map((path) => `  ${action} directory: ${path}`),
  'The programs use it from their next start; the daemon starts it the next time it restarts.',
].join('\n');

function binaryInstall(): void {
  const kind = detectInstallKind(process.execPath);
  if (kind !== 'binary') {
    throw new CapabilityRefusal(`This install is ${INSTALL_KIND_WORDS[kind]}, not installed release files, so it is not updated here; nothing was changed. Update it the way it was installed.`);
  }
}

export const UPDATE_APPLY: Def = {
  capability: { id: 'update.apply', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'apply', label: 'Install the newer release', word: 'apply', inputs: [],
  sentence: 'The newest release is downloaded, checked and installed for every GoodVibes program here, until you change it; the version replaced is kept for going back.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
  riskDone: 'Every GoodVibes program here is replaced by the new release; the version replaced is kept, and Go back puts it back.',
  undoneBy: 'rollback', ownerOnly: REPLACES, effects: ['control-plane.administer', 'model.refused'], example: {},
  async run(_values, services, caller) {
    const install = await installOf(caller);
    // The daemon's own update path when its loop is on: the same check that installs what it finds and restarts into it.
    if (install.status.armed === true) {
      const checked = await method(caller, 'update.check');
      const check = text(checked.check);
      if (check === 'installing') return { text: `${text(checked.pendingVersion) || 'The newer release'} is being installed now; the daemon restarts into it, and the programs use it from their next start.`, data: { check } };
      if (text(checked.pendingVersion)) return { text: `${text(checked.pendingVersion)} was found; it installs as soon as no work is in flight.`, data: { check, pending: text(checked.pendingVersion) } };
      return { text: 'Already current: nothing newer was found, so nothing was installed.', data: { check } };
    }
    binaryInstall();
    if (!install.version) throw new CapabilityRefusal('The installed version is not known, so nothing was installed.');
    const latest = await latestOf(install.releasesUrl, install.version);
    if ('unknown' in latest) throw new CapabilityRefusal(`Could not read the newest release: ${latest.unknown}; nothing was installed.`);
    if (latest.isCurrent) return { text: `Already current: v${normalizeVersion(install.version)} is installed (the latest release is ${latest.tag}); nothing was installed.`, data: { current: true } };
    if (!resolveArtifactNames(process.platform, process.arch)) throw new CapabilityRefusal(`No release files are published for ${process.platform}-${process.arch}; nothing was installed.`);
    const configuration = retainSuiteUpdateConfiguration({ get: (key) => updatesOf(services).get(key) });
    const base = install.releasesUrl.replace(/\/releases\/latest$/, `/releases/download/${latest.tag}`);
    let result: SuiteUpdateResult;
    try {
      result = await applySuiteUpdate({
        fetchImpl: fetch as UpdateFetchLike, downloadBaseUrl: base, execPath: process.execPath, platform: process.platform, arch: process.arch,
        version: latest.tag, webuiDirectory: configuration.webuiDirectory, assertCurrent: configuration.assertCurrent,
      });
    } catch (error) {
      throw new CapabilityRefusal(`The update did not install: ${errorText(error)}.`);
    }
    return { text: replaced(result, 'updated'), data: { version: result.version, programs: result.programs } };
  },
};

export const UPDATE_ROLLBACK: Def = {
  capability: { id: 'update.rollback', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'rollback', label: 'Go back to the previous version', word: 'rollback', inputs: [],
  sentence: 'The version kept by the last update is put back for every GoodVibes program here, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
  riskDone: 'Every GoodVibes program here goes back to the version the last update kept; Install the newer release brings the new one back.',
  undoneBy: 'apply', ownerOnly: REPLACES, effects: ['control-plane.administer', 'model.refused'], example: {},
  async run(_values, services, caller) {
    binaryInstall();
    if (!existsSync(`${process.execPath}${PREVIOUS_FILE_SUFFIX}`)) {
      throw new CapabilityRefusal('No previous version is kept beside this install; nothing was changed. An update keeps one from now on.');
    }
    const install = await installOf(caller);
    if (!install.version) throw new CapabilityRefusal('The installed version is not known, so nothing was changed.');
    const configuration = retainSuiteUpdateConfiguration({ get: (key) => updatesOf(services).get(key) });
    let result: SuiteUpdateResult;
    try {
      result = rollbackSuiteUpdate({ execPath: process.execPath, platform: process.platform, arch: process.arch, currentVersion: install.version,
        webuiDirectory: configuration.webuiDirectory, assertCurrent: configuration.assertCurrent });
    } catch (error) {
      throw new CapabilityRefusal(`Going back did not happen: ${errorText(error)}.`);
    }
    return { text: replaced(result, 'restored'), data: { version: result.version, programs: result.programs } };
  },
};

/** Every capability of this file, with the command it came from. */
export const SYSTEM_UPDATE_CAPABILITIES: readonly { readonly definition: Def; readonly command: { readonly name: string; readonly title: string } }[] =
  [UPDATE_CHECK, UPDATE_APPLY, UPDATE_ROLLBACK, UPDATE_REVIEW, UPDATE_SAVE_REVIEW, UPDATE_READ_REVIEW]
    .map((definition) => ({ definition, command: { name: 'update', title: 'Updates' } }));
