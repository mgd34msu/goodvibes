import { afterEach, beforeEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { repairToolCall } from '../sdk/src/platform/tools/auto-repair.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { ToolDefinition } from '../sdk/src/platform/types/tools.js';

const schema: ToolDefinition = { name: 'repair_fixture', description: 'Intercepted; no external effects.', parameters: {
  type: 'object', required: ['command'], properties: {
    command: { type: 'string' }, enabled: { type: 'boolean' }, count: { type: 'number' },
    color: { type: 'string', enum: ['blue', 'green'] },
  },
} };
let prior: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(prior); });
const under = <T>(policy: DecisionModelPolicy, work: () => T) => withDecisionModelPolicy(() => policy, work);

test('Classic repairs native grammar without touching an explicitly supplied decision port', async () => {
  let touches = 0;
  const port: JudgmentPort = { get model() { touches++; return 'fixture'; }, async ask() { touches++; throw new Error('must not ask'); } };
  await under('Classic - Off', async () => {
    const args = { cmd: 'synthetic command', enabled: 'yes', count: '2', color: 'BLUE' };
    const result = await repairToolCall(schema.name, args, schema, undefined, port);
    expect(result).toMatchObject({ repaired: true, provenance: 'classic', fixed: { ...args, count: 2, color: 'blue' } });
    expect(result.fixed).not.toHaveProperty('command');
    expect(result.warnings?.join(' ')).toContain('Supply exact boolean values');
    expect(args).toEqual({ cmd: 'synthetic command', enabled: 'yes', count: '2', color: 'BLUE' });
    const exact = await repairToolCall(schema.name, { command: 'literal', enabled: 'false' }, schema, undefined, port);
    expect(exact.fixed.enabled).toBe(false);
    expect(exact.warnings).toBeUndefined();
    expect(touches).toBe(0);
  });
});

test('Classic prepared calls retain local coercions and reject unresolved arguments before execution', async () => {
  await under('Classic - Off', async () => {
    const registry = new ToolRegistry(); let executions = 0;
    registry.register({ definition: schema, async execute(args) { executions++; expect(args.enabled).toBe(false); return { success: true, output: 'intercepted' }; } });
    const ready = await registry.prepareCall('ready', schema.name, { command: 'literal', enabled: 'false' });
    expect(ready.judgmentDecisionIds).toEqual([]);
    expect(await registry.executePrepared(ready, () => {})).toMatchObject({ success: true });
    await expect(registry.executePrepared(ready, () => {})).rejects.toThrow();
    await expect(registry.prepareCall('ambiguous', schema.name, { command: 'literal', enabled: 'yes' })).rejects.toThrow('schema');
    await expect(registry.prepareCall('missing', schema.name, { cmd: 'literal' })).rejects.toThrow('schema');
    expect(executions).toBe(1);
  });
});

for (const supplied of [true, false]) test(`Preferred exhaustion retains local repairs, ${supplied ? 'supplied' : 'installed'} port`, async () => {
  let requests = 0;
  const port: JudgmentPort = { model: 'fixture', async ask() { requests++; throw new JudgmentError('unavailable', 'fixture exhausted'); } };
  if (!supplied) installJudgmentPort(port);
  await under('Preferred', async () => {
    const result = await repairToolCall(schema.name, { command: 'literal', enabled: 'yes', count: '2' }, schema, undefined, supplied ? port : undefined);
    expect(result).toMatchObject({ provenance: 'classic', fixed: { command: 'literal', enabled: 'yes', count: 2 } });
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
    await repairToolCall(schema.name, { command: 'literal', enabled: 'yes' }, schema, undefined, port);
    expect(requests).toBe(1);
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) test(`Preferred never treats ${kind} as repair availability exhaustion`, async () => {
  const failure = new JudgmentError(kind, 'fixture failure');
  await under('Preferred', async () => {
    const port: JudgmentPort = { model: 'fixture', async ask() { throw failure; } };
    await expect(repairToolCall(schema.name, { command: 'literal', enabled: 'yes' }, schema, undefined, port)).rejects.toBe(failure);
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Default preserves exhaustion, and concurrent cancellation prevents Preferred activation', async () => {
  const unavailable = new JudgmentError('unavailable', 'fixture failure');
  await under('Default - On', async () => {
    const port: JudgmentPort = { model: 'fixture', async ask() { throw unavailable; } };
    await expect(repairToolCall(schema.name, { cmd: 'literal' }, schema, undefined, port)).rejects.toBe(unavailable);
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
  await under('Preferred', async () => {
    const abort = new AbortController();
    const port: JudgmentPort = { model: 'fixture', async ask() { abort.abort('private reason'); throw unavailable; } };
    await expect(repairToolCall(schema.name, { cmd: 'literal' }, schema, abort.signal, port)).rejects.toMatchObject({ kind: 'aborted' });
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});
