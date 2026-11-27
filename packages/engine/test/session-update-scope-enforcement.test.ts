// Proves: A non-admin principal receives no admin-only event, a principal that loses admin stops receiving them, and one hosted session cannot reach another session's agents.
// Red when: An admin-only event reaches a non-admin socket (live, replayed, or by naming itself a tui), a demoted principal's socket keeps its grant, or one session's agent tool reaches another session's agents.
/**
 * session-update-scope-enforcement.test.ts
 *
 * What a principal may receive on the control-plane event stream is decided
 * once, when it subscribes, from the event descriptors' access and scopes. A
 * non-admin principal never receives setting values, approvals, session
 * lifecycle or transcripts, live or replayed, whatever scopes it holds and
 * whatever kind its socket names; an admin and an internal stream that carries
 * no principal scopes receive everything. One session's agent tool lists,
 * reads, steers and cancels only the agents that session started, though every
 * session of the process shares one agent manager.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { createFeatureFlagManager } from '../platform/src/platform/runtime/feature-flags/manager.js';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { AgentManager } from '../platform/src/platform/tools/agent/manager.js';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.js';
import { createAgentTool } from '../platform/src/platform/tools/agent/index.js';

/** Every read scope a non-admin user is granted. */
const NON_ADMIN_SCOPES = ['read:events', 'read:sessions', 'read:remote', 'read:tasks', 'read:config'] as const;
const ADMIN_ONLY_BROADCASTS = ['session-update', 'hosted-session-update', 'approval-update'] as const;

function makeGateway(): { gateway: ControlPlaneGateway; bus: RuntimeEventBus } {
  const bus = new RuntimeEventBus();
  return { gateway: new ControlPlaneGateway({ runtimeBus: bus, featureFlags: createFeatureFlagManager() }), bus };
}

function publishAdminOnly(gateway: ControlPlaneGateway): void {
  for (const event of ADMIN_ONLY_BROADCASTS) gateway.publishEvent(event, { secret: event });
  // An undeclared broadcast nobody addressed (a companion follow-up, a plugin's event).
  gateway.publishEvent('conversation.followup.companion', { secret: 'transcript' });
}

describe('the event stream grant is decided once, from the descriptors', () => {
  test('a non-admin principal receives no admin-only event live or replayed, even naming itself a tui', () => {
    const { gateway } = makeGateway();
    publishAdminOnly(gateway);
    for (const clientKind of ['web', 'tui'] as const) {
      const events: string[] = [];
      const { clientId, domains } = gateway.openWebSocketClient({
        clientKind, scopes: NON_ADMIN_SCOPES, admin: false, domains: ['config', 'turn', 'tools', 'tasks', 'automation'],
      }, (event) => events.push(event));
      publishAdminOnly(gateway);
      gateway.publishEvent('remote-peer', { peer: 'p' });
      // `turn` and `tools` are opened to a person's sessions scope frame by frame, for the sessions that person's principal owns
      // (gateway-scope-enforcement.ts OWN_SESSION_FOLLOW_SCOPES); `config` and `tasks` stay closed, whatever kind it names.
      expect(domains).toEqual(['turn', 'tools', 'automation']);
      for (const event of ADMIN_ONLY_BROADCASTS) expect(events).not.toContain(event);
      expect(events).not.toContain('conversation.followup.companion');
      expect(events).toContain('remote-peer');
      gateway.closeWebSocketClient(clientId);
    }
  });

  test('a principal that loses admin stops receiving admin-only domains and events', () => {
    const { gateway } = makeGateway();
    const events: string[] = [];
    const { clientId } = gateway.openWebSocketClient({ clientKind: 'web', scopes: NON_ADMIN_SCOPES, admin: true, domains: ['config', 'automation'] }, (event) => events.push(event));
    gateway.regrantClient(clientId, { admin: false, scopes: NON_ADMIN_SCOPES });
    events.length = 0;
    publishAdminOnly(gateway);
    for (const event of ADMIN_ONLY_BROADCASTS) expect(events).not.toContain(event);
    gateway.closeWebSocketClient(clientId);
  });
});

describe('one session does not see another session\'s agents', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  test('the agent tool of one session cannot list, read, message or cancel an agent another session started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-session-agents-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const configManager = new ConfigManager({ configDir: join(dir, 'config') });
    const messageBus = new AgentMessageBus();
    const manager = new AgentManager({ messageBus, configManager });
    const mine = manager.spawn({ mode: 'spawn', task: 'session A work', outsideContract: true, sessionId: 'session-a' });
    const theirs = manager.spawn({ mode: 'spawn', task: 'session B work', outsideContract: true, sessionId: 'session-b' });
    const unused = (): never => { throw new Error('no contract is read in this proof'); };
    const toolFor = (sessionId: string) => createAgentTool({
      manager, messageBus, configManager, projectRoot: '/synthetic/agents',
      contractRunner: { start: unused, list: unused, get: unused }, resolveSessionId: () => sessionId,
    });
    const a = toolFor('session-a');
    const listed = await a.execute({ mode: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain(mine.id);
    expect(listed.output).not.toContain(theirs.id);
    for (const mode of ['status', 'get', 'cancel', 'message', 'wait']) {
      const result = await a.execute({ mode, agentId: theirs.id, message: 'stop', timeoutMs: 1 });
      expect(`${mode}: ${result.success}`).toBe(`${mode}: false`);
      expect(result.output ?? '').not.toContain('session B work');
    }
    expect(manager.getStatus(theirs.id)?.status).not.toBe('cancelled');
    // The model cannot name another session for itself: the host's session wins.
    const spoofed = await a.execute({ mode: 'list', sessionId: 'session-b' });
    expect(spoofed.output).not.toContain(theirs.id);
  });
});
