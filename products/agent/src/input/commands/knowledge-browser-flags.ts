import type { BrowserKnowledgeKind, BrowserKnowledgeSourceKind } from '@goodvibes-jev/engine/platform/platform/knowledge';

const BROWSER_KINDS = ['chrome', 'chromium', 'brave', 'edge', 'vivaldi', 'arc', 'opera', 'firefox', 'zen', 'librewolf', 'waterfox', 'floorp', 'safari', 'orion', 'epiphany'] as const satisfies readonly BrowserKnowledgeKind[];
const BROWSER_SOURCE_KINDS = ['history', 'bookmark'] as const satisfies readonly BrowserKnowledgeSourceKind[];
const DEFAULT_IMPORT_LIMIT = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BrowserImportScope {
  readonly browsers: readonly BrowserKnowledgeKind[];
  readonly sourceKinds: readonly BrowserKnowledgeSourceKind[];
  readonly limit: number;
  readonly sinceMs: number | undefined;
}

export type BrowserImportScopeResult =
  | { readonly ok: true; readonly scope: BrowserImportScope }
  | { readonly ok: false; readonly message: string };

function flagValue(args: readonly string[], names: readonly string[]): { readonly present: boolean; readonly value: string | undefined } {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) return { present: true, value: args[index + 1] };
  }
  return { present: false, value: undefined };
}

function listOf(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function readNames<Name extends string>(
  args: readonly string[],
  flags: readonly string[],
  valid: readonly Name[],
  label: string,
): { readonly ok: true; readonly names: readonly Name[] } | { readonly ok: false; readonly message: string } {
  const { present, value } = flagValue(args, flags);
  if (!present) return { ok: true, names: [] };
  const requested = listOf(value);
  const rejected = requested.filter((name) => !valid.includes(name as Name));
  if (requested.length === 0 || rejected.length > 0) {
    const shown = rejected.length > 0 ? `Unknown ${label} ${rejected.join(', ')}.` : `${flags[0]} needs a value.`;
    return { ok: false, message: `${shown} Valid ${label}s: ${valid.join(', ')}. Nothing was imported.` };
  }
  return { ok: true, names: requested as Name[] };
}

function readCount(args: readonly string[], name: string): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly message: string } {
  const { present, value } = flagValue(args, [name]);
  if (!present) return { ok: true, value: undefined };
  if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) {
    return { ok: false, message: `${name} needs a whole number above zero, got ${value === undefined ? 'nothing' : `'${value}'`}. Nothing was imported.` };
  }
  return { ok: true, value: Number(value) };
}

/**
 * The scope of a browser history import, or why it was refused.
 *
 * An empty browser list means "every installed browser" to the importer, so a
 * flag that was typed but resolved to nothing must be refused here rather than
 * widened: the person asked for a narrower import than all of them.
 */
export function parseBrowserImportScope(args: readonly string[], now: number): BrowserImportScopeResult {
  const browsers = readNames(args, ['--browsers', '--browser'], BROWSER_KINDS, 'browser');
  if (!browsers.ok) return browsers;
  const sources = readNames(args, ['--sources', '--source-kinds', '--source-kind'], BROWSER_SOURCE_KINDS, 'source kind');
  if (!sources.ok) return sources;
  const limit = readCount(args, '--limit');
  if (!limit.ok) return limit;
  const days = readCount(args, '--since-days');
  if (!days.ok) return days;
  return {
    ok: true,
    scope: {
      browsers: browsers.names,
      sourceKinds: sources.names,
      limit: limit.value ?? DEFAULT_IMPORT_LIMIT,
      sinceMs: days.value === undefined ? undefined : now - days.value * DAY_MS,
    },
  };
}
