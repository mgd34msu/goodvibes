import type { TranscriptEventKind } from '@goodvibes-jev/engine/sdk/platform/core';
import {
  captureTranscriptSource,
  readTranscriptIndex,
  TRANSCRIPT_UNAVAILABLE,
  type TranscriptCommandContext,
} from './transcript-reading.js';
export function createTranscriptReviewFormatter(separator: string, detailSeparator: string) {
  async function buildTranscriptReviewLines(
    ctx: TranscriptCommandContext,
    kind: TranscriptEventKind | 'all',
    mode: 'events' | 'groups' | 'hotspots',
    source: ReturnType<typeof captureTranscriptSource>,
  ): Promise<string[]> {
    const index = await readTranscriptIndex(ctx, source);
    if (!index) return [TRANSCRIPT_UNAVAILABLE];
    const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
    const groups = kind === 'all' ? index.groups : index.groups.filter((group) => group.kind === kind);

    if (mode === 'groups') {
      return [
        `Transcript Groups${kind === 'all' ? '' : `${separator}${kind}`}`,
        `  groups${separator}${groups.length}`,
        ...groups
          .slice(0, 12)
          .map(
            (group) =>
              `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)} event(s)  msgs=${group.messageIndexes[0]}-${group.messageIndexes[group.messageIndexes.length - 1]}  ${group.title}`,
          ),
        ...(groups.length > 12 ? [`  … ${groups.length - 12} more group(s)`] : []),
      ];
    }

    if (mode === 'hotspots') {
      const kindCounts = new Map<TranscriptEventKind, number>();
      for (const event of index.events) {
        kindCounts.set(event.kind, (kindCounts.get(event.kind) ?? 0) + 1);
      }
      const busiestGroups = [...index.groups]
        .sort((a, b) => b.events.length - a.events.length || a.messageIndexes[0]! - b.messageIndexes[0]!)
        .slice(0, 8);
      return [
        'Transcript Hotspots',
        ...[...kindCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([eventKind, count]) => `  ${eventKind.padEnd(20)} ${count}`),
        '',
        'Busiest groups',
        ...busiestGroups.map((group) => `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)}  ${group.title}`),
      ];
    }

    return [
      `Transcript Events${kind === 'all' ? '' : `${separator}${kind}`}`,
      `  events${separator}${events.length}`,
      ...events
        .slice(0, 16)
        .map(
          (event) =>
            `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title}${detailSeparator}${event.detail}`,
        ),
      ...(events.length > 16 ? [`  … ${events.length - 16} more event(s)`] : []),
    ];
  }
  return { buildTranscriptReviewLines };
}
