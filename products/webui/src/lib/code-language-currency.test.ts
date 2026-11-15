import { describe, expect, mock, test } from 'bun:test';
import { DecisionModelsDisabledError } from '@goodvibes-jev/engine/platform/browser/decision-policy';

mock.module('./goodvibes', () => ({
  runBrowserJudgment: async () => { throw new DecisionModelsDisabledError('webui.code.language'); },
}));

const { readCodeLanguage } = await import('./code-language-judgment');

describe('readCodeLanguage currency', () => {
  test('the result stops being current when the caller reports the message changed', async () => {
    let revision = 'r1';
    const result = await readCodeLanguage({
      sessionId: 's', messageId: 'm', contentRevision: 'r1', content: 'let a = 1', start: 0, end: 5,
      isSourceCurrent: () => revision === 'r1',
    }, new AbortController().signal);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.isCurrent()).toBe(true);
    revision = 'r2';
    expect(result.isCurrent()).toBe(false);
  });
});
