/**
 * The prepared execution path production uses: what the model is told about a
 * call the registry rewrote, and what is reported when cleanup fails after the
 * tool already ran.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import type { ToolInputProjector } from '../platform/src/platform/tools/input-projection.ts';
import type { Tool } from '../platform/src/platform/types/tools.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(gateReadingsPort().port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

function register(name: string, body: Tool['execute'], projector?: ToolInputProjector): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name, description: 'Synthetic tool.',
      parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
    },
    execute: body,
  }, projector ? { inputProjection: projector } : undefined);
  return registry;
}

test('a call whose argument was coerced says so when it runs through prepareCall and executePrepared', async () => {
  const registry = register('toggle', async (args) => ({ success: true, output: `enabled=${String(args.enabled)}` }));
  const call = await registry.prepareCall('c1', 'toggle', { enabled: 'true' });
  const result = await registry.executePrepared(call, () => {});
  expect(result.success).toBe(true);
  expect(result.output).toStartWith('[Auto-repaired:');
  expect(result.output).toContain('enabled=true');
});

test('a JSON result keeps parsing: the repair note becomes a leading field', async () => {
  const registry = register('toggle', async (args) => ({ success: true, output: JSON.stringify({ enabled: args.enabled }) }));
  const call = await registry.prepareCall('c1', 'toggle', { enabled: 'true' });
  const result = await registry.executePrepared(call, () => {});
  const parsed = JSON.parse(result.output ?? '') as { auto_repaired: string[]; enabled: boolean };
  expect(parsed.enabled).toBe(true);
  expect(parsed.auto_repaired.length).toBeGreaterThan(0);
});

test('an ignored parameter is reported on the prepared path', async () => {
  const registry = register('toggle', async () => ({ success: true, output: 'done' }));
  const call = await registry.prepareCall('c1', 'toggle', { enabled: true, bogus: 1 });
  const result = await registry.executePrepared(call, () => {});
  expect(result.output).toContain('Ignored parameters');
  expect(result.output).toContain('bogus');
});

test('a call that needed no repair carries no note', async () => {
  const registry = register('toggle', async () => ({ success: true, output: 'done' }));
  const call = await registry.prepareCall('c1', 'toggle', { enabled: true });
  expect((await registry.executePrepared(call, () => {})).output).toBe('done');
});

test('cleanup that fails after the tool ran reports the result, not a failure that invites a repeat', async () => {
  let ran = 0;
  const registry = register('toggle', async () => { ran++; return { success: true, output: 'effect applied' }; }, {
    async project(request) {
      return { status: 'projected', args: request.args, async release() { throw new Error('owner cleanup failed'); } };
    },
  });
  const call = await registry.prepareCall('c1', 'toggle', { enabled: true });
  const result = await registry.executePrepared(call, () => {});
  expect(ran).toBe(1);
  expect(result.success).toBe(true);
  expect(result.output).toBe('effect applied');
  expect(result.warnings?.join(' ')).toContain('do not repeat the call');
});

test('cleanup that fails after a directly executed projected tool ran reports the result, not a thrown failure', async () => {
  let ran = 0;
  const registry = register('toggle', async () => { ran++; return { success: true, output: 'effect applied' }; }, {
    async project(request) {
      return { status: 'projected', args: request.args, async release() { throw new Error('owner cleanup failed'); } };
    },
  });
  const result = await registry.execute('c1', 'toggle', { enabled: true });
  expect(ran).toBe(1);
  expect(result.success).toBe(true);
  expect(result.output).toBe('effect applied');
  expect(result.warnings?.join(' ')).toContain('do not repeat the call');
});
