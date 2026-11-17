/**
 * Loading a saved session over the live conversation: `/load`, the `/sessions` list and the picker
 * refuse while a turn runs, never clear the live conversation for a session they cannot read, and
 * move the session identity so later autosaves go to the loaded session.
 */
import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { registerSessionContentCommands } from '../../input/commands/session-content.ts';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';

const SAVED = {
  alpha: { meta: { title: 'Alpha', model: 'm-alpha', provider: 'p-alpha' }, messages: [{ role: 'user', content: 'from alpha' }, { role: 'assistant', content: 'alpha answer' }] },
  broken: { meta: { title: 'Broken' }, messages: [{ role: 'user', content: 'ok' }, { role: 'nonsense', content: 5 }] },
} as const;

function fixture(options: { generating: boolean }) {
  const conversation = new ConversationManager(() => 100);
  conversation.fromJSON({ messages: [{ role: 'user', content: 'live question' }, { role: 'assistant', content: 'live answer' }] as never[] });
  conversation.rebuildHistory();
  const printed: string[] = [];
  const pointers: string[] = [];
  const loads: string[] = [];
  const runtime = { sessionId: 'live-session', model: 'live-model', provider: 'live-provider' };
  const sessionManager = {
    load: (name: string) => {
      loads.push(name);
      const saved = SAVED[name as keyof typeof SAVED];
      if (!saved) throw new Error(`Session not found: ${name}`);
      return { meta: saved.meta, messages: saved.messages, agentRecords: [] };
    },
    list: () => Object.keys(SAVED).map((name) => ({ name, title: name, model: '', provider: '', timestamp: 1, messageCount: 2, filePath: `/${name}` })),
  } as unknown as SessionManager;
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    isGenerating: () => options.generating,
    session: {
      conversationManager: conversation,
      runtime,
      restoreTurnAnchors: () => 0,
      writeLastSessionPointer: (id: string) => { pointers.push(id); },
      sessionManager,
    },
    platform: {},
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerSessionContentCommands(registry);
  return { conversation, printed, pointers, loads, runtime, sessionManager, ctx, registry };
}

const texts = (conversation: ConversationManager): string => JSON.stringify(conversation.getMessageSnapshot());

describe('/load', () => {
  test('refuses while a turn runs and leaves the conversation and session id alone', async () => {
    const f = fixture({ generating: true });
    const before = texts(f.conversation);
    await f.registry.execute('load', ['alpha'], f.ctx);
    expect(f.printed.join('\n')).toContain('A turn is still running');
    expect(texts(f.conversation)).toBe(before);
    expect(f.runtime.sessionId).toBe('live-session');
  });

  test('a saved session with an unreadable message leaves the live conversation intact', async () => {
    const f = fixture({ generating: false });
    const before = texts(f.conversation);
    await f.registry.execute('load', ['broken'], f.ctx);
    expect(f.printed.join('\n')).toContain('Failed to load session');
    expect(texts(f.conversation)).toBe(before);
    expect(f.runtime.sessionId).toBe('live-session');
  });

  test('a good load replaces the conversation and moves the session identity to the loaded session', async () => {
    const f = fixture({ generating: false });
    await f.registry.execute('load', ['alpha'], f.ctx);
    expect(texts(f.conversation)).toContain('from alpha');
    expect(texts(f.conversation)).not.toContain('live question');
    expect(f.runtime.sessionId).toBe('alpha');
    expect(f.pointers).toEqual(['alpha']);
    expect(f.printed.join('\n')).toContain('Session loaded');
  });
});

describe('session picker load', () => {
  function picker(f: ReturnType<typeof fixture>, name: string): SessionPickerModal {
    const modal = new SessionPickerModal(f.sessionManager);
    modal.sessions = (f.sessionManager.list() as never[]);
    modal.selectedIndex = modal.sessions.findIndex((entry) => entry.name === name);
    return modal;
  }

  test('does not clear the live conversation for a session it cannot read', async () => {
    const f = fixture({ generating: false });
    const before = texts(f.conversation);
    expect(await picker(f, 'broken').loadSelected(f.ctx)).toBe(false);
    expect(texts(f.conversation)).toBe(before);
  });

  test('refuses while a turn runs, and says so', async () => {
    const f = fixture({ generating: true });
    const before = texts(f.conversation);
    const modal = picker(f, 'alpha');
    expect(await modal.loadSelected(f.ctx)).toBe(false);
    expect(modal.statusMessage).toContain('A turn is still running');
    expect(texts(f.conversation)).toBe(before);
    expect(f.loads).toEqual([]);
  });

  test('loads and moves the session identity when idle', async () => {
    const f = fixture({ generating: false });
    const modal = picker(f, 'alpha');
    expect(await modal.loadSelected(f.ctx)).toBe(true);
    expect(f.runtime.sessionId).toBe('alpha');
    expect(texts(f.conversation)).toContain('from alpha');
  });
});
