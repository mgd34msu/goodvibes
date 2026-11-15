/**
 * The owner's dates and plans are read only by a turn that can act as the owner, and an acknowledgement
 * names an occurrence the occasion really has.
 */
import { describe, expect, test } from 'bun:test';
import { resolveCaptureAuthority } from '../platform/src/platform/personal-capture/authority.js';
import { createProfileTool } from '../platform/src/platform/tools/profile/index.js';

const OWNER_CHAT = 'owner-chat';

function harness() {
  const acknowledged: Array<{ occasionId: string; occurrence?: string; source?: string }> = [];
  const base = createProfileTool({
    holder: { getPort: () => ({ occasions: {
      acknowledge: async (request: { occasionId: string; occurrence?: string; source?: string }) => { acknowledged.push(request); return { ok: true, reply: 'Acknowledged', reason: null }; },
      list: async () => ({
        today: '2026-05-01',
        occasions: [{ occasion: { id: 'mum', title: "Mum's birthday", text: '06-14', kind: 'gift', person: 'Mum' }, nextOccurrence: '2026-06-14', daysUntil: 44 }],
      }),
      listPlans: () => ({ plans: [{ id: 'trip', title: 'Lisbon', details: undefined, extras: ['flight TP123 at 09:40'] }], awayNow: null }),
    } }) as never },
    captureEnabled: () => true,
    defaultAuthority: resolveCaptureAuthority({}),
  });
  const owner = base.bindCapture(resolveCaptureAuthority({
    channel: { surfaceKind: 'telegram', address: OWNER_CHAT, routed: true },
    ownerChannels: `telegram:${OWNER_CHAT}`,
  }));
  const stranger = base.bindCapture(resolveCaptureAuthority({
    channel: { surfaceKind: 'telegram', address: 'someone-else' },
    ownerChannels: `telegram:${OWNER_CHAT}`,
  }));
  return { owner, stranger, acknowledged };
}

const parse = (result: { output?: string | undefined }) => JSON.parse(String(result.output)) as Record<string, unknown>;

describe('profile list', () => {
  test('a turn on an unlisted channel is refused and learns nothing of the owner\'s trips', async () => {
    const { stranger } = harness();
    const result = await stranger.execute({ action: 'list' });
    const body = parse(result);
    expect(body.stored).toBe(false);
    expect(String(body.reason)).toContain('were not read');
    expect(result.output).not.toContain('Lisbon');
    expect(result.output).not.toContain('TP123');
  });

  test('the owner still reads their dates and plans', async () => {
    const { owner } = harness();
    const body = parse(await owner.execute({ action: 'list' }));
    expect(JSON.stringify(body)).toContain('Lisbon');
  });
});

describe('acknowledge occurrence', () => {
  test('an occurrence the occasion does not have is refused, naming the next one', async () => {
    const { owner, acknowledged } = harness();
    for (const occurrence of ['2027-06-14', 'June 14', '2026-13-45']) {
      const body = parse(await owner.execute({ action: 'acknowledge_occasion', occasionId: 'mum', occurrence }));
      expect(body.stored).toBe(false);
      expect(String(body.reason)).toContain('2026-06-14');
    }
    expect(acknowledged).toEqual([]);
  });

  test('the real next occurrence, or none, is acknowledged', async () => {
    const { owner, acknowledged } = harness();
    expect(parse(await owner.execute({ action: 'acknowledge_occasion', occasionId: 'mum', occurrence: '2026-06-14' })).stored).toBe(true);
    expect(parse(await owner.execute({ action: 'acknowledge_occasion', occasionId: 'mum' })).stored).toBe(true);
    expect(acknowledged).toEqual([{ occasionId: 'mum', source: 'conversation', occurrence: '2026-06-14' }, { occasionId: 'mum', source: 'conversation' }]);
  });
});
