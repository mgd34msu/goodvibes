import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { describeUncheckedCatalogEntries, exportEcosystemCatalogBundle, importEcosystemCatalogBundle, inspectEcosystemCatalogBundle, inspectInstalledEcosystemEntry, installEcosystemCatalogEntry, listEcosystemInstallBackups, listInstalledEcosystemEntries, loadEcosystemCatalog, rollbackInstalledEcosystemEntry, reviewEcosystemCatalogEntry, searchEcosystemCatalog, uninstallEcosystemCatalogEntry, updateInstalledEcosystemEntry } from '@goodvibes/engine/platform/platform/runtime/ecosystem/catalog';
import type { EcosystemCatalogBundle, EcosystemCatalogEntry, EcosystemEntryKind } from '@/runtime/index.ts';
import { openModalCommand, requireEcosystemCatalogPaths, requireReadModels, requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type ActionDescription, type ActionValues, type InputDescription, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';

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

function unknownEntry(kind: string | undefined, entryId: string | undefined): Error {
  return commandRefusal(`Unknown curated ${kind} entry: ${entryId}`, '/marketplace browse lists the catalog entries', 'NOT_FOUND');
}

/** "Install for": the one labelled choice behind every scope of /marketplace, /plugin and /skills. */
export const INSTALL_SCOPE: InputDescription = {
  id: 'scope', label: 'Install for', help: 'This project, or all your projects', kind: 'choice',
  choices: [{ value: 'project', label: 'This project' }, { value: 'user', label: 'All your projects' }],
  required: { default: 'project', defaultMeans: 'this project' }, typed: { flag: '--scope' },
};
const KINDS = [
  { value: 'plugin', label: 'Plugin' },
  { value: 'skill', label: 'Skill' },
  { value: 'hook-pack', label: 'Hook pack' },
  { value: 'policy-pack', label: 'Policy pack' },
];
const KIND_LABEL = new Map(KINDS.map((kind) => [kind.value, kind.label.toLowerCase()]));
const TERMINAL_ONLY = 'The catalog and what is installed are on this machine.';

const CATALOG = defineList<CommandContext>({
  name: 'marketplace.catalog',
  async read(ctx, earlier) {
    const kind = earlier.kind as EcosystemEntryKind | undefined;
    if (!kind) return [];
    const installed = new Set(listInstalledEcosystemEntries(kind, requireEcosystemCatalogPaths(ctx)).map((receipt) => receipt.entry.id));
    return loadEcosystemCatalog(kind, requireEcosystemCatalogPaths(ctx)).map((entry): ListRow => ({ value: entry.id, label: entry.name, detail: entry.summary, ...(installed.has(entry.id) ? { state: 'installed' } : {}) }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const INSTALLED = defineList<CommandContext>({
  name: 'marketplace.installed',
  async read(ctx, earlier) {
    const kind = earlier.kind as EcosystemEntryKind | undefined;
    if (!kind) return [];
    return listInstalledEcosystemEntries(kind, requireEcosystemCatalogPaths(ctx)).map((receipt): ListRow => ({ value: receipt.entry.id, label: receipt.entry.name, state: receipt.scope === 'user' ? 'all your projects' : 'this project' }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});
const BACKUPS = defineList<CommandContext>({
  name: 'marketplace.backups',
  async read(ctx, earlier) {
    const kind = earlier.kind as EcosystemEntryKind | undefined;
    if (!kind || !earlier.entry) return [];
    const scope = earlier.scope === 'user' ? 'user' : 'project';
    return listEcosystemInstallBackups(kind, earlier.entry, { ...requireEcosystemCatalogPaths(ctx), scope })
      .map((backup): ListRow => ({ value: backup.id, label: new Date(backup.createdAt).toLocaleString(), detail: backup.reason, state: backup.receipt.entry.version ?? undefined }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});

const KIND: InputDescription = { id: 'kind', label: 'Kind', help: 'What sort of thing it is', kind: 'choice', choices: KINDS, required: true, typed: { position: 1 } };
const CATALOG_ENTRY = listInput({ id: 'entry', label: 'Entry', help: 'Curated entries of this kind', list: CATALOG, position: 2, dependsOn: 'kind' });
const INSTALLED_ENTRY = listInput({ id: 'entry', label: 'Entry', help: 'Installed entries of this kind', list: INSTALLED, position: 2, dependsOn: 'kind' });
const BUNDLE_FILE = textInput({ id: 'path', label: 'Bundle file', help: 'A marketplace bundle (JSON)', why: 'a file path in this project', kind: 'path', typed: { position: 1 } });

function entryOf(ctx: CommandContext, values: ActionValues): EcosystemCatalogEntry {
  const entry = resolveMarketplaceEntry(values.kind as EcosystemEntryKind, values.entry!, requireEcosystemCatalogPaths(ctx));
  if (!entry) throw unknownEntry(values.kind, values.entry);
  return entry;
}
function scoped(ctx: CommandContext, values: ActionValues) {
  return { ...requireEcosystemCatalogPaths(ctx), scope: values.scope === 'user' ? 'user' as const : 'project' as const };
}
function installChange(fields: Pick<ActionDescription<CommandContext>, 'id' | 'label' | 'word' | 'sentence' | 'risk' | 'undoneBy'> & { readonly inputs: readonly InputDescription[]; readonly run: ActionDescription<CommandContext>['run'] }): ActionDescription<CommandContext> {
  return { ...fields, done: '', touches: 'this-machine', lasts: 'kept', operator: { terminalOnly: TERMINAL_ONLY }, example: { kind: 'skill', entry: 'release-notes' } };
}

export function registerMarketplaceRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'marketplace',
    title: 'Marketplace',
    summary: 'Find, install and update curated plugins, skills, hook packs and policy packs',
    group: 'Extensions',
    report: 'overview',
    firstScreenRows: [
      'overview', 'browse', 'recommend', 'install', 'installed',
      { label: 'Check an entry before installing', actions: ['review', 'provenance', 'install-hint'] },
      { label: 'Update, roll back or uninstall', actions: ['update', 'history', 'rollback', 'receipt', 'uninstall'] },
      { label: 'Move installs to another machine', actions: ['bundle-export', 'bundle-inspect', 'bundle-import'] },
      'open',
    ],
    actions: [
      readAction<CommandContext>({
        id: 'overview', label: 'See the marketplace at a glance', word: 'overview',
        sentence: 'Shows how many curated entries of each kind there are and how many are installed.',
        async run(_values, ctx) {
          const paths = requireEcosystemCatalogPaths(ctx);
          const kinds = ['plugin', 'skill', 'hook-pack', 'policy-pack'] as const;
          return [
            'Marketplace Overview',
            ...kinds.map((kind) => `  curated ${KIND_LABEL.get(kind)}s: ${loadEcosystemCatalog(kind, paths).length}`),
            ...kinds.map((kind) => `  installed ${KIND_LABEL.get(kind)}s: ${listInstalledEcosystemEntries(kind, paths).length}`),
          ].join('\n');
        },
      }),
      doAction<CommandContext>({
        id: 'open', label: 'Open the marketplace screen', word: 'open', touches: 'reads',
        sentence: 'Opens the full-screen marketplace to browse and install from.', operator: { terminalOnly: 'It is a terminal screen.' },
        async run(_values, ctx) { openModalCommand(ctx, 'marketplace-modal'); },
      }),
      readAction<CommandContext>({
        id: 'browse', label: 'Browse the catalog', word: 'browse',
        inputs: [textInput({ id: 'query', label: 'Looking for', help: 'Words to search for', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'everything' } })],
        sentence: 'Lists curated entries of every kind that match {query}.', example: { query: 'release notes' },
        async run(values, ctx) {
          const paths = requireEcosystemCatalogPaths(ctx);
          const query = values.query ?? '';
          const browse = (kind: 'plugin' | 'skill' | 'hook-pack' | 'policy-pack') => (query
            ? searchEcosystemCatalog(kind, query, paths)
            : Promise.resolve({ entries: loadEcosystemCatalog(kind, paths), unchecked: 0 }));
          const [plugins, skills, hookPacks, policyPacks] = await Promise.all([browse('plugin'), browse('skill'), browse('hook-pack'), browse('policy-pack')]);
          const unchecked = (search: { readonly unchecked: number }) => {
            const line = describeUncheckedCatalogEntries(search);
            return line ? [`    ${line}`] : [];
          };
          return [
            `Marketplace Browse${query ? ` (${query})` : ''}`,
            `  plugins: ${plugins.entries.length}`, ...plugins.entries.map((entry) => `    plugin  ${entry.id}  ${entry.name}  ${entry.summary}`), ...unchecked(plugins),
            `  skills: ${skills.entries.length}`, ...skills.entries.map((entry) => `    skill   ${entry.id}  ${entry.name}  ${entry.summary}`), ...unchecked(skills),
            `  hook packs: ${hookPacks.entries.length}`, ...hookPacks.entries.map((entry) => `    hook-pack   ${entry.id}  ${entry.name}  ${entry.summary}`), ...unchecked(hookPacks),
            `  policy packs: ${policyPacks.entries.length}`, ...policyPacks.entries.map((entry) => `    policy-pack ${entry.id}  ${entry.name}  ${entry.summary}`), ...unchecked(policyPacks),
          ].join('\n');
        },
      }),
      readAction<CommandContext>({
        id: 'recommend', label: 'See what fits this project', word: 'recommend',
        sentence: 'Shows curated entries that fit this project, ranked when a decision model is set.',
        async run(_values, ctx) {
          // Ranking is asked for here and awaited, so the answer is the ranked list, not the one before it.
          const snapshot = await requireReadModels(ctx).marketplace.recommend();
          if (snapshot.ranking === 'failed') return ['Marketplace Recommendations', ...snapshot.startupIssues.map((issue) => `  ${issue}`)].join('\n');
          const recommendations = snapshot.recommendations;
          // Without a decision model the list is unranked; the snapshot's issues, its notice among them, go above it.
          const notice = snapshot.ranking === 'off' ? snapshot.startupIssues.map((issue) => `  ${issue}`) : [];
          return recommendations.length > 0
            ? ['Marketplace Recommendations', ...notice, ...recommendations.map((recommendation) => `  ${recommendation.kind} ${recommendation.entry.id}  ${recommendation.title}`), ...recommendations.map((recommendation) => `    ${recommendation.reason}  next=${recommendation.command}`)].join('\n')
            : ['Marketplace Recommendations', ...notice, '  No contextual recommendations right now.'].join('\n');
        },
      }),
      readAction<CommandContext>({
        id: 'installed', label: 'See what is installed', word: 'installed',
        sentence: 'Lists every curated entry installed, where, and for which projects.',
        async run(_values, ctx) {
          const paths = requireEcosystemCatalogPaths(ctx);
          const receipts = (['plugin', 'skill', 'hook-pack', 'policy-pack'] as const).flatMap((kind) => listInstalledEcosystemEntries(kind, paths).map((receipt) => `  ${kind.padEnd(11)} ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`));
          return receipts.length > 0 ? ['Marketplace Installs', ...receipts].join('\n') : 'Marketplace Installs\n  No curated plugins or skills installed yet.';
        },
      }),
      readAction<CommandContext>({
        id: 'review', label: 'Check an entry before installing', word: 'review', inputs: [KIND, CATALOG_ENTRY],
        sentence: 'Shows the {kind} {entry}\'s source, risk, compatibility and the scope it suits.', example: { kind: 'skill', entry: 'release-notes' },
        async run(values, ctx) {
          const entry = entryOf(ctx, values);
          const review = await reviewEcosystemCatalogEntry(entry, requireEcosystemCatalogPaths(ctx));
          return [
            `Marketplace Review: ${entry.name}`, `  kind: ${values.kind}`, `  id: ${entry.id}`, `  source: ${entry.source}`, `  sourceKind: ${review.sourceKind}`,
            `  sourceExists: ${review.sourceExists ? 'yes' : 'no'}`, `  recommendedScope: ${review.recommendedScope}`, `  risk: ${review.riskLevel}`,
            `  compatibility: ${review.compatibility.status}`, `  notes: ${formatCompatibility(review)}`,
          ].join('\n');
        },
      }),
      readAction<CommandContext>({
        id: 'provenance', label: 'See where an entry comes from', word: 'provenance', inputs: [KIND, CATALOG_ENTRY],
        sentence: 'Shows the {kind} {entry}\'s source, author, version, signature and trust notes.', example: { kind: 'skill', entry: 'release-notes' },
        async run(values, ctx) {
          const entry = entryOf(ctx, values);
          const review = await reviewEcosystemCatalogEntry(entry, requireEcosystemCatalogPaths(ctx));
          return [
            `Marketplace Provenance: ${entry.name}`, `  source: ${entry.source}`, `  provenance: ${entry.provenance ?? '(none declared)'}`, `  version: ${entry.version ?? '(unspecified)'}`,
            `  author: ${entry.author ?? '(unspecified)'}`, `  signature: ${entry.signature ?? '(none declared)'}`, `  compatibility: ${formatCompatibility(review)}`, `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          ].join('\n');
        },
      }),
      readAction<CommandContext>({
        id: 'install-hint', label: 'See how an entry is installed', word: 'install-hint', inputs: [KIND, CATALOG_ENTRY],
        sentence: 'Shows the {kind} {entry}\'s install guidance and trust notes.', example: { kind: 'skill', entry: 'release-notes' },
        async run(values, ctx) {
          const entry = entryOf(ctx, values);
          return [`Marketplace Install Guidance: ${entry.name}`, `  kind: ${values.kind}`, `  source: ${entry.source}`, `  install hint: ${entry.installHint ?? 'Install from a local curated source with explicit scope.'}`, `  trust notes: ${entry.trustNotes ?? '(none)'}`].join('\n');
        },
      }),
      installChange({
        id: 'install', label: 'Install an entry', word: 'install', inputs: [KIND, CATALOG_ENTRY, INSTALL_SCOPE],
        sentence: 'The {kind} {entry} is installed for {scope} until you change it.', risk: 'none', undoneBy: 'uninstall',
        async run(values, ctx) {
          const result = installEcosystemCatalogEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(ctx, values));
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          return `Installed curated ${values.kind} ${values.entry} into ${result.receipt.targetPath}`;
        },
      }),
      installChange({
        id: 'update', label: 'Update an installed entry', word: 'update', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
        sentence: 'The installed {kind} {entry} ({scope}) is updated to the catalog\'s version until you change it; the old one is kept as a backup.', risk: 'none', undoneBy: 'rollback',
        async run(values, ctx) {
          const result = updateInstalledEcosystemEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(ctx, values));
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          return `Updated curated ${values.kind} ${values.entry} in ${result.receipt.targetPath}`;
        },
      }),
      readAction<CommandContext>({
        id: 'history', label: 'See an entry\'s backups', word: 'history', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
        sentence: 'Lists the backups the {kind} {entry} can be rolled back to.', example: { kind: 'skill', entry: 'release-notes' },
        async run(values, ctx) {
          const backups = listEcosystemInstallBackups(values.kind as EcosystemEntryKind, values.entry!, scoped(ctx, values));
          return backups.length > 0
            ? [`Marketplace Rollback History: ${values.kind} ${values.entry}`, ...backups.map((backup) => `  ${backup.id}  ${new Date(backup.createdAt).toISOString()}  ${backup.reason}  ${backup.receipt.entry.version ?? 'n/a'}`)].join('\n')
            : `Marketplace Rollback History: ${values.kind} ${values.entry}\n  No rollback backups recorded.`;
        },
      }),
      installChange({
        id: 'rollback', label: 'Roll an entry back to a backup', word: 'rollback',
        inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE, { ...listInput({ id: 'backup', label: 'Backup', help: 'Its backups, newest first', list: BACKUPS, dependsOn: 'entry', optional: { default: '', means: 'the newest one' } }), typed: { flag: '--backup' } }],
        sentence: 'The installed {kind} {entry} ({scope}) goes back to an earlier backup until you change it.', risk: 'none', undoneBy: 'update',
        async run(values, ctx) {
          const result = rollbackInstalledEcosystemEntry(values.kind as EcosystemEntryKind, values.entry!, { ...scoped(ctx, values), ...(values.backup ? { backupId: values.backup } : {}) });
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          return `Rolled back curated ${values.kind} ${values.entry} in ${result.receipt.targetPath} using backup ${result.restoredFrom.id}`;
        },
      }),
      readAction<CommandContext>({
        id: 'receipt', label: 'See an entry\'s install receipt', word: 'receipt', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
        sentence: 'Shows when and where the {kind} {entry} was installed, and its provenance and compatibility.', example: { kind: 'skill', entry: 'release-notes' },
        async run(values, ctx) {
          const result = inspectInstalledEcosystemEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(ctx, values));
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          const { receipt } = result;
          return [
            `Marketplace Receipt: ${receipt.entry.name}`, `  installedAt: ${new Date(receipt.installedAt).toISOString()}`, `  scope: ${receipt.scope}`, `  targetPath: ${receipt.targetPath}`,
            `  provenance: ${receipt.provenanceSummary}`, `  compatibility: ${receipt.compatibility.status}`, ...receipt.compatibility.reasons.map((reason) => `  note: ${reason}`),
          ].join('\n');
        },
      }),
      installChange({
        id: 'uninstall', label: 'Uninstall an entry', word: 'uninstall', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
        sentence: 'The installed {kind} {entry} ({scope}) is removed from disk with its install receipt; /marketplace install installs it again from the catalog.', risk: 'cannot-be-undone',
        async run(values, ctx) {
          const result = uninstallEcosystemCatalogEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(ctx, values));
          if (!result.ok) throw commandRefusal(result.error, undefined, 'NOT_DONE');
          return `Uninstalled curated ${values.kind} ${values.entry} from ${result.removedPath}`;
        },
      }),
      doAction<CommandContext>({
        id: 'bundle-export', label: 'Save your installs to a bundle', word: 'bundle-export', inputs: [{ ...BUNDLE_FILE, help: 'Where to write the bundle' }, INSTALL_SCOPE],
        sentence: 'What is installed for {scope} is written to {path} as a bundle another machine can bring in.',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { path: 'marketplace.json' },
        async run(values, ctx) {
          const bundle = exportEcosystemCatalogBundle(values.scope === 'user' ? 'user' : 'project', requireEcosystemCatalogPaths(ctx));
          const targetPath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          return `Saved the marketplace bundle to ${targetPath}`;
        },
      }),
      readAction<CommandContext>({
        id: 'bundle-inspect', label: 'Look inside a marketplace bundle', word: 'bundle-inspect', inputs: [BUNDLE_FILE],
        sentence: 'Shows what {path} holds; nothing is installed.', example: { path: 'marketplace.json' },
        async run(values, ctx) {
          const summary = inspectEcosystemCatalogBundle(readMarketplaceBundle(requireShellPaths(ctx).resolveWorkspacePath(values.path!), 'inspect'));
          // Date rejects values outside +-8.64e15 ms, so a bundle's number can pass isFinite and still not be a date.
          const exportedDate = typeof summary.exportedAt === 'number' ? new Date(summary.exportedAt) : undefined;
          const exportedAt = exportedDate !== undefined && !Number.isNaN(exportedDate.getTime()) ? exportedDate.toISOString() : 'unknown';
          return ['Marketplace Bundle Review', `  exportedAt: ${exportedAt}`, `  scope: ${summary.scope}`, `  plugins: ${summary.counts.plugin}`, `  skills: ${summary.counts.skill}`, `  hook packs: ${summary.counts['hook-pack']}`, `  policy packs: ${summary.counts['policy-pack']}`].join('\n');
        },
      }),
      {
        id: 'bundle-import', label: 'Bring in installs from a bundle', word: 'bundle-import', inputs: [BUNDLE_FILE, INSTALL_SCOPE],
        sentence: 'The entries in {path} are merged into what is installed for {scope}, by kind and id, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: TERMINAL_ONLY }, example: { path: 'marketplace.json' },
        async run(values, ctx) {
          const bundlePath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          const result = importEcosystemCatalogBundle(readMarketplaceBundle(bundlePath, 'import'), { ...requireEcosystemCatalogPaths(ctx), scope: values.scope === 'user' ? 'user' : 'project' });
          if (result.error) throw commandRefusal(`Marketplace bundle import failed: ${result.error}`, undefined, 'BUNDLE_IMPORT_FAILED');
          return [
            `Brought in the marketplace bundle from ${bundlePath}`,
            `  merged into existing entries by kind and id; ${result.rejected.length} rejected`,
            `  entries: ${result.imported}`,
            ...Object.entries(result.pathByKind).map(([kind, path]) => `  ${kind}: ${path}`),
            ...result.rejected.map((entry) => `  rejected ${entry.id}: ${entry.reason}`),
          ].join('\n');
        },
      },
    ],
  }));
}

function readMarketplaceBundle(bundlePath: string, mode: 'inspect' | 'import'): EcosystemCatalogBundle {
  try {
    return JSON.parse(readFileSync(bundlePath, 'utf-8')) as EcosystemCatalogBundle;
  } catch (error) {
    throw commandRefusal(`Marketplace bundle ${mode} failed: could not read ${bundlePath} as JSON (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`, undefined, 'BUNDLE_UNREADABLE');
  }
}
