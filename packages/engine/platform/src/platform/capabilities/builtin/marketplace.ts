/**
 * The marketplace: the local curated catalog of plugins, skills, hook packs
 * and policy packs, and what is installed from it. Every act is managing what
 * is kept on this machine (the catalog under `.goodvibes/tui/ecosystem`, the
 * installs under `.goodvibes/` of the project or of the user), so each runs in
 * the daemon, for the caller's project; what is installed is loaded by each
 * program that runs turns, as before.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  describeUncheckedCatalogEntries, exportEcosystemCatalogBundle, importEcosystemCatalogBundle, inspectEcosystemCatalogBundle,
  inspectInstalledEcosystemEntry, installEcosystemCatalogEntry, listEcosystemInstallBackups, listInstalledEcosystemEntries, loadEcosystemCatalog,
  rollbackInstalledEcosystemEntry, reviewEcosystemCatalogEntry, searchEcosystemCatalog, uninstallEcosystemCatalogEntry, updateInstalledEcosystemEntry,
  type EcosystemCatalogBundle, type EcosystemCatalogEntry, type EcosystemCatalogPathOptions, type EcosystemEntryKind,
} from '../../runtime/ecosystem/catalog.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { CapabilityRefusal, type ActionValues, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** What the marketplace capabilities need: the catalog and install folders of the caller's project. */
export interface MarketplaceCapabilityServices {
  readonly marketplace: {
    forProject(workingDirectory: string | undefined): { readonly catalog: EcosystemCatalogPathOptions; readonly cwd: string };
  };
}

export const MARKETPLACE_CATALOG_LIST = 'marketplace.catalog' as ListName;
export const MARKETPLACE_INSTALLED_LIST = 'marketplace.installed' as ListName;
export const MARKETPLACE_BACKUPS_LIST = 'marketplace.backups' as ListName;

const KINDS: readonly FixedChoice[] = [
  { value: 'plugin', label: 'Plugin' },
  { value: 'skill', label: 'Skill' },
  { value: 'hook-pack', label: 'Hook pack' },
  { value: 'policy-pack', label: 'Policy pack' },
];
const ALL_KINDS = ['plugin', 'skill', 'hook-pack', 'policy-pack'] as const;
const KIND_LABEL = new Map(KINDS.map((kind) => [kind.value, kind.label.toLowerCase()]));

/** "Install for": this project, or all your projects. */
export const INSTALL_SCOPE: InputDescription = {
  id: 'scope', label: 'Install for', help: 'This project, or all your projects', kind: 'choice',
  choices: [{ value: 'project', label: 'This project' }, { value: 'user', label: 'All your projects' }],
  required: { default: 'project', defaultMeans: 'this project' }, typed: { flag: '--scope' },
};
const KIND: InputDescription = { id: 'kind', label: 'Kind', help: 'What sort of thing it is', kind: 'choice', choices: KINDS, required: true, typed: { position: 1 } };
const CATALOG_ENTRY: InputDescription = { id: 'entry', label: 'Entry', help: 'Curated entries of this kind', kind: 'choice', choices: { list: MARKETPLACE_CATALOG_LIST, dependsOn: 'kind' }, required: true, typed: { position: 2 } };
const INSTALLED_ENTRY: InputDescription = { id: 'entry', label: 'Entry', help: 'Installed entries of this kind', kind: 'choice', choices: { list: MARKETPLACE_INSTALLED_LIST, dependsOn: 'kind' }, required: true, typed: { position: 2 } };
const BUNDLE_FILE: InputDescription = { id: 'path', label: 'Bundle file', help: 'A marketplace bundle (JSON)', kind: 'path', freeTextReason: 'a file path in this project', required: true, typed: { position: 1 } };
const EXAMPLE = { kind: 'skill', entry: 'release-notes' };

function project(services: MarketplaceCapabilityServices, caller: CapabilityCaller) {
  return services.marketplace.forProject(caller.workingDirectory);
}
function scoped(catalog: EcosystemCatalogPathOptions, values: ActionValues) {
  return { ...catalog, scope: values.scope === 'user' ? 'user' as const : 'project' as const };
}
function entryOf(catalog: EcosystemCatalogPathOptions, values: ActionValues): EcosystemCatalogEntry {
  const entry = loadEcosystemCatalog(values.kind as EcosystemEntryKind, catalog).find((candidate) => candidate.id === values.entry);
  if (!entry) throw new CapabilityRefusal(`No curated ${KIND_LABEL.get(values.kind ?? '') ?? values.kind} named ${values.entry} is in the catalog.`, 'The marketplace\'s catalog lists its entries.', 'NOT_FOUND');
  return entry;
}
function notDone(error: string): never {
  throw new CapabilityRefusal(error, undefined, 'NOT_DONE');
}
const fileIn = (cwd: string, path: string): string => isAbsolute(path) ? path : resolve(cwd, path);
const changed = (): void => noteListChanged({ list: 'tools', change: 'changed' });

function readBundle(path: string, mode: 'inspect' | 'import'): EcosystemCatalogBundle {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as EcosystemCatalogBundle;
  } catch (error) {
    throw new CapabilityRefusal(`Marketplace bundle ${mode} failed: could not read ${path} as JSON (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`, undefined, 'BUNDLE_UNREADABLE');
  }
}

function read(fields: Pick<CapabilityDefinition<MarketplaceCapabilityServices>, 'actionId' | 'label' | 'word' | 'sentence' | 'run'> & { readonly inputs?: readonly InputDescription[]; readonly example?: ActionValues }): CapabilityDefinition<MarketplaceCapabilityServices> {
  return {
    capability: { id: `marketplace.${fields.word}`, group: 'tools', home: 'daemon', repeat: 'safe' },
    inputs: [], example: {}, ...fields, done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none',
  };
}

export const MARKETPLACE_OVERVIEW = read({
  actionId: 'overview', label: 'See the marketplace at a glance', word: 'overview',
  sentence: 'Shows how many curated entries of each kind there are and how many are installed.',
  async run(_values, services, caller) {
    const { catalog } = project(services, caller);
    const counts = ALL_KINDS.map((kind) => ({ kind, curated: loadEcosystemCatalog(kind, catalog).length, installed: listInstalledEcosystemEntries(kind, catalog).length }));
    return {
      text: ['Marketplace Overview', ...counts.map((count) => `  curated ${KIND_LABEL.get(count.kind)}s: ${count.curated}`), ...counts.map((count) => `  installed ${KIND_LABEL.get(count.kind)}s: ${count.installed}`)].join('\n'),
      data: { counts },
    };
  },
});

export const MARKETPLACE_BROWSE = read({
  actionId: 'browse', label: 'Browse the catalog', word: 'browse',
  inputs: [{ id: 'query', label: 'Looking for', help: 'Words to search for', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'everything' }, typed: { tail: true } }],
  sentence: 'Lists curated entries of every kind that match {query}.', example: { query: 'release notes' },
  async run(values, services, caller) {
    const { catalog } = project(services, caller);
    const query = values.query ?? '';
    const found = await Promise.all(ALL_KINDS.map(async (kind) => ({ kind, ...(query ? await searchEcosystemCatalog(kind, query, catalog) : { entries: loadEcosystemCatalog(kind, catalog), unchecked: 0 }) })));
    const installed = new Set(ALL_KINDS.flatMap((kind) => listInstalledEcosystemEntries(kind, catalog).map((receipt) => `${kind}:${receipt.entry.id}`)));
    const lines = [`Marketplace Browse${query ? ` (${query})` : ''}`];
    for (const group of found) {
      lines.push(`  ${KIND_LABEL.get(group.kind)}s: ${group.entries.length}`, ...group.entries.map((entry) => `    ${group.kind.padEnd(11)} ${entry.id}  ${entry.name}  ${entry.summary}`));
      const unchecked = describeUncheckedCatalogEntries(group);
      if (unchecked) lines.push(`    ${unchecked}`);
    }
    return {
      text: lines.join('\n'),
      data: { entries: found.flatMap((group) => group.entries.map((entry) => ({ kind: group.kind, id: entry.id, name: entry.name, summary: entry.summary, installed: installed.has(`${group.kind}:${entry.id}`) }))) },
    };
  },
});

export const MARKETPLACE_INSTALLED = read({
  actionId: 'installed', label: 'See what is installed', word: 'installed',
  sentence: 'Lists every curated entry installed, where, and for which projects.',
  async run(_values, services, caller) {
    const { catalog } = project(services, caller);
    const receipts = ALL_KINDS.flatMap((kind) => listInstalledEcosystemEntries(kind, catalog).map((receipt) => ({ kind, id: receipt.entry.id, name: receipt.entry.name, scope: receipt.scope, path: receipt.targetPath, version: receipt.entry.version ?? '' })));
    return {
      text: receipts.length > 0 ? ['Marketplace Installs', ...receipts.map((receipt) => `  ${receipt.kind.padEnd(11)} ${receipt.id}  ${receipt.scope}  ${receipt.path}`)].join('\n') : 'Marketplace Installs\n  No curated plugins or skills installed yet.',
      data: { installed: receipts },
    };
  },
});

export const MARKETPLACE_REVIEW = read({
  actionId: 'review', label: 'Check an entry before installing', word: 'review', inputs: [KIND, CATALOG_ENTRY],
  sentence: 'Shows the {kind} {entry}\'s source, risk, compatibility and the scope it suits.', example: EXAMPLE,
  async run(values, services, caller) {
    const { catalog } = project(services, caller);
    const entry = entryOf(catalog, values);
    const review = await reviewEcosystemCatalogEntry(entry, catalog);
    const notes = review.compatibility.reasons.length === 0 ? 'compatible with current runtime' : review.compatibility.reasons.join('; ');
    return {
      text: [`Marketplace Review: ${entry.name}`, `  kind: ${values.kind}`, `  id: ${entry.id}`, `  source: ${entry.source}`, `  sourceKind: ${review.sourceKind}`,
        `  sourceExists: ${review.sourceExists ? 'yes' : 'no'}`, `  recommendedScope: ${review.recommendedScope}`, `  risk: ${review.riskLevel}`,
        `  compatibility: ${review.compatibility.status}`, `  notes: ${notes}`].join('\n'),
      data: { kind: values.kind, id: entry.id, source: entry.source, sourceExists: review.sourceExists, risk: review.riskLevel, compatibility: review.compatibility.status, recommendedScope: review.recommendedScope },
    };
  },
});

export const MARKETPLACE_PROVENANCE = read({
  actionId: 'provenance', label: 'See where an entry comes from', word: 'provenance', inputs: [KIND, CATALOG_ENTRY],
  sentence: 'Shows the {kind} {entry}\'s source, author, version, signature and trust notes.', example: EXAMPLE,
  async run(values, services, caller) {
    const { catalog } = project(services, caller);
    const entry = entryOf(catalog, values);
    const review = await reviewEcosystemCatalogEntry(entry, catalog);
    return {
      text: [`Marketplace Provenance: ${entry.name}`, `  source: ${entry.source}`, `  provenance: ${entry.provenance ?? '(none declared)'}`, `  version: ${entry.version ?? '(unspecified)'}`,
        `  author: ${entry.author ?? '(unspecified)'}`, `  signature: ${entry.signature ?? '(none declared)'}`,
        `  compatibility: ${review.compatibility.reasons.length === 0 ? 'compatible with current runtime' : review.compatibility.reasons.join('; ')}`, `  trust notes: ${entry.trustNotes ?? '(none)'}`].join('\n'),
      data: { id: entry.id, source: entry.source, provenance: entry.provenance ?? null, version: entry.version ?? null, author: entry.author ?? null, signature: entry.signature ?? null },
    };
  },
});

export const MARKETPLACE_INSTALL_HINT = read({
  actionId: 'install-hint', label: 'See how an entry is installed', word: 'install-hint', inputs: [KIND, CATALOG_ENTRY],
  sentence: 'Shows the {kind} {entry}\'s install guidance and trust notes.', example: EXAMPLE,
  async run(values, services, caller) {
    const entry = entryOf(project(services, caller).catalog, values);
    const hint = entry.installHint ?? 'Install from a local curated source with explicit scope.';
    return { text: [`Marketplace Install Guidance: ${entry.name}`, `  kind: ${values.kind}`, `  source: ${entry.source}`, `  install hint: ${hint}`, `  trust notes: ${entry.trustNotes ?? '(none)'}`].join('\n'), data: { id: entry.id, hint, trustNotes: entry.trustNotes ?? null } };
  },
});

export const MARKETPLACE_HISTORY = read({
  actionId: 'history', label: 'See an entry\'s backups', word: 'history', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
  sentence: 'Lists the backups the {kind} {entry} can be rolled back to.', example: EXAMPLE,
  async run(values, services, caller) {
    const backups = listEcosystemInstallBackups(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    return {
      text: backups.length > 0
        ? [`Marketplace Rollback History: ${values.kind} ${values.entry}`, ...backups.map((backup) => `  ${backup.id}  ${new Date(backup.createdAt).toISOString()}  ${backup.reason}  ${backup.receipt.entry.version ?? 'n/a'}`)].join('\n')
        : `Marketplace Rollback History: ${values.kind} ${values.entry}\n  No rollback backups recorded.`,
      data: { backups: backups.map((backup) => ({ id: backup.id, at: backup.createdAt, reason: backup.reason, version: backup.receipt.entry.version ?? null })) },
    };
  },
});

export const MARKETPLACE_RECEIPT = read({
  actionId: 'receipt', label: 'See an entry\'s install receipt', word: 'receipt', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
  sentence: 'Shows when and where the {kind} {entry} was installed, and its provenance and compatibility.', example: EXAMPLE,
  async run(values, services, caller) {
    const result = inspectInstalledEcosystemEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    if (!result.ok) notDone(result.error);
    const { receipt } = result;
    return {
      text: [`Marketplace Receipt: ${receipt.entry.name}`, `  installedAt: ${new Date(receipt.installedAt).toISOString()}`, `  scope: ${receipt.scope}`, `  targetPath: ${receipt.targetPath}`,
        `  provenance: ${receipt.provenanceSummary}`, `  compatibility: ${receipt.compatibility.status}`, ...receipt.compatibility.reasons.map((reason) => `  note: ${reason}`)].join('\n'),
      data: { id: receipt.entry.id, at: receipt.installedAt, scope: receipt.scope, path: receipt.targetPath },
    };
  },
});

export const MARKETPLACE_BUNDLE_INSPECT = read({
  actionId: 'bundle-inspect', label: 'Look inside a marketplace bundle', word: 'bundle-inspect', inputs: [BUNDLE_FILE],
  sentence: 'Shows what {path} holds; nothing is installed.', example: { path: 'marketplace.json' },
  async run(values, services, caller) {
    const summary = inspectEcosystemCatalogBundle(readBundle(fileIn(project(services, caller).cwd, values.path!), 'inspect'));
    // Date rejects values outside +-8.64e15 ms, so a bundle's number can pass isFinite and still not be a date.
    const exportedDate = typeof summary.exportedAt === 'number' ? new Date(summary.exportedAt) : undefined;
    const exportedAt = exportedDate !== undefined && !Number.isNaN(exportedDate.getTime()) ? exportedDate.toISOString() : 'unknown';
    return {
      text: ['Marketplace Bundle Review', `  exportedAt: ${exportedAt}`, `  scope: ${summary.scope}`, `  plugins: ${summary.counts.plugin}`, `  skills: ${summary.counts.skill}`, `  hook packs: ${summary.counts['hook-pack']}`, `  policy packs: ${summary.counts['policy-pack']}`].join('\n'),
      data: { scope: summary.scope, counts: { ...summary.counts } },
    };
  },
});

function change(fields: Pick<CapabilityDefinition<MarketplaceCapabilityServices>, 'actionId' | 'label' | 'word' | 'sentence' | 'risk' | 'run'> & { readonly inputs: readonly InputDescription[]; readonly undoneBy?: string; readonly example?: ActionValues }): CapabilityDefinition<MarketplaceCapabilityServices> {
  return {
    capability: { id: `marketplace.${fields.word}`, group: 'tools', home: 'daemon', repeat: 'safe' },
    example: EXAMPLE, ...fields, done: '', touches: 'this-machine', lasts: 'kept',
  };
}

export const MARKETPLACE_INSTALL = change({
  actionId: 'install', label: 'Install an entry', word: 'install', inputs: [KIND, CATALOG_ENTRY, INSTALL_SCOPE],
  sentence: 'The {kind} {entry} is installed for {scope} until you change it.', risk: 'none', undoneBy: 'uninstall',
  async run(values, services, caller) {
    const result = installEcosystemCatalogEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    if (!result.ok) notDone(result.error);
    changed();
    return { text: `Installed curated ${values.kind} ${values.entry} into ${result.receipt.targetPath}`, data: { kind: values.kind, id: values.entry, path: result.receipt.targetPath } };
  },
});

export const MARKETPLACE_UPDATE = change({
  actionId: 'update', label: 'Update an installed entry', word: 'update', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
  sentence: 'The installed {kind} {entry} ({scope}) is updated to the catalog\'s version until you change it; the old one is kept as a backup.', risk: 'none', undoneBy: 'rollback',
  async run(values, services, caller) {
    const result = updateInstalledEcosystemEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    if (!result.ok) notDone(result.error);
    changed();
    return { text: `Updated curated ${values.kind} ${values.entry} in ${result.receipt.targetPath}`, data: { kind: values.kind, id: values.entry, path: result.receipt.targetPath } };
  },
});

export const MARKETPLACE_ROLLBACK = change({
  actionId: 'rollback', label: 'Roll an entry back to a backup', word: 'rollback',
  inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE, {
    id: 'backup', label: 'Backup', help: 'Its backups, newest first', kind: 'choice', choices: { list: MARKETPLACE_BACKUPS_LIST, dependsOn: 'entry' },
    required: { default: '', defaultMeans: 'the newest one' }, typed: { flag: '--backup' },
  }],
  sentence: 'The installed {kind} {entry} ({scope}) goes back to an earlier backup until you change it.', risk: 'none', undoneBy: 'update',
  async run(values, services, caller) {
    const result = rollbackInstalledEcosystemEntry(values.kind as EcosystemEntryKind, values.entry!, { ...scoped(project(services, caller).catalog, values), ...(values.backup ? { backupId: values.backup } : {}) });
    if (!result.ok) notDone(result.error);
    changed();
    return { text: `Rolled back curated ${values.kind} ${values.entry} in ${result.receipt.targetPath} using backup ${result.restoredFrom.id}`, data: { kind: values.kind, id: values.entry, backup: result.restoredFrom.id } };
  },
});

export const MARKETPLACE_UNINSTALL = change({
  actionId: 'uninstall', label: 'Uninstall an entry', word: 'uninstall', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
  sentence: 'The installed {kind} {entry} ({scope}) is removed from disk with its install receipt; installing it again brings it back from the catalog.', risk: 'cannot-be-undone',
  async run(values, services, caller) {
    const result = uninstallEcosystemCatalogEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    if (!result.ok) notDone(result.error);
    changed();
    return { text: `Uninstalled curated ${values.kind} ${values.entry} from ${result.removedPath}`, data: { kind: values.kind, id: values.entry, path: result.removedPath } };
  },
});

export const MARKETPLACE_BUNDLE_EXPORT: CapabilityDefinition<MarketplaceCapabilityServices> = {
  capability: { id: 'marketplace.bundle-export', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'bundle-export', label: 'Save your installs to a bundle', word: 'bundle-export', inputs: [{ ...BUNDLE_FILE, help: 'Where to write the bundle' }, INSTALL_SCOPE],
  sentence: 'What is installed for {scope} is written to {path} as a bundle another machine can bring in.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'marketplace.json' },
  async run(values, services, caller) {
    const { catalog, cwd } = project(services, caller);
    const bundle = exportEcosystemCatalogBundle(values.scope === 'user' ? 'user' : 'project', catalog);
    const target = fileIn(cwd, values.path!);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
    return { text: `Saved the marketplace bundle to ${target}`, data: { path: target } };
  },
};

export const MARKETPLACE_BUNDLE_IMPORT: CapabilityDefinition<MarketplaceCapabilityServices> = {
  capability: { id: 'marketplace.bundle-import', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'bundle-import', label: 'Bring in installs from a bundle', word: 'bundle-import', inputs: [BUNDLE_FILE, INSTALL_SCOPE],
  sentence: 'The entries in {path} are merged into what is installed for {scope}, by kind and id, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'marketplace.json' },
  async run(values, services, caller) {
    const { catalog, cwd } = project(services, caller);
    const source = fileIn(cwd, values.path!);
    const result = importEcosystemCatalogBundle(readBundle(source, 'import'), { ...catalog, scope: values.scope === 'user' ? 'user' : 'project' });
    if (result.error) throw new CapabilityRefusal(`Marketplace bundle import failed: ${result.error}`, undefined, 'BUNDLE_IMPORT_FAILED');
    changed();
    return {
      text: [`Brought in the marketplace bundle from ${source}`, `  merged into existing entries by kind and id; ${result.rejected.length} rejected`, `  entries: ${result.imported}`,
        ...Object.entries(result.pathByKind).map(([kind, path]) => `  ${kind}: ${path}`), ...result.rejected.map((entry) => `  rejected ${entry.id}: ${entry.reason}`)].join('\n'),
      data: { imported: result.imported, rejected: result.rejected.map((entry) => ({ ...entry })) },
    };
  },
};

/** The backups of one installed entry, for the list a rollback picks from. */
export const MARKETPLACE_BACKUPS = read({
  actionId: 'backups', label: 'See the backups of an installed entry', word: 'backups', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
  sentence: 'Lists the backups the {kind} {entry} was kept as, newest first.', example: EXAMPLE,
  async run(values, services, caller) {
    const backups = listEcosystemInstallBackups(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    return { text: `${backups.length} backup(s).`, data: { backups: backups.map((backup) => ({ id: backup.id, at: backup.createdAt, reason: backup.reason, version: backup.receipt.entry.version ?? '' })) } };
  },
});

/** What the recommendation needs: the program's read of this project, ranked by the decision model when one is set. */
export interface MarketplaceRecommendServices {
  readonly marketplaceRecommend?: {
    recommend(): Promise<{
      readonly ranking: string;
      readonly startupIssues: readonly string[];
      readonly recommendations: readonly { readonly kind: string; readonly entry: { readonly id: string }; readonly title: string; readonly reason: string }[];
    }>;
  } | undefined;
}

/** What fits this project: read by the program holding the conversation, which knows the project as its turns see it. */
export const MARKETPLACE_RECOMMEND: CapabilityDefinition<MarketplaceRecommendServices> = {
  capability: { id: 'marketplace.recommend', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'recommend', label: 'See what fits this project', word: 'recommend', inputs: [],
  sentence: 'Shows curated entries that fit this project, ranked when a decision model is set.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const source = services.marketplaceRecommend;
    if (!source) throw new CapabilityRefusal('This program reads no recommendations for the project.', undefined, 'UNAVAILABLE');
    const snapshot = await source.recommend();
    if (snapshot.ranking === 'failed') return { text: ['Marketplace Recommendations', ...snapshot.startupIssues.map((issue) => `  ${issue}`)].join('\n'), data: { recommendations: [] } };
    const notice = snapshot.ranking === 'off' ? snapshot.startupIssues.map((issue) => `  ${issue}`) : [];
    const recommendations = snapshot.recommendations;
    return {
      text: recommendations.length > 0
        ? ['Marketplace Recommendations', ...notice, ...recommendations.map((recommendation) => `  ${recommendation.kind} ${recommendation.entry.id}  ${recommendation.title}: ${recommendation.reason}`)].join('\n')
        : ['Marketplace Recommendations', ...notice, '  No contextual recommendations right now.'].join('\n'),
      data: { recommendations: recommendations.map((recommendation) => ({ kind: recommendation.kind, id: recommendation.entry.id, title: recommendation.title, reason: recommendation.reason })) },
    };
  },
};

export const MARKETPLACE_CAPABILITIES: readonly CapabilityDefinition<MarketplaceCapabilityServices>[] = [
  MARKETPLACE_OVERVIEW, MARKETPLACE_BROWSE, MARKETPLACE_INSTALLED, MARKETPLACE_REVIEW, MARKETPLACE_PROVENANCE, MARKETPLACE_INSTALL_HINT,
  MARKETPLACE_INSTALL, MARKETPLACE_UPDATE, MARKETPLACE_HISTORY, MARKETPLACE_ROLLBACK, MARKETPLACE_RECEIPT, MARKETPLACE_UNINSTALL,
  MARKETPLACE_BUNDLE_EXPORT, MARKETPLACE_BUNDLE_INSPECT, MARKETPLACE_BUNDLE_IMPORT, MARKETPLACE_BACKUPS,
];
