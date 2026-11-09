import { expect, test } from 'bun:test';
import { actionOf, SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readToolCall } from '../platform/src/platform/gate/reading.ts';

test('one recorded request supplies the selected gate readings and their single actual lineage', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) => {
    if (name === 'risk__family') return choiceAnswer(question, 'shell-destructive', 0.99);
    if (name === 'effect__kind') return choiceAnswer(question, 'shell', 0.99);
    return noulAnswer(['effect__mutates', 'risk__irreversible', 'edge__catastrophic'].includes(name) ? 0.99 : 0.01);
  });
  const reading = await readToolCall({ toolName: 'unknown-fixture', args: { command: 'synthetic intercepted operation' },
    askKind: true, askObfuscated: true, port: withDecisionLog(fake.port, log) });
  expect(fake.requests).toHaveLength(1);
  expect(Object.keys(fake.requests[0]!.questions).sort()).toEqual([
    'effect__mutates', 'effect__outward', 'effect__secrets', 'effect__kind', 'effect__obfuscated',
    'risk__family', 'risk__irreversible', 'risk__beyondProject', 'risk__weakensSecurity',
    'edge__catastrophic', 'edge__cardDetails',
  ].sort());
  expect(reading).toMatchObject({ mutates: true, irreversible: true, family: 'shell-destructive', kind: 'shell',
    boundary: { catastrophic: 'yes', cardDetails: 'no' } });
  const [entry] = log.query();
  expect(reading.judgmentDecisionIds).toEqual([entry!.id]);
  reading.recordAction('held synthetic action');
  expect(actionOf(log.get(entry!.id)!)).toBe('held synthetic action');
});

test('ordinary tool calls omit shell-only and kind questions while keeping complete input', async () => {
  const fake = fakePort((name, question) => name === 'risk__family'
    ? choiceAnswer(question, 'file-mutation', 0.99) : noulAnswer(name === 'effect__mutates' ? 0.99 : 0.01));
  const reading = await readToolCall({ toolName: 'write', args: { path: 'note.txt', content: 'complete source' }, port: fake.port });
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]!.state).toMatchObject({ tool: 'write', arguments: { path: 'note.txt', content: 'complete source' } });
  expect(Object.keys(fake.requests[0]!.questions)).not.toContain('effect__kind');
  expect(Object.keys(fake.requests[0]!.questions)).not.toContain('effect__obfuscated');
  expect(Object.keys(fake.requests[0]!.questions)).not.toContain('edge__catastrophic');
  expect(reading.boundary.catastrophic).toBeUndefined();
  expect(reading.kind).toBeUndefined();
});
