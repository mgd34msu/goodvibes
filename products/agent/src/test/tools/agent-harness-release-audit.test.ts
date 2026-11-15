import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { EVIDENCE_CONTENT_LIMIT, boundEvidenceText } from '../../tools/agent-harness-release-evidence.ts';
import { makeFixture, executeHarnessJson, createHarnessFixtureReadings } from './agent-harness-tool-fixture.ts';

afterAll(cleanupResearchScreeningFixtures);

let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
  fixtureLog = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
});
afterEach(() => { installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });

describe('release audit evidence', () => {
  test('evidence content is returned whole when small and cut with a stated length when large', () => {
    expect(boundEvidenceText('short')).toEqual({ content: 'short' });
    const large = 'x'.repeat(EVIDENCE_CONTENT_LIMIT + 5);
    const bounded = boundEvidenceText(large);
    expect(String(bounded.content)).toHaveLength(EVIDENCE_CONTENT_LIMIT);
    expect(bounded).toMatchObject({ contentTruncated: true, contentChars: large.length });
  });

  test('absent audit evidence says where it comes from and that installs ship only the release notes', async () => {
    const fixture = makeFixture();
    try {
      const readiness = await executeHarnessJson<{ readonly status: string; readonly reason: string }>(fixture, { mode: 'release_readiness' });
      expect(readiness.status).toBe('unavailable');
      expect(readiness.reason).toContain('not present in this Agent installation');
      expect(readiness.reason).toContain('source checkout');
      expect(readiness.reason).toContain('release/release-notes.md');
    } finally {
      await fixture.cleanup();
    }
  });
});
