import { describe, expect, test } from 'bun:test';
import { TRANSCRIPT_EVENT_KINDS, describeUnknownTranscriptKind, readTranscriptKind } from '../terminal-shell/src/transcript-kinds.js';

describe('transcript kinds', () => {
  test('every kind parses, with dashes or capitals, and "all" is the default', () => {
    for (const kind of TRANSCRIPT_EVENT_KINDS) {
      expect(readTranscriptKind(kind)).toBe(kind);
      expect(readTranscriptKind(kind.replace(/_/g, '-').toUpperCase())).toBe(kind);
    }
    expect(readTranscriptKind(undefined)).toBe('all');
    expect(readTranscriptKind('all')).toBe('all');
  });

  test('an unknown kind is reported, not read as "all"', () => {
    expect(readTranscriptKind('tool_calls')).toBeUndefined();
    expect(readTranscriptKind('constructor')).toBeUndefined();
    expect(describeUnknownTranscriptKind('tool_calls')).toContain('tool_call');
  });
});
