/**
 * Saying something to a hosted session reports success only when it was accepted,
 * and keeps the draft when it was not.
 */
import { afterEach, expect, test } from 'bun:test';
import type { HostedSessionRecord } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { HostedSessionFeed } from '../../views/hosted-session-feed.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../views/fleet-read-model.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const record = (id = 'hosted-a'): HostedSessionRecord => ({
  id, workspaceRoot: '/owned/project', title: `Session ${id}`, status: 'running', detachPolicy: 'survive', effectiveDetachPolicy: 'survive',
  attachedClients: ['owned-tui'], createdAt: 1, updatedAt: 2, turnCount: 1, messageCount: 2, restoredFromDisk: false, contractIds: [],
});
const history = (count: number, prefix = 'entry') => Array.from({ length: count }, (_, index) => ({ role: 'assistant' as const, content: `${prefix}-${String(index).padStart(3, '0')}` }));

type Steer = NonNullable<ConstructorParameters<typeof AgentsModal>[0]['steerHosted']>;
function fixture(steerHosted: Steer) {
  const feed = new HostedSessionFeed(); feed.attach(record(), []);
  const host = new SurfaceModalHost();
  const modal = new AgentsModal({
    readModel: createStaticFleetReadModel(buildFleetSnapshot([])), hosted: feed, tickMs: 0,
    actions: { interrupt: () => false, resume: () => false, kill: () => [],
      getConversationSnapshot: () => [], resolveSessionLogPath: () => '', steer: () => ({ queued: false, reason: 'not used' }) },
    steerHosted, requestRender: () => {},
  });
  host.push(modal); modal.showHosted(); cleanup.push(() => host.clear());
  const key = (logicalName: string) => host.handleToken({ type: 'key', name: logicalName, logicalName, ctrl: false, shift: false, meta: false } as InputToken);
  const say = (text: string) => { host.handleToken({ type: 'text', value: 's' }); host.handleToken({ type: 'text', value: text }); key('enter'); };
  return { modal, say };
}
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

test('a refused send keeps the draft and shows the reason instead of claiming it was sent', async () => {
  const f = fixture(async () => ({ ok: false, error: 'no hosted session is attached' }));
  f.say('please stop');
  await settle();
  expect(f.modal.steer?.draft).toBe('please stop');
  expect(f.modal.status?.text).toContain('Not sent');
  expect(f.modal.status?.text).toContain('no hosted session is attached');
  expect(f.modal.status?.text).not.toContain('Sent to the hosted session');
});

test('a send that rejects keeps the draft too', async () => {
  const f = fixture(async () => { throw new Error('daemon unreachable'); });
  f.say('hello');
  await settle();
  expect(f.modal.steer?.draft).toBe('hello');
  expect(f.modal.status?.text).toContain('daemon unreachable');
});

test('an accepted send clears the draft and says so, with the text unchanged', async () => {
  const sent: string[] = [];
  const f = fixture(async (text) => { sent.push(text); return { ok: true }; });
  f.say('keep  the   spacing');
  await settle();
  expect(sent).toEqual(['keep  the   spacing']);
  expect(f.modal.steer).toBeNull();
  expect(f.modal.status?.text).toBe('Sent to the hosted session.');
});
