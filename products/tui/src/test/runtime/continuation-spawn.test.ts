/**
 * What the TUI spawns for an inbound shared-session follow-up: a channel reply is
 * conversation, a local follow-up keeps the contract, and invalid routing is refused.
 */
import { expect, test } from 'bun:test';
import { buildContinuationSpawnInput } from '../../runtime/continuation-spawn.ts';

const deps = { configReader: { get: () => undefined } as never, modelCandidates: [] };
const request = (input: Record<string, unknown>) => ({ task: 'answer it', input: { sessionId: 's1', ...input } as never });

test('a follow-up from a channel surface is spawned outside every contract with a conversational reply', () => {
  const spawn = buildContinuationSpawnInput(request({ surfaceKind: 'slack' }), deps);
  expect(spawn).toMatchObject({ mode: 'spawn', task: 'answer it', outsideContract: true, replyStyle: 'conversational', context: 'shared-session:s1' });
});

test('a follow-up typed on a local surface keeps the contract', () => {
  const spawn = buildContinuationSpawnInput(request({ surfaceKind: 'tui' }), deps);
  expect(spawn).not.toHaveProperty('outsideContract');
  expect(spawn).toMatchObject({ context: 'shared-session:s1' });
});

test('ordered fallbacks with no fallback model are refused instead of passed to the spawn', () => {
  expect(() => buildContinuationSpawnInput(request({
    surfaceKind: 'slack',
    routing: { providerId: 'openai', modelId: 'openai:gpt-test', providerFailurePolicy: 'ordered-fallbacks' },
  }), deps)).toThrow('fallback');
});

test('a tool list restricts the spawned agent to it, and no list leaves the tools alone', () => {
  const withTools = buildContinuationSpawnInput(request({ surfaceKind: 'tui', routing: { tools: ['read'] } }), deps);
  expect(withTools).toMatchObject({ tools: ['read'], restrictTools: true });
  const without = buildContinuationSpawnInput(request({ surfaceKind: 'tui', routing: { reasoningEffort: 'low' } }), deps);
  expect(without).not.toHaveProperty('restrictTools');
});
