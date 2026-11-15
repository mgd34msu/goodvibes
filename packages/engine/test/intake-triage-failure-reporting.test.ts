import { describe, expect, spyOn, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { scoreInboxTriage } from '../platform/src/platform/intake/triage/scorer.js';
import { TRIAGE_MODEL } from '../platform/src/platform/intake/triage/battery.js';
import { logger } from '../platform/src/platform/utils/logger.js';

const item = { id: 'fixture-a', surface: 'synthetic', subject: 'Synthetic message', snippet: 'A synthetic offline fixture.', unread: true };

describe('typed inbox triage failure reporting', () => {
  test('a failed judgment is logged by class only, never with the failure text', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const port: JudgmentPort = { model: TRIAGE_MODEL, async ask() { throw new TypeError('private subject line'); } };
      const rows = await scoreInboxTriage([item], port);
      expect(rows[0]?.status).toBe('unavailable');
      expect(JSON.stringify(warn.mock.calls)).toContain('TypeError');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private subject line');
    } finally { warn.mockRestore(); }
  });
});
