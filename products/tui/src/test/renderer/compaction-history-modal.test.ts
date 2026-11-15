/**
 * Compaction history text tests.
 *
 * Validates:
 *  1. History text lists compaction events from platform log.
 *  2. Empty session returns a "no compactions" message.
 *  3. Restore-unavailability notice is always present.
 *  4. History is listed most-recent-first.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import * as core from '@goodvibes-jev/engine/platform/platform/core';
import {
  buildCompactionHistoryText,
  formatCompactionEvent,
} from '../../renderer/compaction-history-modal.ts';
import { scoreCompactionRun } from '../../renderer/compaction-quality.ts';
import { useCompactionQualityPort } from '../helpers/compaction-quality-port.ts';

useCompactionQualityPort();
import type { CompactionEvent } from '@goodvibes-jev/engine/platform/platform/core';

// ---------------------------------------------------------------------------
// buildCompactionHistoryText
// ---------------------------------------------------------------------------

describe('buildCompactionHistoryText', () => {

  test('with no recorded compactions it says so and that restore is unavailable', () => {
    const spy = spyOn(core, 'getCompactionEvents').mockReturnValue([]);
    try {
      const result = buildCompactionHistoryText();
      expect(result).toContain('No compactions recorded this session');
      expect(result).toContain('Restore is not available');
    } finally {
      spy.mockRestore();
    }
  });

  test('with recorded compactions it lists them most recent first and ends with the restore-unavailable note', () => {
    const older = makeEvent({ timestamp: 1_000, messagesBeforeCompaction: 11 });
    const newer = makeEvent({ timestamp: 2_000, messagesBeforeCompaction: 22 });
    const spy = spyOn(core, 'getCompactionEvents').mockReturnValue([older, newer]);
    try {
      const lines = buildCompactionHistoryText().split('\n');
      expect(lines[0]).toContain('2 total');
      expect(lines[1]).toContain('#2');
      expect(lines[1]).toContain('22→');
      expect(lines[2]).toContain('#1');
      expect(lines[3]).toContain('Restore not available');
    } finally {
      spy.mockRestore();
    }
  });

  test('returns [Context] prefix', () => {
    const result = buildCompactionHistoryText();
    expect(result).toContain('[Context]');
  });
});

// ---------------------------------------------------------------------------
// formatCompactionEvent, quality-score grade suffix ()
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    timestamp: Date.now(),
    messagesBeforeCompaction: 20,
    messagesAfterCompaction: 1,
    tokensBeforeEstimate: 50_000,
    tokensAfterEstimate: 6_500,
    modelId: 'test-model',
    trigger: 'manual',
    ...overrides,
  };
}

describe('formatCompactionEvent', () => {
  test('omits the quality suffix when no score is supplied (event predates the feature, or never had one)', () => {
    const line = formatCompactionEvent(makeEvent(), 1);
    expect(line).not.toContain('quality=');
  });

  test('omits the quality suffix when the score is explicitly null', () => {
    const line = formatCompactionEvent(makeEvent(), 1, null);
    expect(line).not.toContain('quality=');
  });

  test('renders the grade and numeric score when a quality score is supplied', async () => {
    const score = await scoreCompactionRun({
      sessionId: 's',
      contextWindow: 200_000,
      messagesBefore: [{ role: 'user', content: 'a'.repeat(50_000) }],
      messagesAfter: [{ role: 'user', content: '[Session compacted] condensed handoff summary of this conversation' }],
      tokensBefore: 50_000,
      tokensAfter: 6_500,
    });
    const line = formatCompactionEvent(makeEvent(), 1, score);
    expect(line).toContain(`quality=${score.grade}`);
    expect(line).toContain(score.score.toFixed(2));
  });
});

