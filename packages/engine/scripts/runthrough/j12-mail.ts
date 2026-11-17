/**
 * Journey 12: inbound mail through the one mailbox reader.
 *
 * The mailbox is a scripted IMAP server on loopback (the repository's own
 * fake mailbox from the engine test helpers; nothing reaches a real mail
 * server), with a made-up account. The daemon's mailbox reader is pointed at
 * it with the owner's settings (`surfaces.email.*`, `imap.secure` false, which
 * the product allows only for a loopback host) and the password is stored the
 * way the owner stores it (`goodvibes-daemon config set surfaces.email.password`,
 * the daemon's secret tier). Notices go to the owner's channel, a Mattermost
 * surface whose server is a loopback recorder; the owner reaches the daemon on
 * it once, which is the route notices take.
 *
 *  - one delivered message is announced to the owner exactly once and
 *    recorded once;
 *  - with no decision model and no screening consent the message is still in
 *    the mail inbox (channels.inbox.list), once, labelled not screened;
 *  - nothing more is announced while nothing more arrives;
 *  - after a daemon restart the same message is not announced again, and a
 *    message that arrived while the daemon was down is announced once.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DAEMON_ENTRY, Journey, api, invoke, operatorToken, runProduct, short, stage, startDaemon, waitFor, type Daemon } from './lib.ts';
import { makeFakeMailbox } from '../../test/_helpers/fake-imap-mailbox.ts';

const journey = new Journey('j12-mail');
const ACCOUNT = 'owner@rt-mail.test';

const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
const mattermost = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const text = request.method === 'POST' ? await request.text() : '';
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { raw: text }; }
    posts.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/users/me')) return Response.json({ id: 'rt-bot', username: 'rtbot' });
    return Response.json({ id: `post-${posts.length}`, create_at: Date.now() }, { status: 201 });
  },
});
const mailbox = await makeFakeMailbox();
const env = { MATTERMOST_BOT_TOKEN: 'rt-local-bot-token', MATTERMOST_WEBHOOK_SECRET: 'rt-local-hook-secret' };
const s = await stage('j12', { extraSettings: { surfaces: { mattermost: { enabled: true, baseUrl: `http://127.0.0.1:${mattermost.port}`, teamId: 'team-rt', defaultChannelId: 'ch-rt' } } } });
s.home.allow(mattermost.port!);
s.home.allow(mailbox.port);
await s.daemon.stop();
let daemon: Daemon = await startDaemon(s.home, [], env);

const daemonSet = (key: string, value: string) => runProduct(s.home, DAEMON_ENTRY, ['config', 'set', key, value]);
/** Notice posts to the owner's channel that name this subject. */
const noticesAbout = (subject: string) => posts.filter((post) => post.path === '/api/v4/posts' && String(post.body.message ?? '').includes(subject));
/** Inbound mail records the daemon keeps for this subject (its own record log in the daemon home), one per message uid. */
const recordsAbout = (subject: string): number => {
  const file = join(s.home.daemonHome, 'email-inbound-records.log.jsonl');
  if (!existsSync(file)) return 0;
  const uids = new Set<number>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const put = (JSON.parse(line) as { put?: { subject?: string; uid?: number } }).put;
      if (put?.subject === subject && typeof put.uid === 'number') uids.add(put.uid);
    } catch { /* a torn last line */ }
  }
  return uids.size;
};
/** The mail inbox's email rows naming this subject (channels.inbox.list), as the web UI and the apps read them. */
const inboxRowsAbout = async (token: string, subject: string): Promise<{ rows: Array<Record<string, unknown>>; text: string }> => {
  const listed = await api(daemon, token, 'GET', '/api/channels/inbox?provider=email&limit=100');
  const items = ((listed.body as { items?: Array<Record<string, unknown>> } | null)?.items ?? []);
  return { rows: items.filter((item) => JSON.stringify(item).includes(subject)), text: `${listed.status} ${listed.text}` };
};
/** The notice outcome the daemon recorded for this subject (latest). */
const noticeStatusOf = (subject: string): string => {
  const file = join(s.home.daemonHome, 'email-inbound-records.log.jsonl');
  if (!existsSync(file)) return 'none';
  let status = 'none';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const put = (JSON.parse(line) as { put?: { subject?: string; noticeStatus?: string } }).put;
      if (put?.subject === subject && put.noticeStatus) status = put.noticeStatus;
    } catch { /* a torn last line */ }
  }
  return status;
};

try {
  const token = operatorToken(s.home);
  // The owner's channel: allowlisted, and the owner reaches the daemon on it once (the notice route).
  const policy = await api(daemon, token, 'POST', '/api/channels/policies/mattermost', { allowlistUserIds: ['U-OWNER'], allowDirectMessages: true, dmPolicy: 'allow', requireMention: false });
  s.model.scriptWrapped('RTJ12HELLO', [{ text: 'RTJ12 hello back.' }]);
  const hello = await fetch(`${daemon.baseUrl}/webhook/mattermost`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goodvibes-mattermost-token': env.MATTERMOST_WEBHOOK_SECRET },
    body: JSON.stringify({ channel_id: 'dm-U-OWNER', channel_type: 'D', user_id: 'U-OWNER', user_name: 'owner', post_id: 'post-owner-1', text: 'RTJ12HELLO hi' }),
  });
  const answered = await waitFor(() => posts.some((post) => post.path === '/api/v4/posts' && post.body.message === 'RTJ12 hello back.') ? true : undefined, 30_000);
  journey.check('the owner reaches the daemon on a channel once (the route notices take)', 'POST /api/channels/policies/mattermost; POST /webhook/mattermost from U-OWNER',
    `policy ${policy.status}; message ${hello.status}; answered ${answered === true}`, policy.status === 200 && hello.status === 200 && answered === true);

  // The owner's mailbox settings and password, as the owner sets them.
  const written = [
    await daemonSet('surfaces.email.host', '127.0.0.1'),
    await daemonSet('surfaces.email.user', ACCOUNT),
    await daemonSet('surfaces.email.imap.port', String(mailbox.port)),
    await daemonSet('surfaces.email.imap.secure', 'false'),
    await daemonSet('surfaces.email.password', 'rt-made-up-mail-password'),
    await daemonSet('surfaces.email.inbound.enabled', 'true'),
    // The setting holds a JSON array as text, so the value given is that text, quoted.
    await daemonSet('surfaces.email.inbound.accounts', JSON.stringify(JSON.stringify([ACCOUNT]))),
  ];
  await daemon.stop();
  daemon = await startDaemon(s.home, [], env);
  const token2 = operatorToken(s.home);
  const connected = await waitFor(() => mailbox.connectionCount > 0 && mailbox.commands.some((line) => /EXAMINE|SELECT/i.test(line)) ? true : undefined, 30_000);
  const status = await invoke(daemon, token2, 'email.inbound.status', {});
  const settingsFile = join(s.home.daemonHome, 'settings.json');
  const passwordInSettings = existsSync(settingsFile) && readFileSync(settingsFile, 'utf8').includes('rt-made-up-mail-password');
  journey.check('the mailbox reader signs in to the loopback mailbox with the stored password', 'goodvibes-daemon config set surfaces.email.* (host 127.0.0.1, imap.secure false), surfaces.email.password; restart; email.inbound.status',
    `config set ${written.map((run) => run.code).join(',')}${written.some((run) => run.code !== 0) ? ` ${short(written.filter((run) => run.code !== 0).map((run) => run.stdout + run.stderr).join(' | '), 300)}` : ''}; `
      + `password in settings file ${passwordInSettings}; connections ${mailbox.connectionCount}; commands ${short(mailbox.commands.map((line) => line.replace(/LOGIN .*/i, 'LOGIN <redacted>')).slice(0, 8), 300)}; status ${status.status} ${short(status.text, 400)}`,
    written.every((run) => run.code === 0) && !passwordInSettings && connected === true);

  // One message arrives.
  const subject = 'RTJ12 your parcel ships today';
  mailbox.deliver(subject);
  const announced = await waitFor(() => noticesAbout(subject).length > 0 ? true : undefined, 60_000, 500);
  await Bun.sleep(3_000);
  journey.check('a delivered message is announced to the owner once and recorded once', `deliver "${subject}" to the mailbox; the owner's channel; the daemon's inbound records`,
    `notices ${noticesAbout(subject).length} ${short(noticesAbout(subject).map((post) => post.body.message), 300)}; records naming it ${recordsAbout(subject)}`,
    announced === true && noticesAbout(subject).length === 1 && recordsAbout(subject) === 1);

  // The same message is in the mail inbox once, labelled as not screened (no decision model, no screening consent).
  const inMailInbox = await waitFor(async () => {
    const found = await inboxRowsAbout(token2, subject);
    return found.rows.length > 0 ? found : undefined;
  }, 30_000, 500) ?? await inboxRowsAbout(token2, subject);
  journey.check('the message is in the mail inbox once, labelled not screened', 'GET /api/channels/inbox?provider=email',
    `rows naming it ${inMailInbox.rows.length} ${short(inMailInbox.rows, 400)}; answer ${short(inMailInbox.text, 600)}`,
    inMailInbox.rows.length === 1 && String(inMailInbox.rows[0]!.subject ?? inMailInbox.rows[0]!.subjectPreview ?? '').startsWith(`[Not screened] ${subject}`));

  // Nothing more arrives: nothing more is announced.
  await Bun.sleep(8_000);
  journey.check('nothing more is announced while nothing more arrives', 'wait; the owner\'s channel',
    `notices about it ${noticesAbout(subject).length}; all notice posts ${posts.filter((post) => post.path === '/api/v4/posts').length - 1}`,
    noticesAbout(subject).length === 1 && recordsAbout(subject) === 1);

  // A restart reads from where it left off: the old message is not announced again; one that came while it was down is.
  await daemon.stop();
  const downSubject = 'RTJ12 arrived while the daemon was down';
  mailbox.deliverQuietly(downSubject);
  daemon = await startDaemon(s.home, [], env);
  const caughtUp = await waitFor(() => noticesAbout(downSubject).length > 0 ? true : undefined, 60_000, 500);
  await Bun.sleep(5_000);
  const token3 = operatorToken(s.home);
  const downInInbox = await waitFor(async () => {
    const found = await inboxRowsAbout(token3, downSubject);
    return found.rows.length > 0 ? found : undefined;
  }, 30_000, 500) ?? await inboxRowsAbout(token3, downSubject);
  const oldInInbox = await inboxRowsAbout(token3, subject);
  journey.check('after a restart the old message is not announced again; one that arrived while it was down is, once',
    `restart the daemon; deliver "${downSubject}" while it is down`,
    `old notices ${noticesAbout(subject).length}, records ${recordsAbout(subject)}, mail inbox rows ${oldInInbox.rows.length}; new notices ${noticesAbout(downSubject).length}, records ${recordsAbout(downSubject)}, recorded notice ${noticeStatusOf(downSubject)}, mail inbox rows ${downInInbox.rows.length}`,
    caughtUp === true && noticesAbout(subject).length === 1 && recordsAbout(subject) === 1 && noticesAbout(downSubject).length === 1 && recordsAbout(downSubject) === 1
      // The scripted mailbox dates every message 27 July 2026, older than the mail inbox keeps (30 days), so the
      // start-up sweep may age the old row out; it is never added twice.
      && oldInInbox.rows.length <= 1 && downInInbox.rows.length === 1);
} catch (error) {
  journey.check('journey ran to the end', 'j12', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await daemon.stop();
  s.model.stop();
  mattermost.stop(true);
  mailbox.close();
}
journey.finish(s.base);
