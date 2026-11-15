/**
 * compaction-quality-score.test.ts
 *
 * The compaction quality score: compression in code, retention read by Jev
 * (the retention rubric times the chance the written text does not contradict
 * the conversation), composed as the geometric mean. Pins the composition,
 * what is asked and when nothing is, and the views the readings see.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { computeQualityScore } from '../platform/src/platform/runtime/compaction/quality-score.ts';
import { compactionViews } from '../platform/src/platform/runtime/compaction/judged-views.ts';
import type { StrategyInput, StrategyOutput } from '../platform/src/platform/runtime/compaction/types.ts';
import type { ProviderMessage } from '../platform/src/platform/providers/interface.ts';
import { compactionQualityPort } from './_helpers/compaction-quality.ts';

const TASK: ProviderMessage = { role: 'user', content: 'Fix the CSV export dropping its last row.' };
const FOUND: ProviderMessage = { role: 'assistant', content: 'The cause is an unconditional lines.pop() in toRows.' };
const RECENT: ProviderMessage = { role: 'user', content: 'Now add a test for it.' };
const SUMMARY: ProviderMessage = { role: 'user', content: '[Session Summary]\nFixing the CSV export; the cause is lines.pop() in toRows.' };

function input(messages: ProviderMessage[], tokensBefore = 10_000): StrategyInput {
  return { sessionId: 's', messages, tokensBefore, contextWindow: 100_000, strategy: 'autocompact' };
}

function output(messages: ProviderMessage[], tokensAfter = 2_000): StrategyOutput {
  return { messages, tokensAfter, summary: '', strategy: 'autocompact', durationMs: 0, warnings: [] };
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

describe('compaction views', () => {
  test('the source numbers every message; the compacted view names carried ones by number', () => {
    const views = compactionViews([TASK, FOUND, RECENT], [SUMMARY, RECENT]);
    expect(views.source).toBe('#1 user: Fix the CSV export dropping its last row.\n\n#2 assistant: The cause is an unconditional lines.pop() in toRows.\n\n#3 user: Now add a test for it.');
    expect(views.compacted).toBe('user: [Session Summary]\nFixing the CSV export; the cause is lines.pop() in toRows.\n\n[message #3 of the source, unchanged]');
    expect(views.written).toBe('user: [Session Summary]\nFixing the CSV export; the cause is lines.pop() in toRows.');
  });

  test('tool calls and tool results are rendered, not dropped', () => {
    const call: ProviderMessage = { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'export.ts' } }] };
    const result: ProviderMessage = { role: 'tool', callId: 'c1', name: 'read', content: 'lines.pop();' };
    const views = compactionViews([call, result], [SUMMARY]);
    expect(views.source).toContain('assistant: [calls read {"path":"export.ts"}]');
    expect(views.source).toContain('tool result (read): lines.pop();');
  });

  test('an oversized view fits its budget without hiding a late qualification or the written text', () => {
    const long: ProviderMessage[] = [{ role: 'user', content: 'context '.repeat(1000) + 'Do not deploy.' }];
    const views = compactionViews(long, [SUMMARY], 4000);
    expect(views.source.length + views.compacted.length).toBeLessThanOrEqual(4000);
    expect(views.source).toContain('Do not deploy.');
    expect(views.source).toContain('characters left out');
    const complete = compactionViews(long, [SUMMARY], 60_000);
    expect(complete.source).toContain('Do not deploy.');
    expect(complete.source).not.toContain('left out');
  });
});

describe('the score', () => {
  test('full substance, agreeing text and full compression score near the top', async () => {
    const { port, requests } = compactionQualityPort({ substance: 3, relation: 'supports' });
    installJudgmentPort(port);
    const score = await computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY, RECENT]));
    expect(requests).toHaveLength(2);
    expect(score.compressionScore).toBe(1);
    expect(score.signals.substance).toBe(1);
    expect(score.signals.fidelity).toBe('supported');
    // The fake reading gives 'contradicts' the leftover 0.05.
    expect(score.retentionScore).toBeCloseTo(0.95, 5);
    expect(score.score).toBeCloseTo(Math.sqrt(0.95), 5);
    expect(score.grade).toBe('A');
    expect(score.isLowQuality).toBe(false);
    expect(score.description).toBe('score=0.97 (A), compression=80.0%, retention=95%');
  });

  test('a compaction that contradicts the conversation is low quality however much it shrank', async () => {
    installJudgmentPort(compactionQualityPort({ substance: 3, relation: 'contradicts' }).port);
    const score = await computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY, RECENT]));
    expect(score.signals.fidelity).toBe('contradicted');
    expect(score.retentionScore).toBeCloseTo(0.05, 5);
    expect(score.isLowQuality).toBe(true);
    expect(score.grade).toBe('F');
  });

  test('a compaction that kept none of the substance is low quality', async () => {
    installJudgmentPort(compactionQualityPort({ substance: 0 }).port);
    const score = await computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY]));
    expect(score.retentionScore).toBe(0);
    expect(score.score).toBe(0);
    expect(score.isLowQuality).toBe(true);
  });

  test('a compaction that kept most of the substance and shrank by 40% passes', async () => {
    installJudgmentPort(compactionQualityPort({ substance: 2 }).port);
    const score = await computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY, RECENT], 6_000));
    expect(score.compressionScore).toBeCloseTo(0.5, 5);
    expect(score.retentionScore).toBeCloseTo((2 / 3) * 0.95, 5);
    expect(score.isLowQuality).toBe(false);
  });

  test('a compaction that wrote nothing still checks retained obligations without a fidelity claim', async () => {
    const { port, requests } = compactionQualityPort({ substance: 2 });
    installJudgmentPort(port);
    const score = await computeQualityScore(input([TASK, FOUND, RECENT]), output([FOUND, RECENT]));
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toEqual(['obligations_lost', 'required_targets_lost', 'substance']);
    expect(requests[0]!.state).toEqual({
      source: '#1 user: Fix the CSV export dropping its last row.\n\n#2 assistant: The cause is an unconditional lines.pop() in toRows.\n\n#3 user: Now add a test for it.',
      compacted: '[messages #2 to #3 of the source, unchanged]',
    });
    expect(score.signals.fidelity).toBe('none');
    expect(score.retentionScore).toBeCloseTo(2 / 3, 5);
  });


  test('even maximum substance and compression cannot mask a lost user obligation', async () => {
    installJudgmentPort(compactionQualityPort({ substance: 3, obligationsLost: .99 }).port);
    const score = await computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY], 1_000));
    expect(score.retentionScore).toBe(0);
    expect(score.score).toBe(0);
    expect(score.isLowQuality).toBe(true);
  });

  test('uncertainty about a lost obligation cannot approve a compaction', async () => {
    installJudgmentPort(compactionQualityPort({ substance: 3, obligationsLost: .5 }).port);
    await expect(computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY], 1_000))).rejects.toThrow();
  });

  test('a missing or unsettled exact target independently refuses compaction', async () => {
    for (const probability of [.99, .5]) {
      installJudgmentPort(compactionQualityPort({ substance: 3, requiredTargetsLost: probability }).port);
      if (probability === .99) expect((await computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY], 1_000))).retentionScore).toBe(0);
      else await expect(computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY], 1_000))).rejects.toThrow();
    }
  });

  test('structural failures settle retention at 0 without asking', async () => {
    const { port, requests } = compactionQualityPort();
    installJudgmentPort(port);
    const empty = await computeQualityScore(input([TASK]), output([]));
    const grown = await computeQualityScore(input([TASK]), output([SUMMARY, TASK]));
    const noTokens = await computeQualityScore(input([TASK, FOUND]), output([SUMMARY], 0));
    expect(requests).toHaveLength(0);
    expect(empty.signals.messageCountSane).toBe(false);
    expect(grown.signals.messageCountSane).toBe(false);
    expect(noTokens.signals.positiveTokenCount).toBe(false);
    for (const score of [empty, grown, noTokens]) {
      expect(score.retentionScore).toBe(0);
      expect(score.isLowQuality).toBe(true);
    }
  });

  test('scoring with no judgment port installed throws', async () => {
    await expect(computeQualityScore(input([TASK, FOUND, RECENT]), output([SUMMARY, RECENT]))).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});
