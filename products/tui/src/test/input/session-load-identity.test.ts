/**
 * `/load` moves the session identity to the loaded session, so the next autosave goes to it and not
 * over the session that was open, and it does not take over a session another terminal holds.
 */
import { describe, expect, test } from 'bun:test';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { checkSessionLiveness, writeLivenessMarker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { registerSessionContentCommands } from '../../input/commands/session-content.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const dir = makeProjectTempDir('gv-tui-session-load');
  const sm = new SessionManager(dir, { surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT });
  sm.save('other', [{ role: 'user', content: 'from other' }, { role: 'assistant', content: 'other answer' }], { title: 'Other', model: '', provider: '', timestamp: Date.now(), saveSource: 'user' });
  const surface = makeTestSurface(dir);
  const conversation = new ConversationManager(() => 100);
  conversation.fromJSON({ messages: [{ role: 'user', content: 'live question' }] as never[] });
  conversation.rebuildHistory();
  const printed: string[] = [];
  const runtime = { sessionId: 'open-session', model: 'm', provider: 'p' };
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    isGenerating: () => false,
    session: { conversationManager: conversation, runtime, sessionManager: sm },
    workspace: { surface, sessionManager: sm },
    ops: { agentManager: { clear: () => {}, importState: () => {} } },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerSessionContentCommands(registry);
  return { sm, surface, conversation, printed, runtime, ctx, registry };
}

describe('/load session identity', () => {
  test('a load moves the identity to the loaded session and its liveness marker with it', async () => {
    const f = fixture();
    writeLivenessMarker(f.surface, 'open-session');
    await f.registry.execute('load', ['other'], f.ctx);
    expect(f.printed.join('\n')).toContain('Session loaded: other');
    expect(f.runtime.sessionId).toBe('other');
    expect(JSON.stringify(f.conversation.getMessageSnapshot())).toContain('from other');
    expect(checkSessionLiveness(f.surface, 'other')).toEqual({ live: true, pid: process.pid });
    expect(checkSessionLiveness(f.surface, 'open-session').live).toBe(false);
  });

  test('a session another live terminal holds is refused and nothing changes', async () => {
    const f = fixture();
    writeLivenessMarker(f.surface, 'other', process.ppid);
    await f.registry.execute('load', ['other'], f.ctx);
    expect(f.printed.join('\n')).toContain('--force');
    expect(f.runtime.sessionId).toBe('open-session');
    expect(JSON.stringify(f.conversation.getMessageSnapshot())).toContain('live question');
  });
});
