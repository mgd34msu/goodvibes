/**
 * Plugins, the line drawn as the trace drew it:
 *
 *  - The daemon manages what is kept about plugins: which are switched on (the
 *    one state file every program reads, `~/.goodvibes/tui/plugins.json`),
 *    each plugin's trust tier (the shared trust file) and publisher key, what
 *    a plugin asks to do, where plugins are looked for, and the local curated
 *    catalog a plugin folder is published to. For the daemon's own folder its
 *    live plugin manager applies a change at once; for another project a
 *    manager of that project reads and writes the same files and starts
 *    nothing. A program running turns starts or stops the plugin itself (its
 *    place does so right after the daemon's change).
 *  - Running stays with each program: loading its plugins again, and
 *    quarantining or lifting the quarantine of a plugin it runs.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { PluginManager } from '../../plugins/manager.js';
import { describeUnappliedTier } from '../../runtime/plugins/trust.js';
import { getPluginDirectories, getUserPluginDirectory, type PluginPathOptions } from '../../plugins/loader.js';
import {
  loadEcosystemCatalog, removeEcosystemCatalogEntry, upsertEcosystemCatalogEntry, type EcosystemCatalogPathOptions,
} from '../../runtime/ecosystem/catalog.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

type TierName = 'untrusted' | 'limited' | 'trusted';

/** The plugin manager calls the daemon's capabilities make. */
export type PluginManagingControls = Pick<PluginManager, 'list' | 'enable' | 'disable' | 'trust' | 'trustSigned' | 'setPublisherKey' | 'verify' | 'capabilities' | 'getTrustRecord' | 'getQuarantineRecord'>;
/** The plugin manager calls this program's capabilities make. */
export type PluginRunningControls = Pick<PluginManager, 'list' | 'enable' | 'reload' | 'quarantine' | 'liftQuarantine'>;

export interface PluginProject {
  readonly manager: PluginManagingControls;
  readonly paths: PluginPathOptions;
  readonly catalog: EcosystemCatalogPathOptions;
  /** True for the daemon's own folder, where its live manager starts and stops plugins. */
  readonly live: boolean;
}

/** What the daemon's plugin capabilities need: the plugins of the caller's project. */
export interface PluginsCapabilityServices {
  readonly plugins: {
    forProject(workingDirectory: string | undefined): PluginProject | undefined;
  };
}

/** What this program's plugin capabilities need: the plugins it runs. */
export interface PluginsSessionServices {
  readonly pluginsLive: {
    readonly manager: PluginRunningControls | undefined;
  };
}

/** The plugins on this machine, and the plugins in the local curated catalog (lists registered in terminal-shell). */
export const PLUGINS_LIST = 'plugins' as ListName;
export const PLUGIN_CATALOG_LIST = 'plugin.catalog' as ListName;

/** What each trust tier lets a plugin do; the plugin loader enforces it at every start, in every program. */
export const PLUGIN_TIER_WORDS: Readonly<Record<TierName, string>> = {
  untrusted: 'panels, commands and reading files only; its tool, provider, event-hook, gateway-method, channel and delivery registrations are refused',
  limited: 'the tools, providers and event hooks its manifest declares, plus gateway methods, channels and delivery strategies; high-risk capabilities stay withheld',
  trusted: 'everything its manifest declares, including shell, file-write and network capabilities',
};

const TIERS: readonly FixedChoice[] = [
  { value: 'untrusted', label: 'Untrusted', help: PLUGIN_TIER_WORDS.untrusted },
  { value: 'limited', label: 'Limited', help: PLUGIN_TIER_WORDS.limited },
  { value: 'trusted', label: 'Trusted', help: PLUGIN_TIER_WORDS.trusted, risk: 'loosens-a-protection' },
];

const PLUGIN: InputDescription = {
  id: 'plugin', label: 'Plugin', help: 'Plugins found on this machine', kind: 'choice', choices: { list: PLUGINS_LIST }, required: true, typed: { position: 1 },
};

/** Why a tier set for a plugin is not applied, in the words of a sentence (the trust file's reason, with no command named). */
function unappliedWords(name: string, unapplied: Parameters<typeof describeUnappliedTier>[1]): string {
  return describeUnappliedTier(name, unapplied, 'plugin').replace(/[;,]?\s*(run|use)?\s*\/plugin [^.;]*/g, '').trim();
}

function projectOf(services: PluginsCapabilityServices, caller: CapabilityCaller): PluginProject {
  const project = services.plugins.forProject(caller.workingDirectory);
  if (!project) throw new CapabilityRefusal('Plugins are not available in this daemon.', undefined, 'PLUGINS_UNAVAILABLE');
  return project;
}

function statusOf(project: PluginProject, name: string): ReturnType<PluginManagingControls['list']>[number] {
  const status = project.manager.list().find((plugin) => plugin.name === name);
  if (!status) throw new CapabilityRefusal(`No plugin named ${name} is found here.`, 'The Plugins list shows the plugins found on this machine.', 'NOT_FOUND');
  return status;
}

const changed = (): void => noteListChanged({ list: 'tools', change: 'changed' });

/** One plugin as a screen and a script read it. */
function pluginFacts(plugin: ReturnType<PluginManagingControls['list']>[number]) {
  return {
    name: plugin.name, version: plugin.version, description: plugin.description ?? '', author: plugin.author ?? '',
    enabled: plugin.enabled, quarantined: plugin.quarantined, tier: plugin.trustTier,
    state: plugin.quarantined ? 'quarantined' : plugin.enabled ? 'on' : 'off',
    ...(plugin.unappliedTier ? { tierSet: plugin.unappliedTier.tier, tierNotApplied: unappliedWords(plugin.name, plugin.unappliedTier) } : {}),
    ...(plugin.startFailure ? { startFailure: String(plugin.startFailure) } : {}),
  };
}

export const PLUGIN_LIST: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.list', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'list', label: 'See your plugins', word: 'list', inputs: [],
  sentence: 'Shows every plugin with whether it is switched on and its trust tier.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const project = projectOf(services, caller);
    const listed = project.manager.list();
    const data = { plugins: listed.map(pluginFacts), folders: getPluginDirectories(project.paths) };
    if (listed.length === 0) return { text: `No plugins installed. Put a plugin folder with its manifest.json in ${getUserPluginDirectory(project.paths)} or the project's .goodvibes/plugins.`, data };
    return {
      text: [
        'Plugins:',
        ...listed.flatMap((plugin) => [
          `  ${(plugin.enabled ? '[on]' : '[off]').padEnd(6)} ${plugin.name.padEnd(24)} v${plugin.version}  tier ${plugin.trustTier}${plugin.quarantined ? '  QUARANTINED' : ''}`,
          ...(plugin.unappliedTier ? [`    ${unappliedWords(plugin.name, plugin.unappliedTier)}`] : []),
        ]),
      ].join('\n'),
      data,
    };
  },
};

function onOff(on: boolean): CapabilityDefinition<PluginsCapabilityServices> {
  return {
    capability: { id: on ? 'plugin.enable' : 'plugin.disable', group: 'tools', home: 'daemon', repeat: 'safe' },
    actionId: on ? 'enable' : 'disable', label: on ? 'Switch a plugin on' : 'Switch a plugin off', word: on ? 'enable' : 'disable', inputs: [PLUGIN],
    sentence: on ? '{plugin} is switched on and starts in every program, under its trust tier, until you change it.' : '{plugin} is switched off and stops in every program, until you change it.', done: '',
    touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: on ? 'disable' : 'enable', example: { plugin: 'jira' },
    async run(values, services, caller) {
      const project = projectOf(services, caller);
      const name = values.plugin!;
      const status = statusOf(project, name);
      if (status.enabled === on) return { text: `Plugin '${name}' was already switched ${on ? 'on' : 'off'}.`, data: { plugin: name, enabled: on } };
      // A refusal by the plugin's tier keeps it recorded as switched on: setting the tier then starts it.
      const result = on ? await project.manager.enable(name) : await project.manager.disable(name);
      const now = project.manager.list().find((plugin) => plugin.name === name);
      changed();
      if (!result.ok && now?.enabled !== on) throw new CapabilityRefusal(result.error ?? `Plugin '${name}' was not switched ${on ? 'on' : 'off'}.`, 'The Plugins list shows each plugin and its state.', 'NOT_DONE');
      return {
        text: on
          ? `Plugin '${name}' switched on.${result.ok ? '' : ` ${result.error}.`}`
          : `Plugin '${name}' switched off.`,
        data: { plugin: name, enabled: on },
      };
    },
  };
}
export const PLUGIN_ENABLE = onOff(true);
export const PLUGIN_DISABLE = onOff(false);

export const PLUGIN_TRUST: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.trust', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'trust', label: 'Set what a plugin may do', word: 'trust',
  inputs: [PLUGIN, { id: 'tier', label: 'Trust tier', help: 'What it may register', kind: 'choice', choices: TIERS, required: true, typed: { position: 2 } },
    { id: 'note', label: 'Note', help: 'Why you chose it', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { tail: true } }],
  sentence: '{plugin} is set to the {tier} tier in every program on this machine until you change it; a trusted tier without a valid signature is recorded in its trust note.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { plugin: 'jira', tier: 'limited' },
  async run(values, services, caller) {
    const project = projectOf(services, caller);
    const name = values.plugin!;
    statusOf(project, name);
    const tier = values.tier as TierName;
    let note = values.note || undefined;
    if (tier === 'trusted') {
      const signed = project.manager.trustSigned(name);
      if (signed.ok) {
        changed();
        return { text: `Plugin '${name}' is trusted by its signed manifest${signed.fingerprint ? ` (fingerprint: ${signed.fingerprint})` : ''}: ${PLUGIN_TIER_WORDS.trusted}. Every program applies it the next time it starts the plugin.`, data: { plugin: name, tier, signed: true } };
      }
      // The owner's own choice covers a signature that does not verify; a closed manager or an unsaved record does not.
      if (signed.signatureRejected !== true) throw new CapabilityRefusal(signed.error ?? `The trust tier of '${name}' was not saved.`, 'Nothing changed; fix the reason and try again.');
      note = `owner override after failed signature check (${signed.error ?? 'unknown reason'})${values.note ? `; ${values.note}` : ''}`;
    }
    const result = project.manager.trust(name, tier, note);
    if (!result.ok) throw new CapabilityRefusal(result.error ?? `The trust tier of '${name}' was not saved.`, 'Nothing changed; fix the reason and try again.');
    changed();
    return {
      text: `Plugin '${name}' trust tier set to '${tier}'${note && tier === 'trusted' ? ' (signature not verified; recorded in the trust note)' : ''}: ${PLUGIN_TIER_WORDS[tier]}. Every program applies it the next time it starts the plugin.`,
      data: { plugin: name, tier, signed: false },
    };
  },
};

export const PLUGIN_TRUST_KEY: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.trust-key', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'trust-key', label: 'Save a plugin publisher\'s key', word: 'trust-key',
  inputs: [PLUGIN, { id: 'key', label: 'Key file', help: 'The publisher\'s Ed25519 public key (.pem)', kind: 'path', freeTextReason: 'a file path on this machine', required: true, typed: { position: 2 } }],
  sentence: 'The key in {key} is saved as {plugin}\'s publisher key, until you change it, so its signature can be checked.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', example: { plugin: 'jira', key: 'keys/acme.pem' },
  async run(values, services, caller) {
    const project = projectOf(services, caller);
    const name = values.plugin!;
    const path = isAbsolute(values.key!) ? values.key! : resolve(project.paths.cwd, values.key!);
    let pem: string;
    try { pem = readFileSync(path, 'utf-8'); } catch (error) {
      throw new CapabilityRefusal(`${values.key} could not be read: ${error instanceof Error ? error.message : String(error)}`, 'Give the path of the publisher\'s Ed25519 public key file.');
    }
    const saved = project.manager.setPublisherKey(name, pem);
    if (!saved.ok) throw new CapabilityRefusal(saved.error ?? `The publisher key for '${name}' was not saved.`);
    const check = project.manager.verify(name);
    changed();
    return {
      text: `Publisher key saved for '${name}'. ${check.valid
        ? 'Its manifest signature verifies with it; setting it to trusted now records the signed grant.'
        : `Its manifest signature does not verify with it (${check.reason ?? 'unknown reason'}); the tier is unchanged.`}`,
      data: { plugin: name, verifies: check.valid === true },
    };
  },
};

export const PLUGIN_VERIFY: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.verify', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'verify', label: 'Check a plugin\'s signature', word: 'verify', inputs: [PLUGIN],
  sentence: 'Checks {plugin}\'s manifest signature against its publisher key.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { plugin: 'jira' },
  async run(values, services, caller) {
    const project = projectOf(services, caller);
    const name = values.plugin!;
    const result = project.manager.verify(name);
    if (!result.ok && result.reason?.includes('not found')) throw new CapabilityRefusal(result.reason ?? `Plugin '${name}' not found.`, 'The Plugins list shows the installed plugins.', 'NOT_FOUND');
    return {
      text: result.valid
        ? `Plugin '${name}' manifest signature is VALID.${result.fingerprint ? `\nFingerprint: ${result.fingerprint}` : ''}`
        : `Plugin '${name}' manifest signature is INVALID.\nReason: ${result.reason ?? 'Unknown'}`,
      data: { plugin: name, valid: result.valid === true, ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}), ...(result.reason ? { reason: result.reason } : {}) },
    };
  },
};

export const PLUGIN_CAPABILITIES: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.capabilities', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'capabilities', label: 'See what a plugin asks to do', word: 'capabilities', inputs: [PLUGIN],
  sentence: 'Shows the capabilities {plugin} declares and which its tier grants or withholds.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { plugin: 'jira' },
  async run(values, services, caller) {
    const project = projectOf(services, caller);
    const name = values.plugin!;
    const info = project.manager.capabilities(name);
    if (!info) throw new CapabilityRefusal(`Plugin '${name}' not found.`, 'The Plugins list shows the installed plugins.', 'NOT_FOUND');
    const lines: string[] = [`Plugin: ${name}`, `Trust tier: ${info.tier} (${PLUGIN_TIER_WORDS[info.tier as TierName] ?? info.tier})`];
    if (info.unappliedTier !== undefined) {
      const sentence = unappliedWords(name, info.unappliedTier);
      lines.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
    }
    lines.push('', `Declared capabilities (${info.requested.length}):`);
    if (info.requested.length === 0) {
      lines.push(info.tier === 'untrusted' ? '  (none: it may register commands only)' : '  (none: it may register commands, gateway methods, channels and delivery strategies only)');
    } else {
      for (const cap of info.requested) {
        const tag = info.blocked.includes(cap)
          ? (info.highRisk.includes(cap) ? '[withheld: needs trusted]' : '[withheld: needs limited]')
          : info.highRisk.includes(cap) ? '[granted, high-risk]' : '[granted]';
        lines.push(`  ${cap.padEnd(32)} ${tag}`);
      }
    }
    const withheldHighRisk = info.blocked.filter((cap) => info.highRisk.includes(cap));
    if (withheldHighRisk.length > 0) lines.push('', `It declares ${withheldHighRisk.join(', ')}, which needs the trusted tier, so it does not start. Set it to trusted to allow it, or remove the capability from its manifest.`);
    else if (info.blocked.length > 0) lines.push('', `Its registrations of ${info.blocked.join(', ')} are refused at this tier; the limited tier allows them.`);
    return { text: lines.join('\n'), data: { plugin: name, tier: info.tier, requested: [...info.requested], withheld: [...info.blocked], highRisk: [...info.highRisk] } };
  },
};

export const PLUGIN_INSPECT: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.inspect', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'inspect', label: 'See one plugin', word: 'inspect', inputs: [PLUGIN],
  sentence: 'Shows {plugin}\'s version, state, tier, capabilities, signature and quarantine.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { plugin: 'jira' },
  async run(values, services, caller) {
    const project = projectOf(services, caller);
    const name = values.plugin!;
    const status = statusOf(project, name);
    const capabilities = project.manager.capabilities(name);
    const trust = project.manager.getTrustRecord(name);
    const quarantine = project.manager.getQuarantineRecord(name);
    return {
      text: [
        `Plugin ${name}`,
        `  version: ${status.version}`,
        `  state: ${status.enabled ? 'switched on' : 'switched off'}`,
        `  trustTier: ${status.trustTier}`,
        `  quarantined: ${status.quarantined ? 'yes' : 'no'}`,
        `  requestedCapabilities: ${capabilities?.requested.length ?? 0}`,
        `  highRiskCapabilities: ${capabilities?.highRisk.length ?? 0}`,
        `  withheldByTier: ${capabilities?.blocked.join(', ') || 'none'}`,
        `  signedFingerprint: ${trust?.signatureFingerprint ?? 'n/a'}`,
        `  quarantineReason: ${quarantine?.reason ?? 'n/a'}`,
      ].join('\n'),
      data: { ...pluginFacts(status), fingerprint: trust?.signatureFingerprint ?? null, quarantineReason: quarantine?.reason ?? null },
    };
  },
};

export const PLUGIN_REVIEW: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.review', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'review', label: 'See how much your plugins may do', word: 'review', inputs: [],
  sentence: 'Counts your plugins by state and trust tier.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const plugins = projectOf(services, caller).manager.list();
    const count = (test: (plugin: (typeof plugins)[number]) => boolean): number => plugins.filter(test).length;
    const data = {
      total: plugins.length, on: count((plugin) => plugin.enabled), quarantined: count((plugin) => plugin.quarantined),
      untrusted: count((plugin) => plugin.trustTier === 'untrusted'), limited: count((plugin) => plugin.trustTier === 'limited'), trusted: count((plugin) => plugin.trustTier === 'trusted'),
    };
    return {
      text: [
        'Plugin Security Review',
        `  total: ${data.total}`,
        `  switched on: ${data.on}`,
        `  quarantined (will not load): ${data.quarantined}`,
        // Each tier is enforced at start: untrusted may not register tools, providers or hooks; only trusted may declare high-risk capabilities.
        `  untrusted (panels and reads only): ${data.untrusted}`,
        `  limited (declared tools, providers, hooks): ${data.limited}`,
        `  trusted (also high-risk): ${data.trusted}`,
      ].join('\n'),
      data,
    };
  },
};

export const PLUGIN_DIRS: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.dirs', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'dirs', label: 'See where plugins are looked for', word: 'dirs', inputs: [],
  sentence: 'Shows the folders plugins are loaded from, and your own plugin folder.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const project = projectOf(services, caller);
    const folders = getPluginDirectories(project.paths);
    const own = getUserPluginDirectory(project.paths);
    return { text: ['Plugin Search Directories', ...folders.map((dir) => `  ${dir}`), '', `User plugin directory: ${own}`].join('\n'), data: { folders, own } };
  },
};

export const PLUGIN_PUBLISH_LOCAL: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.publish-local', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'publish-local', label: 'Publish a plugin folder to the local catalog', word: 'publish-local',
  inputs: [
    { id: 'id', label: 'Catalog id', help: 'A short id you choose', kind: 'text', freeTextReason: 'a new id you choose', required: true, typed: { position: 1 } },
    { id: 'path', label: 'Plugin folder', help: 'The folder with its manifest.json', kind: 'path', freeTextReason: 'a folder on this machine', required: true, typed: { position: 2 } },
    { id: 'summary', label: 'Summary', help: 'One line on what it does', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
  ],
  sentence: 'The plugin in {path} is listed in the local curated catalog as {id} ("{summary}"), until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'unpublish', example: { id: 'jira', path: 'plugins/jira', summary: 'Read and file Jira issues' },
  async run(values, services, caller) {
    const project = projectOf(services, caller);
    const entryId = values.id!;
    const result = upsertEcosystemCatalogEntry({
      id: entryId,
      kind: 'plugin',
      name: entryId.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
      summary: values.summary!,
      source: values.path!,
      tags: ['local-first', 'published'],
      provenance: 'operator-published',
      updateHint: 'Publish it again to refresh its catalog entry after edits.',
    }, project.catalog);
    if (!result.ok) throw new CapabilityRefusal(result.error, undefined, 'NOT_DONE');
    changed();
    return { text: `Published curated plugin ${entryId} into ${result.path}`, data: { id: entryId, path: result.path } };
  },
};

export const PLUGIN_UNPUBLISH: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.unpublish', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'unpublish', label: 'Take a plugin out of the local catalog', word: 'unpublish',
  inputs: [{ id: 'id', label: 'Catalog entry', help: 'Plugins in the local curated catalog', kind: 'choice', choices: { list: PLUGIN_CATALOG_LIST }, required: true, typed: { position: 1 } }],
  sentence: '{id} is removed from the local curated catalog; installs of it stay.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { id: 'jira' },
  async run(values, services, caller) {
    const project = projectOf(services, caller);
    const result = removeEcosystemCatalogEntry('plugin', values.id!, project.catalog);
    if (!result.ok) throw new CapabilityRefusal(result.error, undefined, 'NOT_DONE');
    changed();
    return { text: `Removed curated plugin ${values.id} from ${result.path}`, data: { id: values.id, path: result.path } };
  },
};

/** The plugins in the local curated catalog, for the list a person picks one from (read by the daemon). */
export const PLUGIN_CATALOG: CapabilityDefinition<PluginsCapabilityServices> = {
  capability: { id: 'plugin.catalog', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'catalog', label: 'See the plugins in the local catalog', word: 'catalog', inputs: [],
  sentence: 'Shows the plugins published to the local curated catalog, each with its summary and where it comes from.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const entries = loadEcosystemCatalog('plugin', projectOf(services, caller).catalog);
    const data = { entries: entries.map((entry) => ({ id: entry.id, name: entry.name, summary: entry.summary, source: entry.source })) };
    if (entries.length === 0) return { text: 'No plugins are published to the local catalog.', data };
    return { text: ['Local catalog plugins:', ...entries.map((entry) => `  ${entry.id}: ${entry.summary}`)].join('\n'), data };
  },
};

// ---------------------------------------------------------------------------
// This program's: the plugins it runs
// ---------------------------------------------------------------------------

function runningOf(services: PluginsSessionServices): PluginRunningControls {
  const manager = services.pluginsLive.manager;
  if (!manager) throw new CapabilityRefusal('Plugins are not available in this program.', undefined, 'PLUGINS_UNAVAILABLE');
  return manager;
}

export const PLUGIN_RELOAD: CapabilityDefinition<PluginsSessionServices> = {
  capability: { id: 'plugin.reload', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'reload', label: 'Load the plugins again', word: 'reload', inputs: [],
  sentence: 'Every switched-on plugin of this program is stopped and started again from its files.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const summary = await runningOf(services).reload();
    const lines = [`Done. ${summary.reloaded} plugin(s) reloaded${summary.failed > 0 ? `, ${summary.failed} failed` : ''}.`];
    for (const { name: failed, reason } of summary.loadFailed ?? []) lines.push(`  ${failed}: did not start, ${reason}`);
    for (const busy of summary.notDrained) lines.push(`  ${busy}: not reloaded, calls into it were still running; it keeps its current version. Load the plugins again once they finish.`);
    for (const held of summary.quarantined ?? []) lines.push(`  ${held}: not loaded, it is quarantined. Lifting its quarantine starts it.`);
    for (const stuck of summary.cleanupFailed ?? []) lines.push(`  ${stuck}: stopping its earlier copy reported an error; restart to clear anything that copy left behind.`);
    return { text: lines.join('\n'), data: { reloaded: summary.reloaded, failed: summary.failed } };
  },
};

export const PLUGIN_QUARANTINE: CapabilityDefinition<PluginsSessionServices> = {
  capability: { id: 'plugin.quarantine', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'quarantine', label: 'Quarantine a plugin', word: 'quarantine',
  inputs: [PLUGIN, { id: 'reason', label: 'Why', help: 'A note you will see when you look at it', kind: 'text', freeTextReason: 'your own words', required: { default: 'quarantined by operator', defaultMeans: 'no note' }, typed: { tail: true } }],
  sentence: '{plugin} is stopped and blocked from loading until you change it (lift the quarantine).', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'lift', example: { plugin: 'jira', reason: 'it changed unexpectedly' },
  async run(values, services) {
    const name = values.plugin!;
    const reason = values.reason || 'quarantined by operator';
    const result = runningOf(services).quarantine(name, reason);
    if (!result.ok) throw new CapabilityRefusal(result.error ?? `Plugin '${name}' was not quarantined.`, undefined, 'NOT_DONE');
    try {
      await result.unloading;
    } catch (error) {
      throw new CapabilityRefusal(`Plugin '${name}' is quarantined and will not load again, but stopping the running instance reported an error: ${error instanceof Error ? error.message : String(error)}`, 'Restart to clear anything the running instance left behind.', 'PLUGIN_STOP_FAILED');
    }
    noteListChanged({ list: 'tools', change: 'changed' });
    return { text: `Plugin '${name}' quarantined and stopped.\nReason: ${reason}\nIt will not load until you lift its quarantine, which starts it again.`, data: { plugin: name } };
  },
};

export const PLUGIN_LIFT: CapabilityDefinition<PluginsSessionServices> = {
  capability: { id: 'plugin.lift', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'lift', label: 'Lift a plugin\'s quarantine', word: 'lift', inputs: [PLUGIN],
  sentence: '{plugin} may load again, and starts now if it is switched on, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'quarantine',
  ownerOnly: { reason: 'it lets a quarantined plugin load again', instead: 'Ask the owner to lift it in Tools and extensions.' },
  example: { plugin: 'jira' },
  async run(values, services) {
    const plugins = runningOf(services);
    const name = values.plugin!;
    const result = plugins.liftQuarantine(name);
    if (!result.ok) throw new CapabilityRefusal(result.error ?? `Plugin '${name}' quarantine was not lifted.`, undefined, 'NOT_DONE');
    noteListChanged({ list: 'tools', change: 'changed' });
    const status = plugins.list().find((plugin) => plugin.name === name);
    if (!status?.enabled) return { text: `Plugin '${name}' quarantine lifted. It is switched off, so it was not started; switching it on starts it.`, data: { plugin: name, started: false } };
    if (status.active) return { text: `Plugin '${name}' quarantine lifted; it is running.`, data: { plugin: name, started: true } };
    const started = await plugins.enable(name);
    return {
      text: started.ok ? `Plugin '${name}' quarantine lifted and the plugin started.` : `Plugin '${name}' quarantine lifted, but it did not start: ${started.error ?? 'unknown reason'}`,
      data: { plugin: name, started: started.ok },
    };
  },
};

export const PLUGIN_DAEMON_CAPABILITIES: readonly CapabilityDefinition<PluginsCapabilityServices>[] = [
  PLUGIN_LIST, PLUGIN_ENABLE, PLUGIN_DISABLE, PLUGIN_TRUST, PLUGIN_TRUST_KEY, PLUGIN_VERIFY, PLUGIN_CAPABILITIES, PLUGIN_INSPECT, PLUGIN_REVIEW,
  PLUGIN_DIRS, PLUGIN_PUBLISH_LOCAL, PLUGIN_UNPUBLISH, PLUGIN_CATALOG,
];
export const PLUGIN_SESSION_CAPABILITIES: readonly CapabilityDefinition<PluginsSessionServices>[] = [PLUGIN_RELOAD, PLUGIN_QUARANTINE, PLUGIN_LIFT];
