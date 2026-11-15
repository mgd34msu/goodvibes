/**
 * Saying something to a hosted session from the Agents modal reports the real
 * outcome of the send instead of assuming it happened.
 */
import { afterEach, expect, test } from 'bun:test';
import type { HostedSessionRecord } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandContext } from '../../input/command-registry.ts';
import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { getSharedHostedSessionFeed } from '../../views/hosted-session-feed.ts';
import { wireViewOpeners } from '../../shell/view-openers.ts';
import { sayToHosted } from '../../input/commands/hosted-runtime.ts';
import { makeTestShellViews } from '../helpers/shell-views.ts';

const record: HostedSessionRecord = {
  id: 'hosted-a', workspaceRoot: '/owned/project', title: 'Session hosted-a', status: 'running', detachPolicy: 'survive', effectiveDetachPolicy: 'survive',
  attachedClients: ['owned-tui'], createdAt: 1, updatedAt: 2, turnCount: 1, messageCount: 2, restoredFromDisk: false, contractIds: [],
};

afterEach(() => { getSharedHostedSessionFeed().clear(); });

function open() {
  getSharedHostedSessionFeed().attach(record, []);
  const host = new SurfaceModalHost();
  // No daemon is configured, so the send reaches the real command path and is refused.
  const configManager = { get: () => undefined, set: () => {} } as unknown as ConfigManager;
  const context = { platform: { configManager } } as unknown as CommandContext;
  const { views, viewPanelAdapter } = makeTestShellViews({ configManager });
  wireViewOpeners({ commandContext: context, input: { surfaceModals: host } as never, views, viewPanelAdapter, render: () => {} });
  context.openAgents?.({ hosted: true });
  const modal = host.modals().find((m): m is AgentsModal => m instanceof AgentsModal) as AgentsModal;
  const key = (name: string) => host.handleToken({ type: 'key', name, logicalName: name, ctrl: false, shift: false, meta: false } as InputToken);
  const say = (text: string) => { host.handleToken({ type: 'text', value: 's' }); host.handleToken({ type: 'text', value: text }); key('enter'); };
  return { modal, say, host, context };
}
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

test('a send the daemon cannot take is reported as not sent, with the draft kept', async () => {
  const f = open();
  f.say('hello');
  await settle();
  expect(f.modal.steer?.draft).toBe('hello');
  expect(f.modal.status?.text).toContain('Not sent');
  f.host.clear();
});

test('sayToHosted passes the text untouched to the attached session and reports the daemon outcome', async () => {
  getSharedHostedSessionFeed().attach(record, []);
  const sent: Array<{ id: string; text: string }> = [];
  const context = {} as CommandContext;
  const accepting = { client: { steer: async (id: string, text: string) => { sent.push({ id, text }); } } } as never;
  expect(await sayToHosted(context, 'keep  the --yes   spacing', accepting)).toEqual({ ok: true });
  expect(sent).toEqual([{ id: 'hosted-a', text: 'keep  the --yes   spacing' }]);

  const refusing = { client: { steer: async () => { throw new Error('daemon unreachable'); } } } as never;
  const refused = await sayToHosted(context, 'hello', refusing);
  expect(refused.ok).toBe(false);
  expect(refused.ok === false && refused.error).toContain('daemon unreachable');

  getSharedHostedSessionFeed().clear();
  const detached = await sayToHosted(context, 'hello', accepting);
  expect(detached.ok === false && detached.error).toContain('no hosted session is attached');
});
