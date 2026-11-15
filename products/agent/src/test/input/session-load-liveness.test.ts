/** `/load` does not take over a session another running terminal holds, and moves the liveness marker with the identity. */
import { describe, expect, test } from 'bun:test';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { checkSessionLiveness, writeLivenessMarker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createSessionSurface } from '@/runtime/index.ts';
import { ConversationManager } from '../../core/conversation.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { loadSavedSessionIntoLive } from '../../input/commands/session-load.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const dir = makeProjectTempDir('gv-session-load-liveness');
  const sm = new SessionManager(dir, { surfaceRoot: 'agent' });
  sm.save('shared', [{ role: 'user', content: 'hi' }], { title: 'Shared', model: '', provider: '', timestamp: Date.now(), saveSource: 'user' });
  const surface = createSessionSurface({ surfaceRoot: 'agent', workingDirectory: dir, homeDirectory: dir });
  const runtime = { sessionId: 'mine', model: 'm', provider: 'p' };
  const ctx = {
    isGenerating: () => false,
    session: {
      runtime,
      surface,
      conversationManager: new ConversationManager(() => 100),
      restoreTurnAnchors: () => 0,
      writeLastSessionPointer: () => {},
    },
  } as unknown as CommandContext;
  return { sm, surface, runtime, ctx };
}

describe('loading a saved session and another running terminal', () => {
  test('refuses a session another live process holds, names the explicit way, and changes nothing', () => {
    const f = fixture();
    // The parent process is alive and is not this one.
    writeLivenessMarker(f.surface, 'shared', process.ppid);
    expect(() => loadSavedSessionIntoLive(f.ctx, f.sm, 'shared')).toThrow(/another terminal.*--force/s);
    expect(f.runtime.sessionId).toBe('mine');
  });

  test('a load that goes ahead marks the new session as open here and clears the one it left', () => {
    const f = fixture();
    writeLivenessMarker(f.surface, 'mine');
    loadSavedSessionIntoLive(f.ctx, f.sm, 'shared');
    expect(f.runtime.sessionId).toBe('shared');
    expect(checkSessionLiveness(f.surface, 'shared')).toEqual({ live: true, pid: process.pid });
    expect(checkSessionLiveness(f.surface, 'mine').live).toBe(false);
  });
});
