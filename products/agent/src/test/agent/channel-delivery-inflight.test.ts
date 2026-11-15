/**
 * channel-delivery-inflight.test.ts, a send counts as in flight for the whole
 * time it is inside deliverAgentChannelMessage, so a self-update that asks
 * "is this agent busy?" cannot restart the process under it.
 */

import { describe, expect, test } from 'bun:test';
import { useSecurityReadings } from '../helpers/security-readings.ts';
import { channelDeliveriesInFlight, deliverAgentChannelMessage } from '../../agent/channel-delivery.ts';

useSecurityReadings();

const router = (deliver: () => Promise<string | undefined>) => ({
  listStrategies: () => [{ id: 'fake', canHandle: () => true, deliver: async () => ({}) }],
  deliver,
}) as unknown as Parameters<typeof deliverAgentChannelMessage>[0];

describe('channelDeliveriesInFlight', () => {
  test('already counts the send when the owner check that follows card screening runs', async () => {
    const seen: number[] = [];
    await deliverAgentChannelMessage(router(async () => 'r-1'), { message: 'Review approvals', channel: 'slack:ops' }, {
      assertCurrent: () => { seen.push(channelDeliveriesInFlight()); },
    });

    // The first check runs before the send is counted; the last one runs after
    // screening and before the strategy, inside the counted window.
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect(channelDeliveriesInFlight()).toBe(0);
  });

  test('is released when delivery throws', async () => {
    await expect(deliverAgentChannelMessage(router(async () => { throw new Error('provider down'); }),
      { message: 'Review approvals', channel: 'slack:ops' })).rejects.toThrow('provider down');

    expect(channelDeliveriesInFlight()).toBe(0);
  });

  test('is released when the owner is no longer current after screening', async () => {
    let calls = 0;
    await expect(deliverAgentChannelMessage(router(async () => 'r-1'), { message: 'Review approvals', channel: 'slack:ops' }, {
      assertCurrent: () => { calls += 1; if (calls > 1) throw new Error('owner retired'); },
    })).rejects.toThrow('owner retired');

    expect(channelDeliveriesInFlight()).toBe(0);
  });
});

describe('a message the provider already accepted', () => {
  test('is reported as sent even when the strategy list cannot be read afterwards', async () => {
    const throwing = {
      listStrategies: () => { throw new Error('strategy list unavailable'); },
      deliver: async () => 'r-9',
    } as unknown as Parameters<typeof deliverAgentChannelMessage>[0];

    const result = await deliverAgentChannelMessage(throwing, { message: 'Review approvals', channel: 'slack:ops' });

    expect(result.responseId).toBe('r-9');
    expect(result.strategyCount).toBe(0);
  });
});
