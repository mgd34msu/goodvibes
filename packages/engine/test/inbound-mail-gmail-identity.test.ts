import { describe, expect, test } from 'bun:test';
import { createInboundMailSourceFactory } from '../platform/src/platform/email/inbound/source-factory.ts';
import { InboundMailboxIdentityChangedError } from '../platform/src/platform/email/inbound/supervisor.ts';
import { resolveWatcherSettings } from '../platform/src/platform/email/inbound/index.ts';

describe('a Gmail source is bound to the mailbox the daemon booted with', () => {
  function build(values: Record<string, unknown>) {
    let built = 0;
    const factory = createInboundMailSourceFactory({
      getConfig: ((key: string) => values[key]) as never,
      secrets: { get: async () => null } as never,
      transport: {} as never,
      cursors: {} as never,
      settings: resolveWatcherSettings({ account: 'primary', mailbox: 'INBOX' } as never),
      gmail: async () => { built += 1; return null; },
    });
    const create = () => factory.create({
      kind: 'gmail', account: 'primary', mailbox: 'INBOX', sink: { deliver: async () => {} }, observer: {},
    } as never);
    return { create, built: () => built };
  }

  test('a rebuild after the owner changed the mailbox user is refused with the restart instruction', async () => {
    const values: Record<string, unknown> = { 'surfaces.email.user': 'a@gmail.example' };
    const { create, built } = build(values);
    await create();
    expect(built()).toBe(1);

    values['surfaces.email.user'] = 'someone@elsewhere.example';
    await expect(create()).rejects.toBeInstanceOf(InboundMailboxIdentityChangedError);
    expect(built()).toBe(1);
  });

  test('an unchanged mailbox still rebuilds', async () => {
    const { create, built } = build({ 'surfaces.email.user': 'a@gmail.example' });
    await create();
    await create();
    expect(built()).toBe(2);
  });
});
