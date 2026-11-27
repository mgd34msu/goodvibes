/**
 * The marketplace: the local curated catalog of plugins, skills, hook packs
 * and policy packs, and what is installed from it. Every act is managing what
 * is kept on this machine (the catalog under `.goodvibes/tui/ecosystem`, the
 * installs under `.goodvibes/` of the project or of the user), so each runs in
 * the daemon, for the caller's project; what is installed is loaded by each
 * program that runs turns, as before.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { projectIdentityOf } from '../../workspace/project-identity.js';
import { callerPathOf, readCallerJson } from '../path-inputs.js';
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
/** The file a path input names, placed by capabilities/path-inputs.ts `callerPathOf` (inside the caller's checked project). */
const fileIn = (_cwd: string, path: string, caller: CapabilityCaller): string => callerPathOf(caller, path);
/**
 * What is installed changed: an install for this project names it (only its screens read again); one for all the
 * user's projects is a shared thing (every screen reads again).
 */
const changed = (values: ActionValues, caller: CapabilityCaller): void => noteListChanged({
  list: 'tools', change: 'changed',
  ...(values.scope !== 'user' && caller.workingDirectory ? { project: projectIdentityOf(resolve(caller.workingDirectory)) } : {}),
});

/** A marketplace bundle; never the system's or the parser's words (capabilities/path-inputs.ts). */
function readBundle(path: string, caller: CapabilityCaller): EcosystemCatalogBundle {
  return readCallerJson(path, 'a marketplace bundle', caller) as EcosystemCatalogBundle;
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
      text: ['The marketplace at a glance (in the catalog, installed):', ...counts.map((count) => { const label = `${KIND_LABEL.get(count.kind)}s`; return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${count.curated} in the catalog, ${count.installed} installed`; })].join('\n'),
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
    const total = found.reduce((sum, group) => sum + group.entries.length, 0);
    const lines = [query ? `${total} curated entr${total === 1 ? 'y matches' : 'ies match'} "${query}":` : `The catalog holds ${total} curated entr${total === 1 ? 'y' : 'ies'}:`];
    for (const group of found) {
      lines.push(...group.entries.map((entry) => `${entry.name} (${KIND_LABEL.get(group.kind)}): ${entry.summary}`));
      const unchecked = describeUncheckedCatalogEntries(group);
      if (unchecked) lines.push(unchecked);
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
      // One fact a line, in words.
      text: [`${entry.name} (${values.kind}, catalog id ${entry.id})`,
        `Comes from: ${entry.source} (${review.sourceKind === 'local-path' ? 'a folder on this machine' : review.sourceKind === 'remote' ? 'another machine' : 'a place not said'}${review.sourceExists ? '' : ', which is not there now'})`,
        `Best installed for: ${review.recommendedScope === 'user' ? 'all your projects' : 'this project'}`,
        `Risk: ${review.riskLevel}`,
        `Works with this version: ${review.compatibility.status === 'supported' ? 'yes' : review.compatibility.status}${review.compatibility.reasons.length > 0 ? ` (${notes})` : ''}`].join('\n'),
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
      text: [`Where ${entry.name} comes from`, `From: ${entry.source}`, `Provenance: ${entry.provenance ?? 'none declared'}`, `Version: ${entry.version ?? 'not said'}`,
        `Author: ${entry.author ?? 'not said'}`, `Signature: ${entry.signature ?? 'none declared'}`,
        `Works with this version: ${review.compatibility.reasons.length === 0 ? 'yes' : review.compatibility.reasons.join('; ')}`, `Trust notes: ${entry.trustNotes ?? 'none'}`].join('\n'),
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
    return { text: [`How ${entry.name} (${values.kind}) installs`, `From: ${entry.source}`, `How: ${hint}`, `Trust notes: ${entry.trustNotes ?? 'none'}`].join('\n'), data: { id: entry.id, hint, trustNotes: entry.trustNotes ?? null } };
  },
});

export const MARKETPLACE_HISTORY = read({
  actionId: 'history', label: 'See an entry\'s backups', word: 'history', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
  sentence: 'Lists the backups the {kind} {entry} can be rolled back to.', example: EXAMPLE,
  async run(values, services, caller) {
    const backups = listEcosystemInstallBackups(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    return {
      text: backups.length > 0
        ? [`The ${values.kind} ${values.entry} has ${backups.length} backup${backups.length === 1 ? '' : 's'} to roll back to, newest first:`, ...backups.map((backup) => `${new Date(backup.createdAt).toLocaleString()}: version ${backup.receipt.entry.version ?? 'not said'}, kept before ${backup.reason === 'update' ? 'an update' : backup.reason === 'rollback' ? 'a roll back' : backup.reason}`)].join('\n')
        : `The ${values.kind} ${values.entry} has no backups to roll back to.`,
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
      text: [`${receipt.entry.name}'s install receipt`, `Installed: ${new Date(receipt.installedAt).toLocaleString()}, for ${receipt.scope === 'user' ? 'all your projects' : 'this project'}`, `Kept in: ${receipt.targetPath}`,
        `From: ${receipt.provenanceSummary}`, `Works with this version: ${receipt.compatibility.status === 'supported' ? 'yes' : receipt.compatibility.status}`, ...receipt.compatibility.reasons.map((reason) => `Note: ${reason}`)].join('\n'),
      data: { id: receipt.entry.id, at: receipt.installedAt, scope: receipt.scope, path: receipt.targetPath },
    };
  },
});

export const MARKETPLACE_BUNDLE_INSPECT = read({
  actionId: 'bundle-inspect', label: 'Look inside a marketplace bundle', word: 'bundle-inspect', inputs: [BUNDLE_FILE],
  sentence: 'Shows what {path} holds; nothing is installed.', example: { path: 'marketplace.json' },
  async run(values, services, caller) {
    const summary = inspectEcosystemCatalogBundle(readBundle(fileIn(project(services, caller).cwd, values.path!, caller), caller));
    // Date rejects values outside +-8.64e15 ms, so a bundle's number can pass isFinite and still not be a date.
    const exportedDate = typeof summary.exportedAt === 'number' ? new Date(summary.exportedAt) : undefined;
    const exportedAt = exportedDate !== undefined && !Number.isNaN(exportedDate.getTime()) ? exportedDate.toISOString() : 'unknown';
    return {
      text: [`${values.path} holds the curated catalog ${summary.scope === 'user' ? 'for all your projects' : 'of a project'}, saved ${exportedAt === 'unknown' ? 'at a time not said' : new Date(exportedAt).toLocaleString()}:`,
        `Plugins: ${summary.counts.plugin}`, `Skills: ${summary.counts.skill}`, `Hook packs: ${summary.counts['hook-pack']}`, `Policy packs: ${summary.counts['policy-pack']}`, 'Nothing was installed.'].join('\n'),
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
  // Installing a plugin, a skill pack or a hook pack puts code where the programs load it by themselves: it loosens a protection.
  sentence: 'The {kind} {entry} is installed, for this project or all your projects as "Install for" says, until you change it.', risk: 'loosens-a-protection', undoneBy: 'uninstall',
  async run(values, services, caller) {
    const result = installEcosystemCatalogEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    if (!result.ok) notDone(result.error);
    changed(values, caller);
    return { text: `Installed curated ${values.kind} ${values.entry} into ${result.receipt.targetPath}`, data: { kind: values.kind, id: values.entry, path: result.receipt.targetPath } };
  },
});

export const MARKETPLACE_UPDATE = change({
  actionId: 'update', label: 'Update an installed entry', word: 'update', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
  // New code where the programs load it by themselves: it loosens a protection, as installing does.
  sentence: 'The installed {kind} {entry} is updated to the catalog\'s version until you change it; the old one is kept as a backup.', risk: 'loosens-a-protection', undoneBy: 'rollback',
  async run(values, services, caller) {
    const result = updateInstalledEcosystemEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    if (!result.ok) notDone(result.error);
    changed(values, caller);
    return { text: `Updated curated ${values.kind} ${values.entry} in ${result.receipt.targetPath}`, data: { kind: values.kind, id: values.entry, path: result.receipt.targetPath } };
  },
});

export const MARKETPLACE_ROLLBACK = change({
  actionId: 'rollback', label: 'Roll an entry back to a backup', word: 'rollback',
  inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE, {
    id: 'backup', label: 'Backup', help: 'Its backups, newest first', kind: 'choice', choices: { list: MARKETPLACE_BACKUPS_LIST, dependsOn: 'entry' },
    required: { default: '', defaultMeans: 'the newest one' }, typed: { flag: '--backup' },
  }],
  sentence: 'The installed {kind} {entry} goes back to an earlier backup until you change it.', risk: 'none', undoneBy: 'update',
  async run(values, services, caller) {
    const result = rollbackInstalledEcosystemEntry(values.kind as EcosystemEntryKind, values.entry!, { ...scoped(project(services, caller).catalog, values), ...(values.backup ? { backupId: values.backup } : {}) });
    if (!result.ok) notDone(result.error);
    changed(values, caller);
    return { text: `Rolled back curated ${values.kind} ${values.entry} in ${result.receipt.targetPath} using backup ${result.restoredFrom.id}`, data: { kind: values.kind, id: values.entry, backup: result.restoredFrom.id } };
  },
});

export const MARKETPLACE_UNINSTALL = change({
  actionId: 'uninstall', label: 'Uninstall an entry', word: 'uninstall', inputs: [KIND, INSTALLED_ENTRY, INSTALL_SCOPE],
  sentence: 'The installed {kind} {entry} is removed from disk with its install receipt; installing it again brings it back from the catalog.', risk: 'cannot-be-undone',
  async run(values, services, caller) {
    const result = uninstallEcosystemCatalogEntry(values.kind as EcosystemEntryKind, values.entry!, scoped(project(services, caller).catalog, values));
    if (!result.ok) notDone(result.error);
    changed(values, caller);
    return { text: `Uninstalled curated ${values.kind} ${values.entry} from ${result.removedPath}`, data: { kind: values.kind, id: values.entry, path: result.removedPath } };
  },
});

export const MARKETPLACE_BUNDLE_EXPORT: CapabilityDefinition<MarketplaceCapabilityServices> = {
  capability: { id: 'marketplace.bundle-export', group: 'tools', home: 'daemon', repeat: 'safe' },
  // The bundle is the local curated catalog (its entries), not the installs: the words say so.
  actionId: 'bundle-export', label: 'Save the catalog to a bundle', word: 'bundle-export', inputs: [{ ...BUNDLE_FILE, file: 'written', help: 'Where to write the bundle' }, { ...INSTALL_SCOPE, label: 'Catalog of', help: 'This project\'s catalog, or the one for all your projects' }],
  sentence: 'The local curated catalog (this project\'s, or the one for all your projects, as "Catalog of" says) is written to {path} as a bundle another machine can bring in; nothing installed is in it.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { path: 'marketplace.json' },
  async run(values, services, caller) {
    const { catalog, cwd } = project(services, caller);
    const bundle = exportEcosystemCatalogBundle(values.scope === 'user' ? 'user' : 'project', catalog);
    const target = fileIn(cwd, values.path!, caller);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
    const entries = bundle.entries.length;
    return { text: `Saved the ${values.scope === 'user' ? 'catalog for all your projects' : 'project\'s catalog'} (${entries} entr${entries === 1 ? 'y' : 'ies'}) to ${target}`, data: { path: target, entries } };
  },
};

export const MARKETPLACE_BUNDLE_IMPORT: CapabilityDefinition<MarketplaceCapabilityServices> = {
  capability: { id: 'marketplace.bundle-import', group: 'tools', home: 'daemon', repeat: 'safe' },
  actionId: 'bundle-import', label: 'Bring a catalog bundle in', word: 'bundle-import', inputs: [BUNDLE_FILE, { ...INSTALL_SCOPE, label: 'Into the catalog of', help: 'This project\'s catalog, or the one for all your projects' }],
  sentence: 'The curated entries in {path} are merged into the local catalog (this project\'s, or the one for all your projects), by kind and id, until you change it; nothing is installed.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'marketplace.json' },
  async run(values, services, caller) {
    const { catalog, cwd } = project(services, caller);
    const source = fileIn(cwd, values.path!, caller);
    const result = importEcosystemCatalogBundle(readBundle(source, caller), { ...catalog, scope: values.scope === 'user' ? 'user' : 'project' });
    if (result.error) throw new CapabilityRefusal(`Marketplace bundle import failed: ${result.error}`, undefined, 'BUNDLE_IMPORT_FAILED');
    changed(values, caller);
    return {
      text: [`Brought ${result.imported} curated entr${result.imported === 1 ? 'y' : 'ies'} in from ${source}, merged into the catalog by kind and id${result.rejected.length > 0 ? `; ${result.rejected.length} refused` : ''}.`,
        ...Object.entries(result.pathByKind).map(([kind, path]) => `The ${KIND_LABEL.get(kind as EcosystemEntryKind) ?? kind}s went into ${path}.`), ...result.rejected.map((entry) => `Refused ${entry.id}: ${entry.reason}`)].join('\n'),
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
    // Only what bears on the recommendations is said: the read model's other start-up issues (a tool server's state) are not theirs.
    const bearing = snapshot.startupIssues.filter((issue) => /recommend|decision model|catalog|rank/i.test(issue));
    if (snapshot.ranking === 'failed') return { text: ['What fits this project could not be read.', ...bearing].join('\n'), data: { recommendations: [] } };
    const notice = snapshot.ranking === 'off' ? bearing : [];
    const recommendations = snapshot.recommendations;
    return {
      text: recommendations.length > 0
        ? [`${recommendations.length} curated entr${recommendations.length === 1 ? 'y fits' : 'ies fit'} this project:`, ...recommendations.map((recommendation) => `${recommendation.entry.name || recommendation.entry.id} (${recommendation.kind}): ${recommendation.title}. ${recommendation.reason}`), ...notice].join('\n')
        : ['Nothing in the catalog fits this project right now.', ...notice].join('\n'),
      data: { recommendations: recommendations.map((recommendation) => ({ kind: recommendation.kind, id: recommendation.entry.id, title: recommendation.title, reason: recommendation.reason })) },
    };
  },
};

export const MARKETPLACE_CAPABILITIES: readonly CapabilityDefinition<MarketplaceCapabilityServices>[] = [
  MARKETPLACE_OVERVIEW, MARKETPLACE_BROWSE, MARKETPLACE_INSTALLED, MARKETPLACE_REVIEW, MARKETPLACE_PROVENANCE, MARKETPLACE_INSTALL_HINT,
  MARKETPLACE_INSTALL, MARKETPLACE_UPDATE, MARKETPLACE_HISTORY, MARKETPLACE_ROLLBACK, MARKETPLACE_RECEIPT, MARKETPLACE_UNINSTALL,
  MARKETPLACE_BUNDLE_EXPORT, MARKETPLACE_BUNDLE_INSPECT, MARKETPLACE_BUNDLE_IMPORT, MARKETPLACE_BACKUPS,
];
