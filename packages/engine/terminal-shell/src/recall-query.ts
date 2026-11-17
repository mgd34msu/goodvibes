import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryRecord, MemorySearchFilter, MemoryLink } from '@goodvibes-jev/engine/platform/platform/state';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope, readRecallFlags, temporalStatusLabel, type RecallFlagKind } from './recall-shared.js';
export interface RecallQueryContext {
  readonly print: (message: string) => void;
  /** True when a model, not the owner at the keyboard, is running the command. */
  readonly invokedByModel?: boolean | undefined;
}
const RECALL_LIST_LIMIT = 50;
const SEARCH_FLAGS: Readonly<Record<string, RecallFlagKind>> = {
  '--cls': 'word',
  '--scope': 'word',
  '--limit': 'word',
  '--semantic': 'switch',
  '--vector': 'switch',
};
const LIST_FLAGS: Readonly<Record<string, RecallFlagKind>> = { '--scope': 'word' };
type Awaitable<T> = T | Promise<T>;
export interface RecallQueryPort {
  list(filter: MemorySearchFilter): Promise<readonly MemoryRecord[]>;
  searchSemantic: MemoryApi['searchSemantic'];
  get(id: string): Awaitable<MemoryRecord | null>;
  linksFor(id: string): Awaitable<readonly MemoryLink[]>;
  link: MemoryApi['link'];
  delete(id: string): Awaitable<boolean>;
}
/** Preserve synchronous local commands while awaiting daemon-owned wire operations. */
export function afterMemory<T>(value: Awaitable<T>, consume: (value: T) => void | Promise<void>): void | Promise<void> {
  if (value instanceof Promise) return value.then(consume);
  return consume(value);
}
export function createRecallQueryCommands<Context extends RecallQueryContext>(
  getMemory: (context: Context) => RecallQueryPort | null,
  getLocalMemory: (context: Context) => MemoryApi | null,
  presentation: {
    readonly tag: string;
    readonly command: string;
    readonly listSuffix: string;
    readonly temporal: boolean;
    readonly originLabel: string;
    readonly provenance: (refs: MemoryRecord['provenance']) => string;
    readonly provenanceEntry: (ref: MemoryRecord['provenance'][number]) => string;
    readonly label: (label: 'scope' | 'class' | 'summary' | 'detail' | 'tags' | 'created' | 'origin' | 'links') => string;
    readonly printLinked: (context: Context, fromId: string, toId: string, relation: string) => void;
    readonly printDeleted: (context: Context, id: string) => void;
    readonly linkFailure: string;
  },
) {
  async function handleRecallSearch(args: string[], context: Context): Promise<void> {
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const usage = `${presentation.tag} Usage: /${presentation.command} search <query...> [--cls <class>] [--scope <scope>] [--limit <n>] [--semantic]`;
    const flags = readRecallFlags(args, SEARCH_FLAGS);
    if ('refusal' in flags) {
      context.print(`${presentation.tag} ${flags.refusal}\n${usage}`);
      return;
    }
    const semantic = flags.values.has('--semantic') || flags.values.has('--vector');
    const filter: MemorySearchFilter = {};
    const cls = flags.values.get('--cls');
    if (cls !== undefined) {
      if (isValidClass(cls)) filter.cls = cls;
      else {
        context.print(
          `${presentation.tag} Unknown class "${cls}". Valid: ${VALID_CLASSES.join(', ')}.`,
        );
        return;
      }
    }
    const scope = flags.values.get('--scope');
    if (scope !== undefined) {
      if (isValidScope(scope)) filter.scope = scope;
      else {
        context.print(
          `${presentation.tag} Unknown scope "${scope}". Valid: ${VALID_SCOPES.join(', ')}.`,
        );
        return;
      }
    }
    const limit = flags.values.get('--limit');
    if (limit !== undefined) {
      if (!/^[1-9]\d*$/.test(limit)) {
        context.print(`${presentation.tag} Invalid --limit "${limit}". Use a positive whole number.`);
        return;
      }
      filter.limit = Number(limit);
    }
    const queryTokens = flags.positional;
    if (queryTokens.length) filter.query = queryTokens.join(' ');
    if (semantic) filter.semantic = true;
    const semanticResults = semantic ? await memory.searchSemantic(filter) : [];
    const results = semantic ? semanticResults.map((entry) => entry.record) : await memory.list(filter);
    if (!results.length) {
      context.print(`${presentation.tag} No records found.`);
      return;
    }
    context.print(`${presentation.tag} ${results.length} ${semantic ? 'semantic ' : ''}record(s)${presentation.listSuffix}`);
    for (const record of results) {
      const semanticEntry = semanticResults.find((entry) => entry.record.id === record.id);
      const ts = new Date(record.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      const tagStr = record.tags.length ? ` [${record.tags.join(', ')}]` : '';
      const scoreStr = semanticEntry ? `  sim ${Math.round(semanticEntry.similarity * 100)}%` : '';
      context.print(
        `  ${record.id}  [${record.cls}]${tagStr}  ${ts}${scoreStr}${presentation.temporal ? temporalStatusLabel(record) : ''}`,
      );
      context.print(`    ${record.summary}`);
      if (record.provenance.length) {
        context.print(`    ${presentation.originLabel} ${presentation.provenance(record.provenance)}`);
      }
    }
  }
  function handleRecallVector(args: string[], context: Context): void {
    const memory = getLocalMemory(context);
    if (!memory) {
      return;
    }
    const sub = (args[0] ?? 'status').toLowerCase();
    if (sub === 'rebuild') {
      const stats = memory.rebuildVectors();
      context.print(formatVectorStats(stats, 'rebuild complete'));
      return;
    }
    if (sub === 'status' || sub === 'doctor') {
      context.print(formatVectorStats(memory.vectorStats(), sub));
      return;
    }
    context.print(`${presentation.tag} Usage: /${presentation.command} vector [status|doctor|rebuild]`);
  }
  function formatVectorStats(stats: ReturnType<MemoryApi['vectorStats']>, label: string): string {
    return [
      `${presentation.tag} Vector index ${label}`,
      `  backend: ${stats.backend}`,
      `  enabled: ${stats.enabled ? 'yes' : 'no'}`,
      `  available: ${stats.available ? 'yes' : 'no'}`,
      `  dimensions: ${stats.dimensions}`,
      `  indexed records: ${stats.indexedRecords}`,
      ...(stats.path ? [`  path: ${stats.path}`] : []),
      ...(stats.error ? [`  error: ${stats.error}`] : []),
    ].join('\n');
  }
  async function handleRecallList(args: string[], context: Context): Promise<void> {
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const flags = readRecallFlags(args, LIST_FLAGS);
    if ('refusal' in flags) {
      context.print(`${presentation.tag} ${flags.refusal}\n${presentation.tag} Usage: /${presentation.command} list [class] [--scope <scope>]`);
      return;
    }
    const [cls, ...extra] = flags.positional;
    if (extra.length > 0) {
      context.print(`${presentation.tag} list takes one class, not "${flags.positional.join(' ')}". Use search to find records by words.`);
      return;
    }
    const filter: MemorySearchFilter = { limit: RECALL_LIST_LIMIT };
    if (cls) {
      if (!isValidClass(cls)) {
        context.print(
          `${presentation.tag} Unknown class "${cls}". Valid: ${VALID_CLASSES.join(', ')}.`,
        );
        return;
      }
      filter.cls = cls;
    }
    const scope = flags.values.get('--scope');
    if (scope !== undefined) {
      if (!isValidScope(scope)) {
        context.print(
          `${presentation.tag} Unknown scope "${scope}". Valid: ${VALID_SCOPES.join(', ')}.`,
        );
        return;
      }
      filter.scope = scope;
    }
    const records = await memory.list(filter);
    if (!records.length) {
      context.print(`${presentation.tag} No records.`);
      return;
    }
    if (records.length >= RECALL_LIST_LIMIT) {
      context.print(
        `${presentation.tag} Showing ${records.length} records; there may be more. The per-class counts below cover only these. Narrow with a class or --scope, or use search.`,
      );
    }
    const grouped: Record<string, Array<(typeof records)[number]>> = {};
    for (const record of records) {
      (grouped[record.cls] ??= []).push(record);
    }
    for (const [clsName, group] of Object.entries(grouped)) {
      context.print(`\n${presentation.tag} ${clsName.toUpperCase()} (${group.length})${presentation.listSuffix}`);
      for (const record of group) {
        const tagStr = record.tags.length ? ` [${record.tags.join(', ')}]` : '';
        context.print(
          `  ${record.id} [${record.scope}]${tagStr}  ${record.summary}${presentation.temporal ? temporalStatusLabel(record) : ''}`,
        );
      }
    }
  }
  function handleRecallGet(args: string[], context: Context): void | Promise<void> {
    const memory = getMemory(context);
    if (!memory) return;
    const id = args[0];
    if (!id) {
      context.print(`${presentation.tag} Usage: /${presentation.command} get <id>`);
      return;
    }
    return afterMemory(memory.get(id), (record) => {
      if (!record) {
        context.print(`${presentation.tag} Record not found: ${id}`);
        return;
      }
      const ts = new Date(record.createdAt).toISOString().slice(0, 19).replace('T', ' ');
      context.print(`${presentation.tag} ${record.id}`);
      context.print(`  ${presentation.label('scope')}${record.scope}`);
      context.print(`  ${presentation.label('class')}${record.cls}`);
      context.print(`  ${presentation.label('summary')}${record.summary}`);
      if (record.detail) context.print(`  ${presentation.label('detail')}${record.detail}`);
      if (record.tags.length) context.print(`  ${presentation.label('tags')}${record.tags.join(', ')}`);
      context.print(`  ${presentation.label('created')}${ts}`);
      if (presentation.temporal && (record.validFrom !== undefined || record.validUntil !== undefined)) {
        const date = (value: number | undefined) =>
          value !== undefined ? new Date(value).toISOString().slice(0, 19).replace('T', ' ') : '(none)';
        context.print(`  Temporal: ${date(record.validFrom)} -> ${date(record.validUntil)}${temporalStatusLabel(record)}`);
      }
      if (record.provenance.length) {
        context.print(`  ${presentation.label('origin')}`);
        for (const ref of record.provenance) context.print(`    ${presentation.provenanceEntry(ref)}`);
      }
      return afterMemory(memory.linksFor(id), (links) => {
        if (links.length) {
          context.print(`  ${presentation.label('links')}`);
          for (const link of links) {
            const dir = link.fromId === id ? '->' : '<-';
            const other = link.fromId === id ? link.toId : link.fromId;
            context.print(`    ${dir} ${other}  [${link.relation}]`);
          }
        }
      });
    });
  }
  function mutationArgs(args: string[]) {
    return mutationArguments(args);
  }
  async function handleRecallLink(args: string[], context: Context): Promise<void> {
    const memory = getMemory(context);
    if (!memory) return;
    const parsed = mutationArgs(args);
    const [fromId, toId, relation] = parsed.rest;
    const usage = `/${presentation.command} link <fromId> <toId> <relation>`;
    if (!fromId || !toId || !relation) {
      context.print(`${presentation.tag} Usage: ${usage}`);
      return;
    }
    const link = await memory.link(fromId, toId, relation);
    if (!link) {
      context.print(presentation.linkFailure);
      return;
    }
    presentation.printLinked(context, fromId, toId, relation);
  }
  function handleRecallRemove(args: string[], context: Context): void | Promise<void> {
    const memory = getMemory(context);
    if (!memory) return;
    const parsed = mutationArgs(args);
    const id = parsed.rest[0];
    const usage = `/${presentation.command} remove <id>`;
    if (!id) {
      context.print(`${presentation.tag} Usage: ${usage}`);
      return;
    }
    return afterMemory(memory.delete(id), (removed) => {
      if (!removed) {
        context.print(`${presentation.tag} Record not found: ${id}`);
        return;
      }
      presentation.printDeleted(context, id);
    });
  }
  return { handleRecallSearch, handleRecallVector, handleRecallGet, handleRecallLink, handleRecallRemove, handleRecallList };
}

/**
 * A mutation's arguments: the line runs as typed (the registry asks first for
 * a line that cannot be undone), and a `--yes` typed out of habit is dropped.
 */
export function mutationArguments(args: string[]): { rest: string[]; yes: boolean } {
  return { rest: args.filter((a) => a !== '--yes'), yes: true };
}
