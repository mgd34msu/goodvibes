/**
 * hooks-contract-search.test.ts
 *
 * Decision-model requests per `/hooks contracts <filter>`: 0 when the words
 * match a hook point locally, 1 otherwise, and an unsure reading lists the
 * entry marked as unsure instead of failing the listing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createHookApi } from '../platform/src/platform/hooks/hook-api.ts';
import { listHookPointContracts } from '../platform/src/platform/hooks/contracts.ts';
import { forgetProcessJudgments } from '../platform/src/platform/runtime/judge.ts';

/** A port that answers each hook point's question from `probabilities` by pattern (default no). */
function contractPort(probabilities: Readonly<Record<string, number>>) {
  return fakePort((name: string, _question: Question) => noulAnswer(probabilities[name] ?? 0.02));
}

function api() {
  return createHookApi({
    listContracts: listHookPointContracts,
    dispatcher: { listHooks: () => [], listChains: () => [] },
    workbench: {} as Parameters<typeof createHookApi>[0]['workbench'],
  });
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); forgetProcessJudgments(); });
afterEach(() => { installJudgmentPort(previous); });

describe('hook contract search', () => {
  test('a blank filter or words that match locally ask the decision model nothing', async () => {
    const { port, requests } = contractPort({});
    installJudgmentPort(port);
    expect(await api().contracts('  ')).toHaveLength(listHookPointContracts().length);
    expect((await api().contracts('intercept mcp')).map((contract) => contract.pattern)).toEqual(['Pre:mcp:call']);
    expect((await api().contracts('fail compact')).map((contract) => contract.pattern)).toEqual(['Fail:compact:*']);
    expect(requests).toHaveLength(0);
  });

  test('words that match nothing locally cost one request, and unsure entries are listed as unsure', async () => {
    const { port, requests } = contractPort({ 'Fail:mcp:call': 0.95, 'Pre:tool:*': 0.5 });
    installJudgmentPort(port);
    const found = await api().contracts('server went sideways');
    expect(requests).toHaveLength(1);
    expect(found.map((contract) => [contract.pattern, contract.unsure ?? false])).toEqual([['Pre:tool:*', true], ['Fail:mcp:call', false]]);
  });

  test('with no decision model the literal ranking answers', async () => {
    expect(Array.isArray(await api().contracts('zzzz_no_literal_match_zzzz'))).toBe(true);
  });
});
