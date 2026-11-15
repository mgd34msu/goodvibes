import { expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import { connectSocket, makeFakeImapServer, serverWrite } from './_helpers/fake-imap-server.ts';
import { createTriageTagger } from '../platform/src/platform/intake/triage/tagger/index.ts';
import { captureTags } from '../platform/src/platform/intake/triage/tagger/shared.ts';
import { applySlackTags } from '../platform/src/platform/intake/triage/tagger/slack.ts';
import { applyDiscordTags } from '../platform/src/platform/intake/triage/tagger/discord.ts';
import { imapStoreFlagWithMailClient, makeRetryingImapStoreFlag, ImapStoreError, type ImapStoreArgs } from '../platform/src/platform/intake/triage/tagger/imap.ts';
const guard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
function http(responses: Array<Response | (() => Response)>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); const response = responses.shift(); if (!response) throw new Error('unexpected call'); return typeof response === 'function' ? response() : response; }) as typeof fetch;
  return { calls, fetcher };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
test('fixed canonical labels refuse heuristic substrings and arbitrary flags', () => {
  expect(captureTags(['GoodVibes/Spam', 'GoodVibes/Spam'])).toEqual(['GoodVibes/Spam']);
  for (const tag of ['spam', 'NotSpam', 'GoodVibes/spam', '\\Seen', 'GoodVibes/Priority ']) expect(() => captureTags([tag])).toThrow();
});
test('Slack reactions.add exact target, idempotence and no redirects', async () => {
  const f = http([response({ ok: false, error: 'already_reacted' })]);
  await applySlackTags({ channel: 'C123', timestamp: '123.456' }, ['GoodVibes/Priority'], 'synthetic', guard(), f.fetcher);
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.init.redirect).toBe('error');
  expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ channel: 'C123', timestamp: '123.456', name: 'rotating_light' });
});
test.each([response({ ok: false, error: 'missing_scope' }), response({ ok: true }, 403)])('Slack hard refusals do not continue', async failed => {
  const f = http([failed]);
  await expect(applySlackTags({ channel: 'C123', timestamp: '123.456' }, ['GoodVibes/Spam', 'GoodVibes/Normal'], 'synthetic', guard(), f.fetcher)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});
test('Discord real observed forum tags merge, preserving unrelated applied_tags', async () => {
  const f = http([response({ id: '123', type: 11, parent_id: '456', applied_tags: ['789'] }), response({ id: '456', type: 15 }), response({})]);
  await applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Spam'], 'synthetic', guard(), { 'GoodVibes/Spam': '890' }, f.fetcher);
  expect(f.calls.map(call => call.init.method ?? 'GET')).toEqual(['GET', 'GET', 'PATCH']);
  expect(JSON.parse(String(f.calls[2]!.init.body))).toEqual({ applied_tags: ['789', '890'] });
});
test.each([response({}, 403), response({ id: '123', type: 11, parent_id: '456' }), response({ id: 'wrong', type: 11 })])('Discord failed or malformed observations never PATCH', async first => {
  const f = http([first, response({ id: '456', type: 15 })]);
  await expect(applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Spam'], 'synthetic', guard(), { 'GoodVibes/Spam': '890' }, f.fetcher)).rejects.toThrow();
  expect(f.calls.some(call => call.init.method === 'PATCH')).toBe(false);
});
test('Discord DM with a forum mapping remains a reaction', async () => {
  const f = http([response({ id: '123', type: 1 }), new Response(null, { status: 204 })]);
  await applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Normal'], 'synthetic', guard(), { 'GoodVibes/Normal': '890' }, f.fetcher);
  expect(f.calls[1]!.init.method).toBe('PUT'); expect(f.calls[1]!.url).toContain('/messages/234/reactions/');
});
test('Discord revocation after GET prevents PATCH', async () => {
  const abort = new AbortController(); const f = http([response({ id: '123', type: 11, parent_id: '456', applied_tags: [] }), () => { abort.abort(); return response({ id: '456', type: 15 }); }]);
  await expect(applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Spam'], 'synthetic', { signal: abort.signal, assertCurrent() {} }, { 'GoodVibes/Spam': '890' }, f.fetcher)).rejects.toThrow();
  expect(f.calls).toHaveLength(2);
});
/** A mail server that answers the label write: EXAMINE and SELECT report `validity`, STORE reports `storeReply`. */
async function imapServer(options: { validity?: number; selectValidity?: number; storeReply?: readonly string[]; storeStatus?: 'OK' | 'NO' } = {}) {
  const commands: string[] = [];
  const server = await makeFakeImapServer((socket) => {
    serverWrite(socket, '* OK ready');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end = buffer.indexOf('\r\n');
      while (end !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        commands.push(line);
        const [tag = '', verb = '', sub = ''] = line.split(' ');
        if (verb === 'EXAMINE') { serverWrite(socket, '* 3 EXISTS'); serverWrite(socket, `* OK [UIDVALIDITY ${options.validity ?? 7}] ok`); serverWrite(socket, `${tag} OK [READ-ONLY] done`); }
        else if (verb === 'SELECT') { serverWrite(socket, `* OK [UIDVALIDITY ${options.selectValidity ?? options.validity ?? 7}] ok`); serverWrite(socket, `${tag} OK [READ-WRITE] done`); }
        else if (verb === 'UID' && sub === 'STORE') { for (const reply of options.storeReply ?? ['* 3 FETCH (UID 42 FLAGS (\\Seen GoodVibes_Spam))']) serverWrite(socket, reply); serverWrite(socket, `${tag} ${options.storeStatus ?? 'OK'} done`); }
        else if (verb === 'LOGOUT') { serverWrite(socket, '* BYE'); serverWrite(socket, `${tag} OK done`); }
        else serverWrite(socket, `${tag} OK done`);
        end = buffer.indexOf('\r\n');
      }
    });
  });
  let connects = 0;
  const connect = (): Promise<Socket> => { connects += 1; return connectSocket(server.address.port); };
  return { commands, connect, connects: () => connects, close: () => server.close() };
}
const args = (): ImapStoreArgs => ({ host: '127.0.0.1', port: 993, user: 'a"b', password: 'c\\d', mailbox: 'Inbox', uid: '42', flag: 'GoodVibes_Spam', uidValidity: 7, ...guard() });
const sent = (commands: readonly string[]) => commands.map(line => line.replace(/^\S+ /, ''));

test('IMAP label: one connection, quoted login, EXAMINE, SELECT, every keyword in one UID STORE, LOGOUT', async () => {
  const f = await imapServer({ storeReply: ['* 3 FETCH (UID 42 FLAGS (GoodVibes_Spam GoodVibes_Priority))'] });
  try {
    await imapStoreFlagWithMailClient(f.connect)({ ...args(), flags: ['GoodVibes_Spam', 'GoodVibes_Priority'] });
    expect(f.connects()).toBe(1);
    expect(sent(f.commands)).toEqual(['LOGIN "a\\"b" "c\\\\d"', 'EXAMINE Inbox', 'SELECT Inbox', 'UID STORE 42 +FLAGS (GoodVibes_Spam GoodVibes_Priority)', 'LOGOUT']);
  } finally { f.close(); }
});
test('IMAP label: a mailbox reset between listing and writing prevents STORE', async () => {
  for (const options of [{ validity: 8 }, { selectValidity: 8 }]) {
    const f = await imapServer(options);
    try {
      await expect(imapStoreFlagWithMailClient(f.connect)(args())).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
      expect(f.commands.some(line => line.includes('STORE'))).toBe(false);
    } finally { f.close(); }
  }
});
test('IMAP label: a STORE the message did not answer (gone, or keyword refused) is not counted as written', async () => {
  for (const storeReply of [[], ['* 3 FETCH (UID 42 FLAGS (\\Seen))']]) {
    const f = await imapServer({ storeReply });
    try { await expect(imapStoreFlagWithMailClient(f.connect)(args())).rejects.toMatchObject({ name: 'ImapStoreError', transient: false }); }
    finally { f.close(); }
  }
  const refused = await imapServer({ storeStatus: 'NO' });
  try { await expect(imapStoreFlagWithMailClient(refused.connect)(args())).rejects.toMatchObject({ transient: false }); }
  finally { refused.close(); }
});
// The UID and the keywords go on the command line unquoted: a wildcard would tag
// the whole mailbox, a system flag would mark mail read or deleted, a space or
// paren would inject another flag. Credentials carry no control characters (a
// mailbox name is modified UTF-7, so a line break in it never reaches the wire).
test.each([
  { uid: '1:*' }, { uid: '*' }, { uid: '1,2' }, { uid: '1)\r\nA9 DELETE x' }, { uid: '0' },
  { flags: ['\\Seen'] }, { flags: ['\\Deleted'] }, { flags: ['Spam Junk'] }, { flags: ['Spam)'] }, { flags: [''] }, { flags: [] },
  { password: 'x\r' }, { password: 'x\n' }, { password: 'x\x00' }, { user: 'bad\x7fuser' },
] as Partial<ImapStoreArgs>[])('IMAP label refuses %p and writes nothing', async (bad) => {
  const f = await imapServer();
  try {
    await expect(imapStoreFlagWithMailClient(f.connect)({ ...args(), ...bad })).rejects.toMatchObject({ name: 'ImapStoreError', transient: false });
    expect(f.commands.some(line => line.includes('STORE'))).toBe(false);
  } finally { f.close(); }
});
test('IMAP label: a refusal never retries; an unreachable server retries a bounded number of times', async () => {
  let calls = 0;
  await expect(makeRetryingImapStoreFlag(async () => { calls++; throw new ImapStoreError('NO', false); }, { sleep: async () => {} })(args())).rejects.toThrow(); expect(calls).toBe(1);
  calls = 0;
  const unreachable = imapStoreFlagWithMailClient(async () => { calls++; throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); });
  await expect(makeRetryingImapStoreFlag(unreachable, { sleep: async () => {} })(args())).rejects.toMatchObject({ transient: true }); expect(calls).toBe(3);
});

test('unsupported provider never falls through to an email writer or resolves credentials', () => {
  let reads = 0;
  expect(() => createTriageTagger({ provider: 'unsupported' as never, accountScopeId: 'account', credentialKey: 'synthetic', credentials: { resolveRef: async () => null, resolveConfigSecret: async () => { reads++; return 'synthetic'; } }, captureCredential() { throw new Error('No credential capture'); }, ...guard() })).toThrow('supported provider');
  expect(reads).toBe(0);
});

test('Discord without a forum mapping uses exactly one reaction request and no channel PATCH', async () => {
  const f = http([new Response(null, { status: 204 })]);
  await applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Spam'], 'synthetic', guard(), {}, f.fetcher);
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.init.method).toBe('PUT'); expect(f.calls[0]!.url).toContain('/reactions/');
});
