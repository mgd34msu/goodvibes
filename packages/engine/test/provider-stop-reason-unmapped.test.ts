import { describe, expect, test } from 'bun:test';
import {
  mapCodexStopReason,
  mapLlamaCppStopReason,
  mapLmStudioStopReason,
} from '../platform/src/platform/providers/stop-reason-maps.ts';

describe('stop reasons a provider adapter does not recognise', () => {
  test('a llama.cpp content filter is reported as one, not as a clean completion', () => {
    expect(mapLlamaCppStopReason('content_filter', false)).toBe('content_filter');
  });

  test('a llama.cpp finish reason outside the table is unknown', () => {
    expect(mapLlamaCppStopReason('eos_token_weird', false)).toBe('unknown');
  });

  test('a responses status of incomplete follows the reason it names', () => {
    for (const map of [mapCodexStopReason, mapLmStudioStopReason]) {
      expect(map('incomplete', false, 'content_filter')).toBe('content_filter');
      expect(map('incomplete', false, 'max_output_tokens')).toBe('max_tokens');
      expect(map('incomplete', false, 'something_new')).toBe('unknown');
      expect(map('incomplete', false)).toBe('max_tokens');
    }
  });
});
