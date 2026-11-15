import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { MAX_MEMORY_CREDENTIAL_SPANS, readMemoryPublicText } from '../../tools/agent-harness-memory-provider-readings.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const keyTokens = (count: number) => Array.from({ length: count }, (_, index) => `sk-${String(index).padStart(6, '0')}abcdefghijklmnopqrstuv`).join(' ');

test('a text with more candidate spans than the cap is masked whole without one decision per span', async () => {
  let decisions = 0;
  installJudgmentPort(fakePort(() => { decisions++; return noulAnswer(0.001); }).port);
  const text = keyTokens(MAX_MEMORY_CREDENTIAL_SPANS + 50);
  const result = await readMemoryPublicText(text, { sourceOwner: ordinaryResearchOwner() });
  expect(result).not.toContain('sk-0000');
  expect(result.split(' ').every((part) => !part.startsWith('sk-'))).toBe(true);
  // Screening the source still happens; judging each span does not.
  expect(decisions).toBeLessThan(MAX_MEMORY_CREDENTIAL_SPANS);
});
