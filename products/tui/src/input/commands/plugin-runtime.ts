import type { PluginStatus } from '@goodvibes-jev/engine/platform/platform/plugins';
import { getPluginDirectories, getUserPluginDirectory } from '@goodvibes-jev/engine/platform/platform/plugins';
import type { CommandRegistry } from '../command-registry.ts';
import { describeUncheckedCatalogEntries, installEcosystemCatalogEntry, listInstalledEcosystemEntries, loadEcosystemCatalog, removeEcosystemCatalogEntry, reviewEcosystemCatalogEntry, searchEcosystemCatalog, updateInstalledEcosystemEntry, upsertEcosystemCatalogEntry, uninstallEcosystemCatalogEntry } from '@goodvibes-jev/engine/platform/platform/runtime/ecosystem/catalog';
import { openModalCommand, requireEcosystemCatalogPaths, requirePluginPathOptions } from './runtime-services.ts';
import { parseScope } from './marketplace-runtime.ts';
import { PLUGIN_TRUST_USAGE, pluginTrustConfirmation, runPluginLifecycleSubcommand, runPluginTrustSubcommand } from '@goodvibes-jev/engine/terminal-shell/plugin-trust-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

function unknownCatalogEntry(entryId: string): Error {
  return commandRefusal(`Unknown curated plugin entry: ${entryId}`, '/plugin browse lists the catalog entries', 'NOT_FOUND');
}

export function registerPluginRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'plugin',
    // A summary is free text, kept as typed.
    rawRest: (args) => ((args[0] ?? '').toLowerCase() === 'publish-local' ? 3 : undefined),
    aliases: [],
    description: 'Manage plugins, trust, review, and ecosystem paths',
    usage: `list | dirs | inspect <name> | review | installed | catalog-review <id> | publish-local <id> <path> <summary...> | unpublish <id> | install <id> [project|user] | update <id> [project|user] | uninstall <id> [project|user] | enable <name> | disable <name> | reload | ${PLUGIN_TRUST_USAGE} | quarantine <name> [add|lift] [reason]`,
    argsHint: 'list | dirs | inspect | review | installed | catalog-review | publish-local | unpublish | install | update | uninstall | enable | disable | reload | trust | trust-key | verify | capabilities | quarantine',
    subcommands: {
      list: '', dirs: '', inspect: '<name>', review: '', installed: '', 'catalog-review': '<id>',
      'publish-local': '<id> <path> <summary...>', unpublish: '<id>', install: '<id> [project|user]',
      update: '<id> [project|user]', uninstall: '<id> [project|user]', enable: '<name>', disable: '<name>', reload: '',
      trust: '<name> <untrusted|limited|trusted> [note]', 'trust-key': '<name> <key.pem>', verify: '<name>', capabilities: '<name>',
      quarantine: '<name> [add|lift] [reason]',
    },
    confirm(args, ctx) {
      const trustQuestion = pluginTrustConfirmation(ctx.extensions.pluginManager, args);
      if (trustQuestion) return trustQuestion;
      // A scope word that is not project or user is refused by the handler; nothing would change.
      if (args[0] !== 'uninstall' || !args[1] || (args[2] !== undefined && args[2] !== 'project' && args[2] !== 'user')) return undefined;
      return {
        title: `Uninstall plugin ${args[1]}?`,
        detail: `This removes ${args[1]}'s install directory (${args[2] ?? 'project'} scope) and its install receipt. Its files cannot be recovered; /plugin install ${args[1]} installs it again from the catalog.`,
        confirmLabel: 'Uninstall',
      };
    },
    async handler(args, ctx) {
      const pluginManager = ctx.extensions.pluginManager;
      const ecosystemPaths = requireEcosystemCatalogPaths(ctx);
      const pluginPaths = requirePluginPathOptions(ctx);
      if (!pluginManager) {
        throw commandRefusal('Plugin manager is not available in this runtime.', undefined, 'PLUGINS_UNAVAILABLE');
      }
      const sub = args[0];

      if (!sub || sub === 'open' || sub === 'panel') {
        openModalCommand(ctx, 'plugins-modal');
        return;
      }

      if (sub === 'list') {
        const plugins = pluginManager.list() as PluginStatus[];
        if (plugins.length === 0) {
          const directories = getPluginDirectories(pluginPaths)
            .map((dir) => `  ${dir}`)
            .join('\n');
          ctx.print(
            `No plugins installed.\nPlugin search directories:\n${directories}\nPlace a plugin folder in one of those locations with manifest.json and its entry file (index.js unless the manifest's "main" names another).`
          );
          return;
        }
        const lines: string[] = ['Installed plugins:'];
        for (const p of plugins) {
          const statusIcon = p.active ? '[active]  ' : p.enabled ? '[loading] ' : '[disabled]';
          lines.push(`  ${statusIcon}  ${p.name.padEnd(24)} v${p.version}  —  ${p.description}`);
          if (p.author) lines.push(`            by ${p.author}`);
        }
        lines.push('');
        lines.push('Use /plugin enable <name> or /plugin disable <name> to toggle plugins.');
        ctx.print(lines.join('\n'));
        return;
      }
      if (sub === 'dirs') {
        const directories = getPluginDirectories(pluginPaths);
        ctx.print([
          'Plugin Search Directories',
          ...directories.map((dir) => `  ${dir}`),
          '',
          `User plugin directory: ${getUserPluginDirectory(pluginPaths)}`,
        ].join('\n'));
        return;
      }
      if (sub === 'inspect') {
        const name = args[1];
        if (!name) throw commandRefusal('Usage: /plugin inspect <name>');
        const status = pluginManager.list().find((plugin) => plugin.name === name);
        if (!status) throw commandRefusal(`Plugin '${name}' not found.`, '/plugin list shows the installed plugins', 'NOT_FOUND');
        const capabilities = pluginManager.capabilities(name);
        const trust = pluginManager.getTrustRecord(name);
        const quarantine = pluginManager.getQuarantineRecord(name);
        ctx.print([
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
        ].join('\n'));
        return;
      }
      if (sub === 'review') {
        const plugins = pluginManager.list();
        ctx.print([
          'Plugin Security Review',
          `  total: ${plugins.length}`,
          `  active: ${plugins.filter((plugin) => plugin.active).length}`,
          `  quarantined (will not load): ${plugins.filter((plugin) => plugin.quarantined).length}`,
          // Each tier is enforced at start: untrusted may not register tools, providers or hooks; only trusted may declare high-risk capabilities.
          `  untrusted (panels and reads only): ${plugins.filter((plugin) => plugin.trustTier === 'untrusted').length}`,
          `  limited (declared tools, providers, hooks): ${plugins.filter((plugin) => plugin.trustTier === 'limited').length}`,
          `  trusted (also high-risk): ${plugins.filter((plugin) => plugin.trustTier === 'trusted').length}`,
        ].join('\n'));
        return;
      }
      if (sub === 'browse' || sub === 'catalog') {
        const query = args.slice(1).join(' ');
        const search = query
          ? await searchEcosystemCatalog('plugin', query, ecosystemPaths)
          : { entries: loadEcosystemCatalog('plugin', ecosystemPaths), unchecked: 0 };
        const { entries } = search;
        const unchecked = describeUncheckedCatalogEntries(search);
        if (entries.length === 0) {
          ctx.print(query
            ? [`No curated plugin catalog entries matched "${query}".`, ...(unchecked ? [unchecked] : [])].join('\n')
            : 'No curated plugin catalog entries found. Add .goodvibes/tui/ecosystem/plugins.json to publish a local-first plugin catalog.');
          return;
        }
        ctx.print([
          `Curated Plugin Catalog (${entries.length})`,
          ...entries.map((entry) => `  ${entry.id}  ${entry.name}  [${entry.tags.join(', ') || 'untagged'}]  ${entry.summary}`),
          ...(unchecked ? [`  ${unchecked}`] : []),
        ].join('\n'));
        return;
      }
      if (sub === 'installed') {
        const receipts = listInstalledEcosystemEntries('plugin', ecosystemPaths);
        if (receipts.length === 0) {
          ctx.print('No curated plugins installed from local catalogs yet.');
          return;
        }
        ctx.print([
          `Installed Curated Plugins (${receipts.length})`,
          ...receipts.map((receipt) => `  ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
        ].join('\n'));
        return;
      }
      if (sub === 'catalog-review') {
        const entryId = args[1];
        if (!entryId) throw commandRefusal('Usage: /plugin catalog-review <catalog-id>');
        const entry = loadEcosystemCatalog('plugin', ecosystemPaths).find((candidate) => candidate.id === entryId);
        if (!entry) throw unknownCatalogEntry(entryId);
        const review = await reviewEcosystemCatalogEntry(entry, ecosystemPaths);
        ctx.print([
          `Plugin Catalog Review: ${entry.name}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  sourceKind: ${review.sourceKind}`,
          `  sourceExists: ${review.sourceExists ? 'yes' : 'no'}`,
          `  recommendedScope: ${review.recommendedScope}`,
          `  risk: ${review.riskLevel}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          `  provenance: ${entry.provenance ?? '(none)'}`,
          `  update hint: ${entry.updateHint ?? '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'install-hint') {
        const entryId = args[1];
        if (!entryId) throw commandRefusal('Usage: /plugin install-hint <catalog-id>');
        const entry = loadEcosystemCatalog('plugin', ecosystemPaths).find((candidate) => candidate.id === entryId);
        if (!entry) throw unknownCatalogEntry(entryId);
        ctx.print([
          `Plugin Install Guidance: ${entry.name}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  tags: ${entry.tags.join(', ') || '(none)'}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          `  install hint: ${entry.installHint ?? 'Place the plugin under a configured plugin search directory and use /plugin reload.'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'publish-local') {
        const entryId = args[1];
        const sourcePath = args[2];
        const summary = args.slice(3).join(' ').trim();
        if (!entryId || !sourcePath || !summary) throw commandRefusal('Usage: /plugin publish-local <catalog-id> <path> <summary...>');
        const result = upsertEcosystemCatalogEntry({
          id: entryId,
          kind: 'plugin',
          name: entryId.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
          summary,
          source: sourcePath,
          tags: ['local-first', 'published'],
          provenance: 'operator-published',
          updateHint: 'Use /plugin publish-local again to refresh catalog metadata after edits.',
        }, ecosystemPaths);
        if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
        ctx.print(`Published curated plugin ${entryId} into ${result.path}`);
        return;
      }
      if (sub === 'unpublish') {
        const entryId = args[1];
        if (!entryId) throw commandRefusal('Usage: /plugin unpublish <catalog-id>');
        const result = removeEcosystemCatalogEntry('plugin', entryId, ecosystemPaths);
        if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
        ctx.print(`Removed curated plugin ${entryId} from ${result.path}`);
        return;
      }
      if (sub === 'install') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) throw commandRefusal('Usage: /plugin install <catalog-id> [project|user] (default: project)');
        const scope = parseScope(scopeArg, ctx, '/plugin install <catalog-id> [project|user]');
        const result = installEcosystemCatalogEntry('plugin', entryId, { ...ecosystemPaths, scope });
        if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
        ctx.print(`Installed curated plugin ${entryId} into ${result.receipt.targetPath}`);
        return;
      }
      if (sub === 'update') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) throw commandRefusal('Usage: /plugin update <catalog-id> [project|user] (default: project)');
        const scope = parseScope(scopeArg, ctx, '/plugin update <catalog-id> [project|user]');
        const result = updateInstalledEcosystemEntry('plugin', entryId, { ...ecosystemPaths, scope });
        if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
        ctx.print(`Updated curated plugin ${entryId} in ${result.receipt.targetPath}`);
        return;
      }
      if (sub === 'uninstall') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) throw commandRefusal('Usage: /plugin uninstall <catalog-id> [project|user] (default: project)');
        const scope = parseScope(scopeArg, ctx, '/plugin uninstall <catalog-id> [project|user]');
        const result = uninstallEcosystemCatalogEntry('plugin', entryId, { ...ecosystemPaths, scope });
        if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
        ctx.print(`Uninstalled curated plugin ${entryId} from ${result.removedPath}`);
        return;
      }
      // enable, disable, reload: the same lines the Agent's /plugin runs.
      if (await runPluginLifecycleSubcommand(pluginManager, args, (text) => ctx.print(text))) return;
      // trust, trust-key, verify, capabilities: the same lines the agent app's /plugin runs.
      if (await runPluginTrustSubcommand(pluginManager, args, (text) => ctx.print(text))) return;
      throw commandRefusal(
        'Usage: /plugin <subcommand>\n'
        + '  list                       — show installed plugins and their status\n'
        + '  enable <name>              — enable a plugin\n'
        + '  disable <name>             — disable a plugin\n'
        + '  reload                     — reload all enabled plugins\n'
        + '  trust <name> <tier> [note] — record a trust tier (untrusted|limited|trusted); trusted without a valid signature asks once\n'
        + '  trust-key <name> <pem>     — save the publisher\'s Ed25519 public key that verifies its signature\n'
        + '  verify <name>              — inspect a plugin manifest signature\n'
        + '  capabilities <name>        — show requested capabilities and trust tier\n'
        + '  browse [query]             — browse curated local-first plugin catalog entries\n'
        + '  installed                  — list curated catalog installs with provenance receipts\n'
        + '  catalog-review <id>        — review source, provenance, and risk for a curated plugin\n'
        + '  publish-local <id> <path> <summary...> — publish a local plugin directory into the curated catalog\n'
        + '  unpublish <id>             — remove a local curated plugin catalog entry\n'
        + '  install-hint <catalog-id>  — show install guidance for a curated plugin entry\n'
        + '  install <catalog-id> [scope]   — install a local-path curated plugin into project|user scope\n'
        + '  uninstall <catalog-id> [scope] — remove a curated plugin install receipt and target path\n'
        + '  quarantine <name> [reason] — quarantine a plugin (stop it and block it from loading)\n'
        + '  quarantine <name> lift     — lift quarantine from a plugin'
      );
    },
  });
}
