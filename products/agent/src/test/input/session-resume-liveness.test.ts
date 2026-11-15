/**
 * `/session resume` asks before taking over a session another running Agent has marked open.
 */
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { writeLivenessMarker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createSessionSurface } from '@/runtime/index.ts';
import { ConversationManager } from '../../core/conversation.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const dir = makeProjectTempDir('gv-session-liveness');
  const sm = new SessionManager(dir, { surfaceRoot: 'agent' });
  sm.save('shared', [{ role: 'user', content: 'hi' }], { title: 'Shared', model: '', provider: '', timestamp: Date.now(), saveSource: 'user' });
  const surface = createSessionSurface({ surfaceRoot: 'agent', workingDirectory: dir, homeDirectory: dir });
  const printed: string[] = [];
  const announced: string[] = [];
  const pointerWrites: string[] = [];
  const runtime = { sessionId: 'mine', model: 'm', provider: 'p' };
  const ctx = {
    session: {
      runtime,
      surface,
      conversationManager: new ConversationManager(() => 100),
      sessionManager: sm,
      writeLastSessionPointer: (id: string) => { pointerWrites.push(id); },
      announceSessionResumed: (id: string, turns: number) => { announced.push(`${id}:${turns}`); },
    },
    provider: {}, workspace: {}, ops: {}, extensions: {},
    platform: { configManager: { get: () => 'off' } },
    clients: { providerApi: { selectModel: async () => { throw new Error('none'); } } },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
  return { dir, surface, printed, announced, pointerWrites, runtime, ctx };
}

describe('/session resume and another running terminal', () => {
  test('asks first when another live process holds the session, and --force goes ahead', async () => {
    const f = fixture();
    try {
      // The parent process is alive and is not this one.
      writeLivenessMarker(f.surface, 'shared', process.ppid);
      await handleSessionWorkflowCommand(['resume', 'shared'], f.ctx);
      expect(f.printed.join('\n')).toContain('appears open in another terminal');
      expect(f.runtime.sessionId).toBe('mine');
      expect(f.announced).toEqual([]);
      expect(f.pointerWrites).toEqual([]);
      await handleSessionWorkflowCommand(['resume', 'shared', '--force'], f.ctx);
      expect(f.runtime.sessionId).toBe('shared');
      expect(f.announced).toEqual(['shared:1']);
      // The last-session pointer follows the resume, so a restart reopens this conversation.
      expect(f.pointerWrites).toEqual(['shared']);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('a resume lets go of the hosted session of the conversation it replaced, and a refused one does not', async () => {
    const f = fixture();
    try {
      let abandoned = 0;
      (f.ctx as { abandonHostedSession?: () => void }).abandonHostedSession = () => { abandoned += 1; };
      writeLivenessMarker(f.surface, 'shared', process.ppid);
      await handleSessionWorkflowCommand(['resume', 'shared'], f.ctx);
      expect(abandoned).toBe(0);
      await handleSessionWorkflowCommand(['resume', 'shared', '--force'], f.ctx);
      expect(abandoned).toBe(1);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('this process\'s own marker never blocks a resume', async () => {
    const f = fixture();
    try {
      writeLivenessMarker(f.surface, 'shared', process.pid);
      await handleSessionWorkflowCommand(['resume', 'shared'], f.ctx);
      expect(f.runtime.sessionId).toBe('shared');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
