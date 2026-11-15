import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { createAgentOccasionsTool, registerAgentOccasionsTool } from '../../tools/agent-occasions-tool.ts';
import { normalizeOccasionsAction, OCCASIONS_WRITE_ACTIONS, OCCASIONS_RESPONSE_UNREADABLE } from '../../tools/agent-occasions-types.ts';
import type { OccasionsGatewayInvoke, OccasionsGatewayResult } from '../../agent/occasions-gateway.ts';

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function toolWith(respond: (methodId: string, body: Record<string, unknown>) => OccasionsGatewayResult) {
  const calls: Array<{ methodId: string; body: Record<string, unknown> }> = [];
  const invoke: OccasionsGatewayInvoke = async (methodId, body) => { calls.push({ methodId, body: { ...body } }); return respond(methodId, body); };
  const directory = makeProjectTempDir('agent-occasions-failure'); dirs.push(directory);
  const tool = createAgentOccasionsTool({ invoke });
  const run = async (args: Record<string, unknown>) => {
    const action = normalizeOccasionsAction(args.action);
    const result = action && OCCASIONS_WRITE_ACTIONS.has(action)
      ? await admitLocalState(registry => registerAgentOccasionsTool(registry, { invoke }), 'occasions', args, { directory })
      : await tool.execute(args);
    return { success: result.success, output: 'output' in result && typeof result.output === 'string' ? result.output : '' };
  };
  return { run, calls };
}
const answers = (data: unknown): OccasionsGatewayResult => ({ ok: true, data, route: 'in-process' });
const REMOVE = { action: 'remove', occasionId: 'sarahs-birthday', authority: 'owner-direct' };

describe('occasions removal confirmation', () => {
  test('remove without confirmed asks once and sends nothing', async () => {
    const { run, calls } = toolWith(() => answers({ ok: true, occasionId: 'sarahs-birthday', disclosure: 'Removed.', droppedRecords: 0 }));
    const result = await run(REMOVE);
    expect(result.success).toBe(false);
    expect(result.output).toContain('confirmed:true');
    expect(calls).toEqual([]);
  });
  test('remove with confirmed:true sends the removal', async () => {
    const { run, calls } = toolWith(() => answers({ ok: true, occasionId: 'sarahs-birthday', disclosure: 'Removed.', droppedRecords: 2 }));
    expect((await run({ ...REMOVE, confirmed: true })).success).toBe(true);
    expect(calls.map(call => call.methodId)).toEqual(['occasions.remove']);
  });
});

describe('occasions failures say what is known', () => {
  test('a write that throws after it was sent reports an unknown outcome and where to check', async () => {
    const { run, calls } = toolWith(() => { throw new Error('socket closed'); });
    const result = await run({ ...REMOVE, confirmed: true });
    expect(calls).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.output).toContain('outcome unknown');
    expect(result.output).toContain('socket closed');
    expect(result.output).toContain('action:"pending"');
    expect(result.output).not.toContain('held');
  });
  test('a read that throws names its cause instead of claiming authority is missing', async () => {
    const { run } = toolWith(() => { throw new Error('daemon unreachable'); });
    const result = await run({ action: 'list' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('daemon unreachable');
    expect(result.output).not.toContain('authority or source is unavailable');
  });
  test('a list whose items have another shape is reported as unreadable instead of throwing mid-render', async () => {
    const { run } = toolWith(() => answers({ today: '2030-01-01', timezone: 'UTC', occasions: [{}], conflicts: [], unparsed: [] }));
    const result = await run({ action: 'list' });
    expect(result.success).toBe(false);
    expect(result.output).toContain(OCCASIONS_RESPONSE_UNREADABLE);
  });
  test('a pending answer whose nudge has no message is reported as unreadable', async () => {
    const { run } = toolWith(() => answers({ today: '2030-01-01', nudge: { subjects: [] }, conflicts: [], interviews: [] }));
    const result = await run({ action: 'pending' });
    expect(result.output).toContain(OCCASIONS_RESPONSE_UNREADABLE);
  });
});

describe('occasions refuses wrongly typed optional fields', () => {
  test('a non-number leadDays and a non-boolean away are refused before anything is sent', async () => {
    const { run, calls } = toolWith(() => answers({}));
    const propose = await run({ action: 'propose', title: 'Anniversary', date: '06-01', leadDays: '3' });
    expect(propose.success).toBe(false);
    expect(propose.output).toContain('leadDays');
    const plan = await run({ action: 'plan_propose', title: 'Trip', from: '2026-07-01', to: '2026-07-05', away: 'true' });
    expect(plan.success).toBe(false);
    expect(plan.output).toContain('away');
    expect(calls).toEqual([]);
  });
});
