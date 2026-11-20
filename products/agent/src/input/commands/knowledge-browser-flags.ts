import type { BrowserKnowledgeKind, BrowserKnowledgeSourceKind } from '@goodvibes/engine/platform/platform/knowledge';
import { splitCommandOption } from '@goodvibes/engine/terminal-shell/cli-arguments';
import type { Selection } from '@goodvibes/engine/errors';

const BROWSER_KINDS = ['chrome', 'chromium', 'brave', 'edge', 'vivaldi', 'arc', 'opera', 'firefox', 'zen', 'librewolf', 'waterfox', 'floorp', 'safari', 'orion', 'epiphany'] as const satisfies readonly BrowserKnowledgeKind[];
const BROWSER_SOURCE_KINDS = ['history', 'bookmark'] as const satisfies readonly BrowserKnowledgeSourceKind[];
const DEFAULT_IMPORT_LIMIT = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BrowserImportScope {
  /** `default` when the flag was not typed (every installed browser); never an empty selection. */
  readonly browsers: Selection<BrowserKnowledgeKind>;
  /** `default` when the flag was not typed (history and bookmarks). */
  readonly sourceKinds: Selection<BrowserKnowledgeSourceKind>;
  readonly limit: number;
  readonly sinceMs: number | undefined;
}

export type BrowserImportScopeResult =
  | { readonly ok: true; readonly scope: BrowserImportScope }
  | { readonly ok: false; readonly message: string };

/**
 * Both `--flag value` and `--flag=value` reach the same validation; a flag
 * typed with no value (`--flag=`, or followed by another flag or nothing) is
 * present with no value, so it is refused rather than ignored.
 */
function flagValue(args: readonly string[], names: readonly string[]): { readonly present: boolean; readonly value: string | undefined } {
  for (let index = 0; index < args.length; index += 1) {
    const { name, value: inline } = splitCommandOption(args[index]!);
    if (!names.includes(name)) continue;
    if (inline !== undefined) return { present: true, value: inline.length > 0 ? inline : undefined };
    const next = args[index + 1];
    return { present: true, value: next === undefined || next.startsWith('--') ? undefined : next };
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
): { readonly ok: true; readonly names: Selection<Name> } | { readonly ok: false; readonly message: string } {
  const { present, value } = flagValue(args, flags);
  if (!present) return { ok: true, names: { kind: 'default' } };
  const requested = listOf(value);
  const rejected = requested.filter((name) => !valid.includes(name as Name));
  const [first, ...rest] = requested as Name[];
  if (first === undefined || rejected.length > 0) {
    const shown = rejected.length > 0 ? `Unknown ${label} ${rejected.join(', ')}.` : `${flags[0]} needs a value.`;
    return { ok: false, message: `${shown} Valid ${label}s: ${valid.join(', ')}. Nothing was imported.` };
  }
  return { ok: true, names: { kind: 'only', values: [first, ...rest] } };
}

/** A selection as the browser-history route takes it: omitted for the default, else exactly its values. */
export function selectionWireValue<Name extends string>(selection: Selection<Name>): readonly Name[] | undefined {
  return selection.kind === 'only' ? selection.values : undefined;
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
 * A flag not typed is the importer's default (every installed browser; history
 * and bookmarks); a flag that was typed but resolved to nothing is refused here
 * rather than widened: the person asked for a narrower import than all of them.
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
