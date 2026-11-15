/**
 * automation-runs-unavailable.test.ts, "could not check" is not "nothing ran".
 */

import { describe, expect, test } from 'bun:test';
import { listAutomationRunsSince } from '../../agent/automation-runs-source.ts';

describe('listAutomationRunsSince', () => {
  test('with no operator token the result says the host could not be asked', async () => {
    const result = await listAutomationRunsSince({ baseUrl: 'http://127.0.0.1:1', token: null } as never, 0);

    expect(result.runs).toEqual([]);
    expect(result.unavailable).toBe('no connected-host operator token');
    expect(result.unavailableKind).toBe('not_configured');
  });

  test('an unreachable host says so rather than returning a bare empty result', async () => {
    const result = await listAutomationRunsSince({ baseUrl: 'http://127.0.0.1:1', token: 'fixture-token' } as never, 0);

    expect(result.runs).toEqual([]);
    expect(result.unavailable).toBe('the connected host did not answer');
    expect(result.unavailableKind).toBe('no_answer');
  });
});
