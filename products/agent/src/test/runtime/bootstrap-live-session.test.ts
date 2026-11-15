import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createHostedSessionRegistry } from '@goodvibes-jev/engine/terminal-shell/hosted-session-registry';
import { composeAgentRuntimeState } from '../../runtime/bootstrap-core.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('the runtime the Agent bootstrap composes moves every session-keyed seam when a resume assigns sessionId', () => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-live-session-'));
  dirs.push(root);
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
  const calls: string[] = [];
  const ref = { value: 'boot' };
  const hosted = createHostedSessionRegistry();
  hosted.adopt('boot');
  const conversation = {} as never;
  const runtime = composeAgentRuntimeState(configManager, {
    ref,
    hostedSessions: hosted,
    conversation,
    registerConversation: (id) => { calls.push(`register:${id}`); },
    unregisterConversation: (id) => { calls.push(`unregister:${id}`); },
    rewindHost: { start: (id) => { calls.push(`rewind:${id}`); } },
    spine: { reopen: (input) => { calls.push(`reopen:${input.sessionId}`); } },
    project: root,
  });
  expect(runtime.sessionId).toBe('boot');
  runtime.sessionId = 'resumed';
  expect(runtime.sessionId).toBe('resumed');
  expect(ref.value).toBe('resumed');
  expect([...hosted.ids()]).toEqual(['resumed']);
  expect(calls).toEqual(['unregister:boot', 'register:resumed', 'rewind:resumed', 'reopen:resumed']);
  ref.value = 'other';
  expect(runtime.sessionId).toBe('other');
});
