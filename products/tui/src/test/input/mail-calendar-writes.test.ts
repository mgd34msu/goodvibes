import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerMailRuntimeCommands, renderInboxList } from '../../input/commands/mail-runtime.ts';
import { registerCalendarRuntimeCommands } from '../../input/commands/calendar-runtime.ts';

interface Invocation { readonly method: string; readonly body: unknown }

function setup(options: { invokedByModel?: boolean; failFirstSend?: boolean } = {}) {
  const invocations: Invocation[] = [];
  const printed: string[] = [];
  let sendCalls = 0;
  const gatewayMethods = {
    list: () => [],
    invoke: async (method: string, input: { body?: unknown }) => {
      invocations.push({ method, body: input.body });
      if (method === 'email.send') {
        sendCalls += 1;
        if (options.failFirstSend && sendCalls === 1) throw new Error('timed out');
        return { messageId: 'm1', sentAt: 'now' };
      }
      if (method === 'calendar.events.create') return { eventId: 'e1', createdAt: 'now' };
      if (method === 'email.draft.create') return { draftId: 'd1', mailbox: '[Gmail]/Drafts' };
      return {};
    },
  };
  const ctx = {
    print: (text: string) => { printed.push(text); },
    workspace: { gatewayMethods },
    invokedByModel: options.invokedByModel,
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerMailRuntimeCommands(registry);
  registerCalendarRuntimeCommands(registry);
  const run = async (name: string, args: string[]) => {
    printed.length = 0;
    await registry.execute(name, args, ctx);
    return printed.join('\n');
  };
  return { run, invocations, sends: () => invocations.filter((entry) => entry.method === 'email.send').length };
}

const SEND = ['send', 'a@b.com', '|', 'Hi', '|', 'Body', '--confirm'];

describe('/mail send', () => {
  test('the same confirmed message is not sent twice from one session unless --again is given', async () => {
    const f = setup();
    expect(await f.run('mail', SEND)).toContain('Sent to a@b.com');
    expect(await f.run('mail', SEND)).toContain('was not sent again');
    expect(f.sends()).toBe(1);
    expect(await f.run('mail', [...SEND, '--again'])).toContain('Sent to a@b.com');
    expect(f.sends()).toBe(2);
  });

  test('a send that timed out is not blindly repeated', async () => {
    const f = setup({ failFirstSend: true });
    expect(await f.run('mail', SEND)).toContain('timed out');
    expect(await f.run('mail', SEND)).toContain('outcome is unknown');
    expect(f.sends()).toBe(1);
  });

  test('a model-invoked confirmed send is refused and reaches no daemon verb', async () => {
    const f = setup({ invokedByModel: true });
    expect(await f.run('mail', SEND)).toContain('must be typed by the user');
    expect(f.sends()).toBe(0);
  });

  test('a draft on a server without UIDPLUS names the folder, never "undefined"', async () => {
    const f = setup();
    const text = await f.run('mail', ['draft', 'a@b.com', '|', 'Hi', '|', 'Body']);
    expect(text).toContain('[Gmail]/Drafts');
    expect(text).not.toContain('undefined');
  });
});

describe('/calendar create', () => {
  const CREATE = ['create', 'Review', '|', '2026-08-01T14:00:00Z', '|', '2026-08-01T15:00:00Z', '--confirm'];

  test('an identical event is not created twice unless --again is given', async () => {
    const f = setup();
    expect(await f.run('calendar', CREATE)).toContain('Created "Review"');
    expect(await f.run('calendar', CREATE)).toContain('was not created again');
    expect(f.invocations.filter((entry) => entry.method === 'calendar.events.create')).toHaveLength(1);
  });

  test('a model-invoked confirmed create is refused', async () => {
    const f = setup({ invokedByModel: true });
    expect(await f.run('calendar', CREATE)).toContain('must be typed by the user');
    expect(f.invocations.filter((entry) => entry.method === 'calendar.events.create')).toHaveLength(0);
  });
});

describe('inbox rendering keeps what the contract says', () => {
  test('a page whose every message was unreadable is not called empty', () => {
    const text = renderInboxList([], { total: 3, unreadable: [{ uid: 7, detail: 'bad FETCH answer' }] });
    expect(text).not.toContain('empty');
    expect(text).toContain('could not be read');
    expect(text).toContain('bad FETCH answer');
    expect(text).toContain('3 matched');
  });

  test('a short page shows how many matched and notes unreadable ones', () => {
    const text = renderInboxList(
      [{ uid: 1, from: 'a', subject: 's', date: 'd', unread: false, bodyPreview: '' }],
      { total: 5, unreadable: [{ detail: 'x' }] },
    );
    expect(text).toContain('1 message of 5');
    expect(text).toContain('not deleted');
  });
});
