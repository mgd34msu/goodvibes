import { getPluginDirectories, getUserPluginDirectory } from '@goodvibes-jev/engine/platform/platform/plugins';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { removeEcosystemCatalogEntry, upsertEcosystemCatalogEntry, loadEcosystemCatalog } from '@goodvibes-jev/engine/platform/platform/runtime/ecosystem/catalog';
import { openModalCommand, requireEcosystemCatalogPaths, requirePluginPathOptions } from './runtime-services.ts';
import { pluginActions } from '@goodvibes-jev/engine/terminal-shell/plugin-trust-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';

/**
 * `/plugin`, described once (command-actions/): the plugins this app runs
 * (the same actions as the Agent's /plugin-trust), where they are looked for,
 * and publishing a plugin folder into the local curated catalog. Installing
 * from the catalog is /marketplace's.
 */

function managerOf(ctx: CommandContext) {
  const manager = ctx.extensions.pluginManager;
  if (!manager) throw commandRefusal('Plugin manager is not available in this runtime.', undefined, 'PLUGINS_UNAVAILABLE');
  return manager;
}

const PUBLISHED = defineList<CommandContext>({
  name: 'plugin.catalog',
  async read(ctx) {
    return loadEcosystemCatalog('plugin', requireEcosystemCatalogPaths(ctx)).map((entry): ListRow => ({ value: entry.id, label: entry.name, detail: entry.summary }));
  },
  operator: { terminalOnly: 'The curated catalog is on this machine.' },
});

export function registerPluginRuntimeCommands(registry: CommandRegistry): void {
  const shared = pluginActions<CommandContext>((ctx) => ctx.extensions.pluginManager, 'plugin');
  registry.register(defineCommand<CommandContext>({
    name: 'plugin',
    title: 'Plugins',
    summary: 'Switch plugins on and off, set what each one may do, and publish your own',
    group: 'Extensions',
    report: 'list',
    firstScreenRows: [
      'list', 'enable', 'disable', 'trust',
      { label: 'Check a plugin', actions: ['inspect', 'capabilities', 'verify', 'trust-key', 'review'] },
      { label: 'Stop a plugin that misbehaves', actions: ['quarantine', 'lift', 'reload'] },
      { label: 'Publish your own plugin', actions: ['publish-local', 'unpublish', 'dirs'] },
      'open',
    ],
    actions: [
      ...shared,
      doAction<CommandContext>({
        id: 'open', label: 'Open the plugins screen', word: 'open', touches: 'reads',
        sentence: 'Opens the full-screen view of your plugins.', operator: { terminalOnly: 'It is a terminal screen.' },
        async run(_values, ctx) { openModalCommand(ctx, 'plugins-modal'); },
      }),
      readAction<CommandContext>({
        id: 'dirs', label: 'See where plugins are looked for', word: 'dirs',
        sentence: 'Shows the folders plugins are loaded from, and your own plugin folder.',
        async run(_values, ctx) {
          const pluginPaths = requirePluginPathOptions(ctx);
          return ['Plugin Search Directories', ...getPluginDirectories(pluginPaths).map((dir) => `  ${dir}`), '', `User plugin directory: ${getUserPluginDirectory(pluginPaths)}`].join('\n');
        },
      }),
      readAction<CommandContext>({
        id: 'inspect', label: 'See one plugin', word: 'inspect', inputs: [shared.find((action) => action.id === 'enable')!.inputs[0]!],
        sentence: 'Shows {plugin}\'s version, state, tier, capabilities, signature and quarantine.', example: { plugin: 'jira' },
        async run(values, ctx) {
          const pluginManager = managerOf(ctx);
          const name = values.plugin!;
          const status = pluginManager.list().find((plugin) => plugin.name === name);
          if (!status) throw commandRefusal(`Plugin '${name}' not found.`, '/plugin list shows the installed plugins', 'NOT_FOUND');
          const capabilities = pluginManager.capabilities(name);
          const trust = pluginManager.getTrustRecord(name);
          const quarantine = pluginManager.getQuarantineRecord(name);
          return [
            `Plugin ${name}`,
            `  version: ${status.version}`,
            `  state: ${status.active ? 'active' : status.enabled ? 'enabled' : 'disabled'}`,
            `  trustTier: ${status.trustTier}`,
            `  quarantined: ${status.quarantined ? 'yes' : 'no'}`,
            `  requestedCapabilities: ${capabilities?.requested.length ?? 0}`,
            `  highRiskCapabilities: ${capabilities?.highRisk.length ?? 0}`,
            `  withheldByTier: ${capabilities?.blocked.join(', ') || 'none'}`,
            `  signedFingerprint: ${trust?.signatureFingerprint ?? 'n/a'}`,
            `  quarantineReason: ${quarantine?.reason ?? 'n/a'}`,
          ].join('\n');
        },
      }),
      readAction<CommandContext>({
        id: 'review', label: 'See how much your plugins may do', word: 'review',
        sentence: 'Counts your plugins by state and trust tier.',
        async run(_values, ctx) {
          const plugins = managerOf(ctx).list();
          return [
            'Plugin Security Review',
            `  total: ${plugins.length}`,
            `  active: ${plugins.filter((plugin) => plugin.active).length}`,
            `  quarantined (will not load): ${plugins.filter((plugin) => plugin.quarantined).length}`,
            // Each tier is enforced at start: untrusted may not register tools, providers or hooks; only trusted may declare high-risk capabilities.
            `  untrusted (panels and reads only): ${plugins.filter((plugin) => plugin.trustTier === 'untrusted').length}`,
            `  limited (declared tools, providers, hooks): ${plugins.filter((plugin) => plugin.trustTier === 'limited').length}`,
            `  trusted (also high-risk): ${plugins.filter((plugin) => plugin.trustTier === 'trusted').length}`,
          ].join('\n');
        },
      }),
      {
        id: 'publish-local', label: 'Publish a plugin folder to the local catalog', word: 'publish-local',
        inputs: [
          textInput({ id: 'id', label: 'Catalog id', help: 'A short id you choose', why: 'a new id you choose', typed: { position: 1 } }),
          textInput({ id: 'path', label: 'Plugin folder', help: 'The folder with its manifest.json', why: 'a folder on this machine', kind: 'path', typed: { position: 2 } }),
          textInput({ id: 'summary', label: 'Summary', help: 'One line on what it does', why: 'your own words', typed: { tail: true } }),
        ],
        sentence: 'The plugin in {path} is listed in the local curated catalog as {id} ("{summary}"), until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'unpublish',
        operator: { terminalOnly: 'The curated catalog is on this machine.' }, example: { id: 'jira', path: 'plugins/jira', summary: 'Read and file Jira issues' },
        async run(values, ctx) {
          const entryId = values.id!;
          const result = upsertEcosystemCatalogEntry({
            id: entryId,
            kind: 'plugin',
            name: entryId.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
            summary: values.summary!,
            source: values.path!,
            tags: ['local-first', 'published'],
            provenance: 'operator-published',
            updateHint: 'Use /plugin publish-local again to refresh catalog metadata after edits.',
          }, requireEcosystemCatalogPaths(ctx));
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          return `Published curated plugin ${entryId} into ${result.path}`;
        },
      },
      {
        id: 'unpublish', label: 'Take a plugin out of the local catalog', word: 'unpublish',
        inputs: [listInput({ id: 'id', label: 'Catalog entry', help: 'Plugins in the local curated catalog', list: PUBLISHED })],
        sentence: '{id} is removed from the local curated catalog; installs of it stay.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { terminalOnly: 'The curated catalog is on this machine.' }, example: { id: 'jira' },
        async run(values, ctx) {
          const result = removeEcosystemCatalogEntry('plugin', values.id!, requireEcosystemCatalogPaths(ctx));
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          return `Removed curated plugin ${values.id} from ${result.path}`;
        },
      },
    ],
  }));
}
