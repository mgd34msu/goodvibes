import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { exportEcosystemCatalogBundle, importEcosystemCatalogBundle, inspectEcosystemCatalogBundle, inspectInstalledEcosystemEntry, installEcosystemCatalogEntry, listEcosystemInstallBackups, listInstalledEcosystemEntries, loadEcosystemCatalog, rollbackInstalledEcosystemEntry, reviewEcosystemCatalogEntry, searchEcosystemCatalog, uninstallEcosystemCatalogEntry, updateInstalledEcosystemEntry } from '@goodvibes-jev/engine/platform/platform/runtime/ecosystem/catalog';
import type { EcosystemCatalogBundle, EcosystemCatalogEntry, EcosystemEntryKind } from '@/runtime/index.ts';
import { openModalCommand, requireEcosystemCatalogPaths, requireReadModels, requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

function resolveMarketplaceEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: Parameters<typeof loadEcosystemCatalog>[1],
): EcosystemCatalogEntry | null {
  return loadEcosystemCatalog(kind, options).find((candidate) => candidate.id === entryId) ?? null;
}

function formatCompatibility(review: Awaited<ReturnType<typeof reviewEcosystemCatalogEntry>>): string {
  if (review.compatibility.reasons.length === 0) return 'compatible with current runtime';
  return review.compatibility.reasons.join('; ');
}

/**
 * The one reading of the scope word of /marketplace, /plugin and /skills. An
 * omitted scope means the project, so an install and its uninstall through
 * different commands hit the same target; any other word is refused, never
 * read as the project, because a typo must not install into or remove from
 * the wrong place. A refused word throws the refusal, so a modal that ran the
 * command shows it failed.
 */
export function parseScope(
  token: string | undefined,
  _ctx: Pick<CommandContext, 'print'>,
  usage = '/marketplace <verb> <kind> <id> [project|user] (rollback: <kind> <id> [project|user] [backupId])',
): 'project' | 'user' {
  if (token === undefined || token === 'project') return 'project';
  if (token === 'user') return 'user';
  throw commandRefusal(`Unknown scope "${token}": nothing was changed. The scope is project (the default) or user.`, `Usage: ${usage}`, 'USAGE');
}

function unknownEntry(kind: string | undefined, entryId: string | undefined): Error {
  return commandRefusal(`Unknown curated ${kind} entry: ${entryId}`, '/marketplace browse lists the catalog entries', 'NOT_FOUND');
}

export function registerMarketplaceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'marketplace',
    aliases: ['catalog'],
    description: 'Browse the unified plugin and skill marketplace',
    usage: '[open|overview|recommend|browse [query]|review <plugin|skill|hook-pack|policy-pack> <id>|provenance <plugin|skill|hook-pack|policy-pack> <id>|install-hint <plugin|skill|hook-pack|policy-pack> <id>|install <plugin|skill|hook-pack|policy-pack> <id> [project|user]|update <plugin|skill|hook-pack|policy-pack> <id> [project|user]|rollback <plugin|skill|hook-pack|policy-pack> <id> [project|user] [backupId]|history <plugin|skill|hook-pack|policy-pack> <id> [project|user]|uninstall <plugin|skill|hook-pack|policy-pack> <id> [project|user]|receipt <plugin|skill|hook-pack|policy-pack> <id> [project|user]|bundle export <path> [project|user]|bundle inspect <path>|bundle import <path> [project|user]|installed]',
    confirm(args) {
      if (args[0] !== 'uninstall' || !args[1] || !args[2] || !['plugin', 'skill', 'hook-pack', 'policy-pack'].includes(args[1])) return undefined;
      // A scope word that is not project or user is refused by the handler; nothing would change.
      if (args[3] !== undefined && args[3] !== 'project' && args[3] !== 'user') return undefined;
      return {
        title: `Uninstall ${args[1]} ${args[2]}?`,
        detail: `The installed ${args[1]} ${args[2]} (${args[3] ?? 'project'} scope) is removed from disk with its install receipt; /marketplace install installs it again from the catalog.`,
        confirmLabel: 'Uninstall',
      };
    },
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const ecosystemPaths = requireEcosystemCatalogPaths(ctx);
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        openModalCommand(ctx, 'marketplace-modal');
        return;
      }
      if (sub === 'overview') {
        const pluginCatalog = loadEcosystemCatalog('plugin', ecosystemPaths);
        const skillCatalog = loadEcosystemCatalog('skill', ecosystemPaths);
        const hookPackCatalog = loadEcosystemCatalog('hook-pack', ecosystemPaths);
        const policyPackCatalog = loadEcosystemCatalog('policy-pack', ecosystemPaths);
        const installedPlugins = listInstalledEcosystemEntries('plugin', ecosystemPaths);
        const installedSkills = listInstalledEcosystemEntries('skill', ecosystemPaths);
        const installedHookPacks = listInstalledEcosystemEntries('hook-pack', ecosystemPaths);
        const installedPolicyPacks = listInstalledEcosystemEntries('policy-pack', ecosystemPaths);
        ctx.print([
          'Marketplace Overview',
          `  curated plugins: ${pluginCatalog.length}`,
          `  curated skills: ${skillCatalog.length}`,
          `  curated hook packs: ${hookPackCatalog.length}`,
          `  curated policy packs: ${policyPackCatalog.length}`,
          `  installed plugins: ${installedPlugins.length}`,
          `  installed skills: ${installedSkills.length}`,
          `  installed hook packs: ${installedHookPacks.length}`,
          `  installed policy packs: ${installedPolicyPacks.length}`,
        ].join('\n'));
        return;
      }
      if (sub === 'browse') {
        const query = args.slice(1).join(' ');
        const [pluginEntries, skillEntries, hookPackEntries, policyPackEntries] = await Promise.all([
          query ? searchEcosystemCatalog('plugin', query, ecosystemPaths) : loadEcosystemCatalog('plugin', ecosystemPaths),
          query ? searchEcosystemCatalog('skill', query, ecosystemPaths) : loadEcosystemCatalog('skill', ecosystemPaths),
          query ? searchEcosystemCatalog('hook-pack', query, ecosystemPaths) : loadEcosystemCatalog('hook-pack', ecosystemPaths),
          query ? searchEcosystemCatalog('policy-pack', query, ecosystemPaths) : loadEcosystemCatalog('policy-pack', ecosystemPaths),
        ]);
        ctx.print([
          `Marketplace Browse${query ? ` (${query})` : ''}`,
          `  plugins: ${pluginEntries.length}`,
          ...pluginEntries.map((entry) => `    plugin  ${entry.id}  ${entry.name}  ${entry.summary}`),
          `  skills: ${skillEntries.length}`,
          ...skillEntries.map((entry) => `    skill   ${entry.id}  ${entry.name}  ${entry.summary}`),
          `  hook packs: ${hookPackEntries.length}`,
          ...hookPackEntries.map((entry) => `    hook-pack   ${entry.id}  ${entry.name}  ${entry.summary}`),
          `  policy packs: ${policyPackEntries.length}`,
          ...policyPackEntries.map((entry) => `    policy-pack ${entry.id}  ${entry.name}  ${entry.summary}`),
        ].join('\n'));
        return;
      }
      if (sub === 'recommend') {
        // Ranking is asked for here and awaited, so the answer is the ranked list, not the one before it.
        const snapshot = await requireReadModels(ctx).marketplace.recommend();
        if (snapshot.ranking === 'off' || snapshot.ranking === 'failed') {
          ctx.print(['Marketplace Recommendations', ...snapshot.startupIssues.map((issue) => `  ${issue}`)].join('\n'));
          return;
        }
        const recommendations = snapshot.recommendations;
        ctx.print(recommendations.length > 0
          ? [
            'Marketplace Recommendations',
            ...recommendations.map((recommendation) => `  ${recommendation.kind} ${recommendation.entry.id}  ${recommendation.title}`),
            ...recommendations.map((recommendation) => `    ${recommendation.reason}  next=${recommendation.command}`),
          ].join('\n')
          : 'Marketplace Recommendations\n  No contextual recommendations right now.');
        return;
      }
      if (sub === 'installed') {
        const receipts = [
          ...listInstalledEcosystemEntries('plugin', ecosystemPaths).map((receipt) => `  plugin  ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
          ...listInstalledEcosystemEntries('skill', ecosystemPaths).map((receipt) => `  skill   ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
          ...listInstalledEcosystemEntries('hook-pack', ecosystemPaths).map((receipt) => `  hook-pack   ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
          ...listInstalledEcosystemEntries('policy-pack', ecosystemPaths).map((receipt) => `  policy-pack ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
        ];
        ctx.print(receipts.length > 0
          ? ['Marketplace Installs', ...receipts].join('\n')
          : 'Marketplace Installs\n  No curated plugins or skills installed yet.');
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const target = args[2];
        const scope = mode === 'inspect' ? 'project' : parseScope(args[3], ctx);
        if ((mode === 'export' || mode === 'inspect' || mode === 'import') && !target) {
          throw commandRefusal(`Usage: /marketplace bundle ${mode} <path>${mode === 'export' || mode === 'import' ? ' [project|user]' : ''}`);
        }
        if (mode === 'export') {
          const bundle = exportEcosystemCatalogBundle(scope, ecosystemPaths);
          const targetPath = shellPaths.resolveWorkspacePath(target!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Marketplace bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect' || mode === 'import') {
          const bundlePath = shellPaths.resolveWorkspacePath(target!);
          let bundle: EcosystemCatalogBundle;
          try {
            bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as EcosystemCatalogBundle;
          } catch (error) {
            throw commandRefusal(`Marketplace bundle ${mode} failed: could not read ${bundlePath} as JSON (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`, undefined, 'BUNDLE_UNREADABLE');
          }
          if (mode === 'inspect') {
            const summary = inspectEcosystemCatalogBundle(bundle);
            // Date rejects values outside +-8.64e15 ms, so a bundle's number can pass isFinite and still not be a date.
            const exportedDate = typeof summary.exportedAt === 'number' ? new Date(summary.exportedAt) : undefined;
            const exportedAt = exportedDate !== undefined && !Number.isNaN(exportedDate.getTime())
              ? exportedDate.toISOString()
              : 'unknown';
            ctx.print([
              'Marketplace Bundle Review',
              `  exportedAt: ${exportedAt}`,
              `  scope: ${summary.scope}`,
              `  plugins: ${summary.counts.plugin}`,
              `  skills: ${summary.counts.skill}`,
              `  hook packs: ${summary.counts['hook-pack']}`,
              `  policy packs: ${summary.counts['policy-pack']}`,
            ].join('\n'));
            return;
          }
          const result = importEcosystemCatalogBundle(bundle, { ...ecosystemPaths, scope });
          if (result.error) {
            throw commandRefusal(`Marketplace bundle import failed: ${result.error}`, undefined, 'BUNDLE_IMPORT_FAILED');
          }
          ctx.print([
            `Marketplace bundle imported from ${bundlePath}`,
            `  merged into existing entries by kind and id; ${result.rejected.length} rejected`,
            `  entries: ${result.imported}`,
            ...Object.entries(result.pathByKind).map(([kind, path]) => `  ${kind}: ${path}`),
            ...result.rejected.map((entry) => `  rejected ${entry.id}: ${entry.reason}`),
          ].join('\n'));
          return;
        }
        throw commandRefusal('Usage: /marketplace bundle <export|inspect|import> <path> [project|user]');
      }

      const kind = args[1] as EcosystemEntryKind | undefined;
      const entryId = args[2];
      if ((sub === 'review' || sub === 'provenance' || sub === 'install-hint' || sub === 'install' || sub === 'update' || sub === 'rollback' || sub === 'history' || sub === 'uninstall' || sub === 'receipt') && (!kind || !entryId || !['plugin', 'skill', 'hook-pack', 'policy-pack'].includes(kind))) {
        throw commandRefusal(`Usage: /marketplace ${sub} <plugin|skill|hook-pack|policy-pack> <id>${sub === 'install' || sub === 'update' || sub === 'rollback' || sub === 'history' || sub === 'uninstall' || sub === 'receipt' ? ' [project|user]' : ''}`);
      }
      if (sub === 'review') {
        const entry = resolveMarketplaceEntry(kind!, entryId!, ecosystemPaths);
        if (!entry) throw unknownEntry(kind, entryId);
        const review = await reviewEcosystemCatalogEntry(entry, ecosystemPaths);
        ctx.print([
          `Marketplace Review: ${entry.name}`,
          `  kind: ${kind}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  sourceKind: ${review.sourceKind}`,
          `  sourceExists: ${review.sourceExists ? 'yes' : 'no'}`,
          `  recommendedScope: ${review.recommendedScope}`,
          `  risk: ${review.riskLevel}`,
          `  compatibility: ${review.compatibility.status}`,
          `  notes: ${formatCompatibility(review)}`,
        ].join('\n'));
        return;
      }
      if (sub === 'provenance') {
        const entry = resolveMarketplaceEntry(kind!, entryId!, ecosystemPaths);
        if (!entry) throw unknownEntry(kind, entryId);
        const review = await reviewEcosystemCatalogEntry(entry, ecosystemPaths);
        ctx.print([
          `Marketplace Provenance: ${entry.name}`,
          `  source: ${entry.source}`,
          `  provenance: ${entry.provenance ?? '(none declared)'}`,
          `  version: ${entry.version ?? '(unspecified)'}`,
          `  author: ${entry.author ?? '(unspecified)'}`,
          `  signature: ${entry.signature ?? '(none declared)'}`,
          `  compatibility: ${formatCompatibility(review)}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'install-hint') {
        const entry = resolveMarketplaceEntry(kind!, entryId!, ecosystemPaths);
        if (!entry) throw unknownEntry(kind, entryId);
        ctx.print([
          `Marketplace Install Guidance: ${entry.name}`,
          `  kind: ${kind}`,
          `  source: ${entry.source}`,
          `  install hint: ${entry.installHint ?? 'Install from a local curated source with explicit scope.'}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'receipt') {
        const scope = parseScope(args[3], ctx);
        const result = inspectInstalledEcosystemEntry(kind!, entryId!, { ...ecosystemPaths, scope });
        if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
        const { receipt } = result;
        ctx.print([
          `Marketplace Receipt: ${receipt.entry.name}`,
          `  installedAt: ${new Date(receipt.installedAt).toISOString()}`,
          `  scope: ${receipt.scope}`,
          `  targetPath: ${receipt.targetPath}`,
          `  provenance: ${receipt.provenanceSummary}`,
          `  compatibility: ${receipt.compatibility.status}`,
          ...receipt.compatibility.reasons.map((reason) => `  note: ${reason}`),
        ].join('\n'));
        return;
      }
      if (sub === 'history') {
        const scope = parseScope(args[3], ctx);
        const backups = listEcosystemInstallBackups(kind!, entryId!, { ...ecosystemPaths, scope });
        ctx.print(backups.length > 0
          ? [
            `Marketplace Rollback History: ${kind} ${entryId}`,
            ...backups.map((backup) => `  ${backup.id}  ${new Date(backup.createdAt).toISOString()}  ${backup.reason}  ${backup.receipt.entry.version ?? 'n/a'}`),
          ].join('\n')
          : `Marketplace Rollback History: ${kind} ${entryId}\n  No rollback backups recorded.`);
        return;
      }
      if (sub === 'install' || sub === 'update' || sub === 'rollback' || sub === 'uninstall') {
        const scope = parseScope(args[3], ctx);
        if (sub === 'install') {
          const result = installEcosystemCatalogEntry(kind!, entryId!, { ...ecosystemPaths, scope });
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          ctx.print(`Installed curated ${kind} ${entryId} into ${result.receipt.targetPath}`);
          return;
        }
        if (sub === 'update') {
          const result = updateInstalledEcosystemEntry(kind!, entryId!, { ...ecosystemPaths, scope });
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          ctx.print(`Updated curated ${kind} ${entryId} in ${result.receipt.targetPath}`);
          return;
        }
        if (sub === 'rollback') {
          const backupId = args[4];
          const result = rollbackInstalledEcosystemEntry(kind!, entryId!, { ...ecosystemPaths, scope, backupId });
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          ctx.print(`Rolled back curated ${kind} ${entryId} in ${result.receipt.targetPath} using backup ${result.restoredFrom.id}`);
          return;
        }
        const result = uninstallEcosystemCatalogEntry(kind!, entryId!, { ...ecosystemPaths, scope });
        if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
        ctx.print(`Uninstalled curated ${kind} ${entryId} from ${result.removedPath}`);
        return;
      }
      throw commandRefusal('Usage: /marketplace [open|overview|recommend|browse [query]|review <plugin|skill|hook-pack|policy-pack> <id>|provenance <plugin|skill|hook-pack|policy-pack> <id>|install-hint <plugin|skill|hook-pack|policy-pack> <id>|install <plugin|skill|hook-pack|policy-pack> <id> [project|user]|update <plugin|skill|hook-pack|policy-pack> <id> [project|user]|rollback <plugin|skill|hook-pack|policy-pack> <id> [project|user] [backupId]|history <plugin|skill|hook-pack|policy-pack> <id> [project|user]|uninstall <plugin|skill|hook-pack|policy-pack> <id> [project|user]|receipt <plugin|skill|hook-pack|policy-pack> <id> [project|user]|bundle export <path> [project|user]|bundle inspect <path>|bundle import <path> [project|user]|installed]');
    },
  });
}
