import { describe, expect, test } from 'bun:test';
import { parseIcs } from '@goodvibes-jev/engine/platform/platform/calendar';
import { renderIcs, foldLine } from '../../agent/ics-calendar.ts';

// ── foldLine ──────────────────────────────────────────────────────────────────

describe('foldLine', () => {
  test('does not fold short lines', () => {
    const line = 'SUMMARY:Hello world';
    expect(foldLine(line)).toBe(line);
  });

  test('folds at 75 octets with CRLF+SPACE continuation', () => {
    const long = 'DESCRIPTION:' + 'A'.repeat(80);
    const folded = foldLine(long);
    const parts = folded.split('\r\n ');
    expect(parts.length).toBeGreaterThan(1);
    // Each part fits within limit when prefix is accounted for
    const encoder = new TextEncoder();
    expect(encoder.encode(parts[0]!).length).toBeLessThanOrEqual(75);
  });

  test('handles multibyte characters without splitting sequences', () => {
    // é is 2 bytes in UTF-8; build a line that crosses the 75-byte boundary with multibyte chars
    const line = 'SUMMARY:' + 'é'.repeat(40);
    const encoder = new TextEncoder();
    const folded = foldLine(line);
    // Reconstructed value must round-trip
    const reconstructed = folded.replace(/\r\n /g, '');
    expect(reconstructed).toBe(line);
    // All chunks valid UTF-8 (Bun will throw on bad bytes otherwise)
    for (const chunk of folded.split('\r\n ')) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(75);
    }
  });

  test('folds 3-byte CJK characters straddling the 75-octet boundary', () => {
    // Each CJK char (测) is 3 bytes; pad so a boundary falls mid-character
    const line = 'SUMMARY:' + '测'.repeat(30); // 8 + 90 bytes = 98 bytes total
    const encoder = new TextEncoder();
    const folded = foldLine(line);
    // Round-trip
    const reconstructed = folded.replace(/\r\n /g, '');
    expect(reconstructed).toBe(line);
    // Each chunk stays within the per-chunk limit
    for (const chunk of folded.split('\r\n ')) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(75);
    }
  });

  test('folds 4-byte emoji characters straddling the 75-octet boundary', () => {
    // Each emoji (😀) is 4 bytes; build a line so the fold boundary could split a sequence
    const line = 'SUMMARY:' + '😀'.repeat(20); // 8 + 80 bytes = 88 bytes total
    const encoder = new TextEncoder();
    const folded = foldLine(line);
    // Round-trip
    const reconstructed = folded.replace(/\r\n /g, '');
    expect(reconstructed).toBe(line);
    // Each chunk stays within the per-chunk limit
    for (const chunk of folded.split('\r\n ')) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(75);
    }
  });
});


// ── renderIcs: what another calendar reads back ──────────────────────────────

describe('renderIcs', () => {
  test('a floating time is written without Z, so another calendar keeps the wall-clock time', () => {
    const rendered = renderIcs([{ uid: 'f@test', summary: 'Standup', dtstart: '2026-11-20T09:00:00', allDay: false }]);
    expect(rendered).toContain('DTSTART:20261120T090000\r\n');
    expect(parseIcs(rendered).events[0]!.start).toEqual({ value: '2026-11-20T09:00:00', kind: 'date-time', zone: 'floating' });
  });

  test('UTC, zoned and all-day starts read back as they were stored', () => {
    const events = parseIcs(renderIcs([
      { uid: 'u@test', summary: 'UTC', dtstart: '2026-11-20T09:00:00Z', allDay: false },
      { uid: 'z@test', summary: 'Zoned', dtstart: '2026-11-20T09:00:00', tzid: 'America/New_York', allDay: false },
      { uid: 'd@test', summary: 'Holiday', dtstart: '2026-12-25', allDay: true },
    ])).events;
    expect(events.map((event) => event.start)).toEqual([
      { value: '2026-11-20T09:00:00Z', kind: 'date-time', zone: 'utc' },
      { value: '2026-11-20T09:00:00', kind: 'date-time', zone: 'tzid', tzid: 'America/New_York' },
      { value: '2026-12-25', kind: 'date', zone: 'floating' },
    ]);
  });

  test('a repeating event keeps its rule and exceptions', () => {
    const [event] = parseIcs(renderIcs([{
      uid: 'r@test', summary: 'Weekly', dtstart: '2026-11-19T10:00:00Z', allDay: false, rrule: 'FREQ=WEEKLY;BYDAY=TH',
      exdates: [{ value: '2026-11-26T10:00:00Z', kind: 'date-time', zone: 'utc' }],
    }])).events;
    expect(event!.recurrence?.rule).toBe('FREQ=WEEKLY;BYDAY=TH');
    expect(event!.exdates?.map((value) => value.value)).toEqual(['2026-11-26T10:00:00Z']);
  });

  test('text with separators and line breaks reads back unchanged', () => {
    const [event] = parseIcs(renderIcs([{ uid: 'e@test', summary: 'A, B; C', description: 'Line 1\nLine 2', dtstart: '2026-01-01T00:00:00Z', allDay: false }])).events;
    expect(event!.summary).toBe('A, B; C');
    expect(event!.description).toBe('Line 1\nLine 2');
  });
});
