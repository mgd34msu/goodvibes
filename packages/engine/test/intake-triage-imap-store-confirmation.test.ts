/**
 * A tagged OK from UID STORE is not enough: the server must also report the
 * flag on the message, or the message was never tagged.
 */
import { EventEmitter } from 'node:events';
import { expect, test } from 'bun:test';
import { imapStoreFlagOverTls, type ImapSocketLike, type ImapStoreArgs } from '../platform/src/platform/intake/triage/tagger/imap.js';

function server(storeReply: string[]) {
  const events = new EventEmitter();
  const socket = { setEncoding() {}, setTimeout() {}, on: events.on.bind(events), destroy() {}, write(line: string) {
    const tag = line.split(' ')[0];
    queueMicrotask(() => {
      if (line.includes('SELECT')) events.emit('data', '* OK [UIDVALIDITY 7] current\r\n');
      if (line.includes('UID STORE')) for (const reply of storeReply) events.emit('data', `${reply}\r\n`);
      events.emit('data', `${tag} OK done\r\n`);
    });
  } } as ImapSocketLike;
  return () => { queueMicrotask(() => events.emit('data', '* OK ready\r\n')); return socket; };
}

const args = (): ImapStoreArgs => ({
  host: 'imap.invalid', port: 993, user: 'u', password: 'p', mailbox: 'Inbox', uid: '42', flag: 'GoodVibes_Spam', uidValidity: 7,
  signal: new AbortController().signal, assertCurrent() {},
});

test('a STORE whose message no longer exists is reported, not counted as tagged', async () => {
  await expect(imapStoreFlagOverTls(args(), server([]))).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
});

test('a STORE that reports a different flag set is reported', async () => {
  await expect(imapStoreFlagOverTls(args(), server(['* 3 FETCH (FLAGS (\\Seen))']))).rejects.toThrow('flag not applied');
});

test('a STORE that reports the flag on the message succeeds', async () => {
  await imapStoreFlagOverTls(args(), server(['* 3 FETCH (FLAGS (\\Seen goodvibes_spam))']));
});
