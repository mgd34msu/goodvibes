import type { TranscriptEventKind } from '@goodvibes-jev/engine/platform/platform/core';
import {
  captureTranscriptSource,
  readTranscriptIndexReading,
  type TranscriptCommandContext,
} from './transcript-reading.js';

/** Rows on one page of `/session events` and `/session groups` when `--last` is not given. */
export const TRANSCRIPT_EVENTS_PAGE = 16;
export const TRANSCRIPT_GROUPS_PAGE = 12;

/**
 * Which slice of the list to show. `start` is the 1-based number of the first row;
 * without it the page ends at the newest row, the part of a long session usually wanted.
 */
export interface TranscriptReviewPage {
  readonly start?: number | undefined;
  readonly size?: number | undefined;
}

export interface TranscriptReviewArguments {
  readonly kindWord: string | undefined;
  readonly page: TranscriptReviewPage;
}

/**
 * Reads `[kind] [start] [--last N]` in any order. A bare number is the start row;
 * any other word is the kind. Returns a refusal line for a malformed number or extra words.
 */
export function readTranscriptReviewArguments(words: readonly string[]): TranscriptReviewArguments | { readonly refusal: string } {
  let kindWord: string | undefined;
  let start: number | undefined;
  let size: number | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--last' || word.startsWith('--last=')) {
      const raw = word === '--last' ? words[++i] : word.slice('--last='.length);
      const value = readPositiveInteger(raw);
      if (value === undefined) return { refusal: `Not shown: --last needs a whole number above 0 (got "${raw ?? ''}"). Example: --last 50.` };
      size = value;
      continue;
    }
    if (/^\d+$/.test(word)) {
      const value = readPositiveInteger(word);
      if (value === undefined || start !== undefined) return { refusal: `Not shown: "${word}" is not a usable start row. Give one row number from 1.` };
      start = value;
      continue;
    }
    if (kindWord !== undefined) return { refusal: `Not shown: "${word}" is an extra word. Usage: [kind] [start-row] [--last N].` };
    kindWord = word;
  }
  return { kindWord, page: { start, size } };
}

function readPositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 1-based inclusive row range of the page; `last < first` for an empty list. */
function pageRange(total: number, page: TranscriptReviewPage, size: number): { readonly first: number; readonly last: number } | { readonly beyond: true } {
  if (page.start !== undefined && page.start > Math.max(total, 1)) return { beyond: true };
  const first = page.start ?? Math.max(1, total - size + 1);
  return { first, last: Math.min(total, first + size - 1) };
}

export function createTranscriptReviewFormatter(separator: string, detailSeparator: string) {
  async function buildTranscriptReviewLines(
    ctx: TranscriptCommandContext,
    kind: TranscriptEventKind | 'all',
    mode: 'events' | 'groups' | 'hotspots',
    source: ReturnType<typeof captureTranscriptSource>,
    page: TranscriptReviewPage = {},
  ): Promise<string[]> {
    const reading = await readTranscriptIndexReading(ctx, source);
    if (reading.index === null) return [reading.failure];
    const index = reading.index;
    const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
    const groups = kind === 'all' ? index.groups : index.groups.filter((group) => group.kind === kind);
    const kindTitle = kind === 'all' ? '' : `${separator}${kind}`;

    if (mode === 'hotspots') {
      const kindCounts = new Map<TranscriptEventKind, number>();
      for (const event of events) {
        kindCounts.set(event.kind, (kindCounts.get(event.kind) ?? 0) + 1);
      }
      const busiestGroups = [...groups]
        .sort((a, b) => b.events.length - a.events.length || a.messageIndexes[0]! - b.messageIndexes[0]!)
        .slice(0, 8);
      return [
        `Transcript Hotspots${kindTitle}`,
        ...(kindCounts.size === 0
          ? ['  no events']
          : [...kindCounts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([eventKind, count]) => `  ${eventKind.padEnd(20)} ${count}`)),
        '',
        'Busiest groups',
        ...(busiestGroups.length === 0
          ? ['  no groups']
          : busiestGroups.map((group) => `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)}  ${group.title}`)),
      ];
    }

    const noun = mode === 'groups' ? 'groups' : 'events';
    const total = mode === 'groups' ? groups.length : events.length;
    const size = page.size ?? (mode === 'groups' ? TRANSCRIPT_GROUPS_PAGE : TRANSCRIPT_EVENTS_PAGE);
    const slice = pageRange(total, page, size);
    const command = `/session ${noun} ${kind}`;
    if ('beyond' in slice) {
      return [`Not shown: the list has ${total} ${noun}, so it has no row ${page.start}. Run ${command} for the newest ${noun}.`];
    }
    const sizeFlag = page.size !== undefined ? ` --last ${page.size}` : '';
    const navigation: string[] = [];
    if (slice.first > 1) navigation.push(`  earlier: ${command} ${Math.max(1, slice.first - size)}${sizeFlag}`);
    if (slice.last < total) navigation.push(`  later: ${command} ${slice.last + 1}${sizeFlag}`);
    const range = total === 0 ? `  ${noun}${separator}0` : `  ${noun} ${slice.first}-${slice.last} of ${total}`;

    if (mode === 'groups') {
      return [
        `Transcript Groups${kindTitle}`,
        range,
        ...groups
          .slice(slice.first - 1, slice.last)
          .map(
            (group) =>
              `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)} event(s)  msgs=${group.messageIndexes[0]}-${group.messageIndexes[group.messageIndexes.length - 1]}  ${group.title}`,
          ),
        ...navigation,
      ];
    }

    return [
      `Transcript Events${kindTitle}`,
      range,
      ...events
        .slice(slice.first - 1, slice.last)
        .map(
          (event) =>
            `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title}${detailSeparator}${event.detail}`,
        ),
      ...navigation,
    ];
  }
  return { buildTranscriptReviewLines };
}
