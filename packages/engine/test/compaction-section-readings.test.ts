import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { compactMessages } from '../platform/src/platform/core/context-compaction.js';
import type { CompactionContext } from '../platform/src/platform/core/compaction-types.js';
import type { ProviderRegistry } from '../platform/src/platform/providers/registry.js';
import type { ProviderMessage } from '../platform/src/platform/providers/interface.js';
import { COMPACTION_SELECTION_LIMITS, renderSelected } from '../platform/src/platform/runtime/compaction/section-readings.js';
import { logger } from '../platform/src/platform/utils/logger.js';
import { registry } from '../platform/src/platform/runtime/judgment-registry.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const providers = { getForModel() { throw new Error('Unexpected provider call'); }, listModels() { return []; } } as unknown as ProviderRegistry;
const context = (overrides: Partial<CompactionContext> = {}): CompactionContext => ({
  messages: [{ role: 'user', content: 'Preserve the API.' }, { role: 'assistant', content: 'Fixed the parser that printed "no resolved problems"; tests pass.' }],
  sessionMemories: [], agents: [], contracts: [], activePlan: null, lineageEntries: [], compactionCount: 0,
  contextWindow: 100_000, trigger: 'manual', extractionModelId: 'test/model', ...overrides,
});
type Question = { candidateSourcePosition?: number };
/** Answers each selection question from the battery and the candidate's source position. */
function installed(answer: (battery: string, position: number) => unknown) {
  const { port, requests } = fakePort(() => noulAnswer(0.95));
  const wrapped: JudgmentPort = { ...port, async ask(request) {
    const result = await port.ask(request);
    if (!request.context?.battery?.startsWith('engine.compaction.')) return result;
    return { ...result, answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
      const position = ((question as { instructions?: Question }).instructions?.candidateSourcePosition) ?? 0;
      return [key, answer(request.context?.battery ?? '', position)];
    })) as never };
  } };
  installJudgmentPort(wrapped);
  return { requests: requests.filter(request => request.context?.battery?.startsWith('engine.compaction.')), all: requests };
}
const section = (result: Awaited<ReturnType<typeof compactMessages>>, id: string) => result.sections.find(entry => entry.id === id)?.content;

describe('structured compaction source selection', () => {
  test('registers three named decisions', () => {
    const names = registry.list().map(decision => decision.name);
    expect(names).toContain('engine.compaction.conversation-substance');
    expect(names).toContain('engine.compaction.tool-result-relevance');
    expect(names).toContain('engine.compaction.resolved-problem-evidence');
  });

  test('a typed yes keeps the message and a typed no leaves it out', async () => {
    installed((battery) => noulAnswer(battery.endsWith('resolved-problem-evidence') ? 0.01 : 0.99));
    const result = await compactMessages(context(), providers);
    expect(section(result, 'recent-conversation')).toBe('[user]: Preserve the API.\n\n[assistant]: Fixed the parser that printed "no resolved problems"; tests pass.');
    expect(section(result, 'resolved-problems')).toBeUndefined();
  });

  test('a kept reply brings the user turn that prompted it', async () => {
    installed((battery, position) => noulAnswer(battery.endsWith('conversation-substance') && position === 2 ? 0.99 : 0.01));
    const result = await compactMessages(context(), providers);
    expect(section(result, 'recent-conversation')).toContain('[user]: Preserve the API.\n\n[assistant]:');
  });

  test('selection is one request per bounded chunk, not one per message', async () => {
    const { requests } = installed(() => noulAnswer(0.99));
    const messages: ProviderMessage[] = Array.from({ length: 120 }, (_, index) => (index % 2 === 0
      ? { role: 'user' as const, content: `Requirement ${index}: ${'detail '.repeat(40)}` }
      : { role: 'assistant' as const, content: `Done ${index}: ${'note '.repeat(40)}` }));
    await compactMessages(context({ messages }), providers);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(COMPACTION_SELECTION_LIMITS.maxCalls);
    // Each request asks about several candidates and carries only its own chunk.
    expect(requests.some(request => Object.keys(request.questions).length > 1)).toBe(true);
    for (const request of requests) {
      expect(JSON.stringify(request.state).length).toBeLessThan(COMPACTION_SELECTION_LIMITS.chunkTokens * 3 + 2 * COMPACTION_SELECTION_LIMITS.messageChars);
    }
  });

  test('a selection over the request limit quotes the sections and asks nothing', async () => {
    const { requests } = installed(() => noulAnswer(0.99));
    const messages: ProviderMessage[] = Array.from({ length: (COMPACTION_SELECTION_LIMITS.maxCalls + 2) * 4 }, (_, index) => (
      { role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: `Step ${index}: ${'x'.repeat(COMPACTION_SELECTION_LIMITS.chunkTokens * 2)}` }));
    const result = await compactMessages(context({ messages }), providers);
    expect(requests).toHaveLength(0);
    expect(section(result, 'recent-conversation')).toContain('Excerpt clipped');
  });

  test('an unreachable decision model quotes the sections instead of failing, and logs no source text', async () => {
    const { port } = fakePort(() => { throw new Error('synthetic unavailable'); });
    installJudgmentPort(port);
    const spies = (['debug', 'info', 'warn', 'error'] as const).map(level => spyOn(logger, level));
    try {
      const result = await compactMessages(context(), providers);
      expect(section(result, 'recent-conversation')).toContain('Preserve the API.');
      const logged = JSON.stringify(spies.flatMap(spy => spy.mock.calls));
      expect(logged).not.toContain('Preserve the API.');
      expect(logged).not.toContain('Fixed the parser');
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  test('cancellation ends the pass even for an uncooperative dependency', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const { port } = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...port, ask: async () => { entered(); return new Promise(() => {}); } });
    const controller = new AbortController();
    const result = compactMessages(context({ signal: controller.signal }), providers);
    await started; controller.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow('cancelled');
  });

  test('a source that changes during the pass ends it without a compaction', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    const { port } = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...port, async ask(request) { entered(); await ready; return port.ask(request); } });
    const ctx = context(); const result = compactMessages(ctx, providers);
    await started; ctx.messages.push({ role: 'user', content: 'New requirement.' }); release();
    await expect(result).rejects.toThrow('Compaction source changed');
  });

  test('standing instructions are not fed into membership decisions', async () => {
    const { all } = installed(() => noulAnswer(0.99));
    const result = await compactMessages(context({ instructionChain: 'SYNTHETIC_STANDING_ONLY', activeSkillFrontmatter: 'SYNTHETIC_SKILL_ONLY' }), providers);
    expect(result.summary).toContain('SYNTHETIC_STANDING_ONLY');
    expect(JSON.stringify(all)).not.toContain('SYNTHETIC_STANDING_ONLY');
    expect(JSON.stringify(all)).not.toContain('SYNTHETIC_SKILL_ONLY');
  });
});

describe('quoting selected messages', () => {
  test('a tool call is quoted as name, path and size; its arguments stay in saved history', () => {
    const rendered = renderSelected([{ role: 'assistant', content: '', toolCalls: [{ id: 'call-7', name: 'edit', arguments: { path: 'src/parser.ts', new_string: 'x'.repeat(1500) } }] }], new Set([0]), 1000);
    expect(rendered).toContain('call-7');
    expect(rendered).toContain('edit src/parser.ts');
    expect(rendered).not.toContain('x'.repeat(100));
  });

  test('a section over its budget keeps the newest lines and names how many it left out', () => {
    const messages: ProviderMessage[] = Array.from({ length: 6 }, (_, index) => ({ role: 'user' as const, content: `line ${index} ${'y'.repeat(200)}` }));
    const rendered = renderSelected(messages, new Set([0, 1, 2, 3, 4, 5]), 150);
    expect(rendered.length).toBeLessThanOrEqual(600);
    expect(rendered).toStartWith('[');
    expect(rendered).toContain('earlier lines omitted');
    expect(rendered).toContain('line 5');
    expect(rendered).not.toContain('line 0');
  });

  test('four edit exchanges no longer exhaust a section budget', () => {
    const messages: ProviderMessage[] = [];
    for (let index = 0; index < 4; index++) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${index}`, name: 'edit', arguments: { path: `src/f${index}.ts`, edits: [{ find: 'a'.repeat(700), replace: 'b'.repeat(700) }] } }] });
      messages.push({ role: 'tool', callId: `c${index}`, name: 'edit', content: `Edited src/f${index}.ts` });
    }
    const rendered = renderSelected(messages, new Set(messages.map((_, index) => index)), 300);
    expect(rendered).toContain('Edited src/f3.ts');
  });
});
