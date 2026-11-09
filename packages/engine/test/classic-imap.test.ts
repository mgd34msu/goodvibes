import { afterEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { readImapRefusal, readImapCursorFailure, readImapDrafts } from '../platform/src/platform/email/imap-readings.js';
import { classifyServerRefusalOwned } from '../platform/src/platform/email/imap-open.js';
import { selectDraftsMailboxFrames } from '../platform/src/platform/email/imap-draft.js';
import { ImapClient } from '../platform/src/platform/email/imap-client.js';
import { makeFakeImapServer, connectSocket, serverWrite } from './_helpers/fake-imap-server.js';

let previous: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic unavailable decision chain'); });
  previous = installJudgmentPort(fake.port); installed = true; return fake.requests;
}
const under = <T>(policy: DecisionModelPolicy, operation: () => T) => withDecisionModelPolicy(() => policy, operation);

test.each(['Classic - Off', 'Preferred'] as const)('%s email diagnostics remain unknown instead of inventing semantic facts', async policy => {
  const requests = outage();
  await under(policy, async () => {
    const refusal = await readImapRefusal('The password was not rejected. Please wait.');
    expect(refusal).toMatchObject({ value: 'unknown', provenance: 'classic' }); refusal.assertCurrent();
    const attempted = requests.length;
    expect(attempted).toBe(policy === 'Preferred' ? 1 : 0);
    const cursor = await readImapCursorFailure('An unrelated state file could not be read.');
    expect(cursor).toMatchObject({ value: null, provenance: 'classic' }); cursor.assertCurrent();
    const drafts = await readImapDrafts([{ name: 'Novel/Drafts', delimiter: '/', attributes: [] }]);
    expect(drafts).toMatchObject({ value: null, provenance: 'classic' });
    expect(requests).toHaveLength(attempted);
  });
});

test('Classic retains protocol codes and the server-declared Drafts folder', async () => {
  const requests = outage();
  await under('Classic - Off', async () => {
    expect((await classifyServerRefusalOwned('[AUTHENTICATIONFAILED] rejected', 'server-unavailable')).value).toBe('authentication-rejected');
    expect((await classifyServerRefusalOwned('[LIMIT] busy', 'authentication-rejected')).value).toBe('server-unavailable');
    expect((await selectDraftsMailboxFrames(['* LIST (\\Drafts) "/" "[Gmail]/Drafts"'])).value).toBe('[Gmail]/Drafts');
    expect((await selectDraftsMailboxFrames(['* LIST () "/" "Novel/Drafts"'])).value).toBeNull();
  });
  expect(requests).toHaveLength(0);
});

test('Classic publication ownership survives failed-session cleanup and still revokes on account change', async () => {
  outage();
  await under('Classic - Off', async () => {
    const session = new AbortController(), account = new AbortController();
    const lease = await readImapRefusal('Request failed.', { signal: session.signal, publication: { signal: account.signal } });
    session.abort(); lease.assertCurrent();
    account.abort(); expect(lease.assertCurrent).toThrow();
  });
});

test('Preferred uncertainty remains a held reading rather than Classic fallback', async () => {
  const fake = fakePort(() => noulAnswer(0.5)); previous = installJudgmentPort(fake.port); installed = true;
  await under('Preferred', async () => {
    await expect(readImapRefusal('Request failed.')).rejects.toBeInstanceOf(Error);
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic ambiguous draft discovery sends no APPEND; explicit owner mailbox still works', async () => {
  const requests = outage(), commands: string[] = [];
  const server = await makeFakeImapServer(socket => {
    serverWrite(socket, '* OK synthetic IMAP server');
    let buffer = Buffer.alloc(0), literal: { tag: string; bytes: number } | undefined;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (literal) {
          if (buffer.length < literal.bytes + 2) return;
          buffer = buffer.subarray(literal.bytes + 2);
          serverWrite(socket, `${literal.tag} OK [APPENDUID 7 42] appended`); literal = undefined;
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 2); commands.push(line);
        const tag = line.split(' ')[0] ?? '';
        if (line.includes(' LOGIN ')) serverWrite(socket, `${tag} OK logged in`);
        else if (line.includes(' EXAMINE ')) serverWrite(socket, `${tag} OK [READ-ONLY] selected`);
        else if (line.includes(' LIST ')) { serverWrite(socket, '* LIST () "/" "Novel/Drafts"'); serverWrite(socket, `${tag} OK listed`); }
        else if (line.includes(' APPEND ')) {
          literal = { tag, bytes: Number(/\{(\d+)\}$/.exec(line)?.[1]) };
          serverWrite(socket, '+ ready for literal');
        }
      }
    });
  });
  const socket = await connectSocket(server.address.port);
  const client = new ImapClient({ socket, username: 'synthetic-only', password: 'synthetic-only', timeoutMs: 1000 });
  try {
    await under('Classic - Off', async () => {
      await client.open();
      const draft = { to: 'recipient@example.invalid', from: 'sender@example.invalid', subject: 'Synthetic draft', body: 'Unsent synthetic text.' };
      await expect(client.appendDraft(draft)).rejects.toMatchObject({ code: 'decision-models-disabled' });
      expect(commands.filter(command => command.includes(' APPEND '))).toEqual([]);
      await client.appendDraft({ ...draft, mailbox: 'OwnerSelectedDrafts' });
      expect(commands.filter(command => command.includes(' APPEND '))).toHaveLength(1);
    });
    expect(requests).toHaveLength(0);
  } finally { client.close(); server.close(); }
});
