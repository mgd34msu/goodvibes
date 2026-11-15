/**
 * automation-runs-unavailable.test.ts, "could not check" is not "nothing ran".
 */

import { describe, expect, test } from 'bun:test';
import { listAutomationRunsSince } from '../../agent/automation-runs-source.ts';

describe('listAutomationRunsSince', () => {
  test('with no operator token the result says the host could not be asked', async () => {
    const result = await listAutomationRunsSince({ baseUrl: 'http://127.0.0.1:1', token: null, tokenPath: '/fixture/token' }, 0);

    expect(result.runs).toEqual([]);
    expect(result.unavailable).toBeTruthy();
    expect(result.unavailableKind).toBe('not_configured');
  });

  test('an unreachable host says so rather than returning a bare empty result', async () => {
    const result = await listAutomationRunsSince({ baseUrl: 'http://127.0.0.1:1', token: 'fixture-token', tokenPath: '/fixture/token' }, 0);

    expect(result.runs).toEqual([]);
    expect(result.unavailable).toBeTruthy();
    expect(result.unavailableKind).toBe('no_answer');
  });
});
