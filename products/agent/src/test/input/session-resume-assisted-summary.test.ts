/**
 * The optional assisted summary after `/session resume`: a failing helper model is not an unhandled
 * rejection, and a summary that arrives after the owner moved to another session is not printed there.
 */
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { CommandContext } from '../../input/command-registry.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { createSessionSurface } from '@/runtime/index.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture(chat: () => Promise<string>) {
  const dir = makeProjectTempDir('gv-session-assisted');
  const sm = new SessionManager(dir, { surfaceRoot: 'agent' });
  sm.save('saved', [{ role: 'user', content: 'hi' }], {
    title: 'Saved', model: '', provider: '', timestamp: Date.now(), saveSource: 'user',
    returnContext: { activityLabel: 'editing', statusLabel: 'idle', toolCallCount: 0, toolResultCount: 0, lines: [] },
  } as never);
  const printed: string[] = [];
  const runtime = { sessionId: 'mine', model: 'm', provider: 'p' };
  const ctx = {
    session: {
      runtime,
      surface: createSessionSurface({ surfaceRoot: 'agent', workingDirectory: dir, homeDirectory: dir }),
      conversationManager: new ConversationManager(() => 100),
      sessionManager: sm,
      writeLastSessionPointer: () => {},
    },
    provider: {}, workspace: {}, ops: {}, extensions: {},
    platform: { configManager: { get: (key: string) => (key === 'helper.enabled' ? true : 'assisted') } },
    clients: { providerApi: { selectModel: async () => { throw new Error('none'); }, createHelperModel: () => ({ chat }) } },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
  return { dir, printed, runtime, ctx };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('/session resume assisted summary', () => {
  test('a failing helper model leaves the resume intact and raises no unhandled rejection', async () => {
    const f = fixture(async () => { throw new Error('helper down'); });
    try {
      await handleSessionWorkflowCommand(['resume', 'saved'], f.ctx);
      await settle();
      expect(f.runtime.sessionId).toBe('saved');
      expect(f.printed.join('\n')).not.toContain('Assist');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('a summary that arrives after the owner moved to another session is not printed', async () => {
    let answer: (text: string) => void = () => {};
    const f = fixture(() => new Promise<string>((resolve) => { answer = resolve; }));
    try {
      await handleSessionWorkflowCommand(['resume', 'saved'], f.ctx);
      f.runtime.sessionId = 'somewhere-else';
      answer('Look at the failing test first.');
      await settle();
      expect(f.printed.join('\n')).not.toContain('Assist');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('a summary for the session still open is printed', async () => {
    const f = fixture(async () => 'Look at the failing test first.');
    try {
      await handleSessionWorkflowCommand(['resume', 'saved'], f.ctx);
      await settle();
      expect(f.printed.join('\n')).toContain('Assist Look at the failing test first.');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
