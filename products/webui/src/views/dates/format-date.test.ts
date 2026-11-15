import { describe, expect, test } from 'bun:test';
import { formatDateOnly } from './format-date';

// The runtime reads the zone once, so pin it before any date is built.
process.env.TZ = 'America/Los_Angeles';

describe('formatDateOnly', () => {
  test('a date-only string shows the same day west of UTC', () => {
    expect(formatDateOnly('2026-12-25')).toContain('25');
    expect(formatDateOnly('2026-12-25')).not.toContain('24');
  });

  test('a full timestamp is shown in the viewer zone', () => {
    expect(formatDateOnly('2026-12-25T03:00:00.000Z')).toContain('24');
  });

  test('missing and unreadable values', () => {
    expect(formatDateOnly(null)).toBe('No date');
    expect(formatDateOnly('not a date')).toBe('not a date');
  });
});
