/**
 * Journey 14: save, then acknowledge. Each step holds the far side's answer,
 * kills the daemon (SIGKILL) while it holds, restarts it, and checks that the
 * operation completes once (the recorder's count) or is reported `unknown`
 * with its read-back step; never lost, never done twice.
 *
 *  - a channel answer: an allowlisted Mattermost sender's message is answered
 *    by the scripted model; the Mattermost server (a loopback recorder this
 *    script runs) holds the reply's POST without answering; the daemon is
 *    killed while it holds and started again; the answer reaches the
 *    conversation once after the restart.
 *
 * Each path package of the save-then-acknowledge work adds its step here.
 */
import { Journey, api, operatorToken, short, stage, startDaemon, waitFor, type Daemon } from './lib.ts';

const journey = new Journey('j14-save-then-acknowledge');
const posts: Array<{ path: string; body: Record<string, unknown>; held: boolean }> = [];
/** The first reply POST is held unanswered (the daemon dies waiting); later ones are answered. */
let holdNextReply = true;
let reachedHold: () => void = () => {};
const holding = new Promise<void>((resolve) => { reachedHold = resolve; });
const mattermost = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const text = request.method === 'POST' ? await request.text() : '';
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { raw: text }; }
    if (url.pathname.endsWith('/users/me')) return Response.json({ id: 'rt-bot', username: 'rtbot' });
    if (url.pathname === '/api/v4/posts' && holdNextReply) {
      holdNextReply = false;
      posts.push({ path: url.pathname, body, held: true });
      reachedHold();
      return await new Promise<Response>(() => {});
    }
    posts.push({ path: url.pathname, body, held: false });
    return Response.json({ id: `post-${posts.length}`, create_at: Date.now() }, { status: 201 });
  },
});
const env = { MATTERMOST_BOT_TOKEN: 'rt-local-bot-token', MATTERMOST_WEBHOOK_SECRET: 'rt-local-hook-secret' };
const s = await stage('j14', { extraSettings: { surfaces: { mattermost: { enabled: true, baseUrl: `http://127.0.0.1:${mattermost.port}`, teamId: 'team-rt', defaultChannelId: 'ch-rt' } } } });
s.home.allow(mattermost.port!);
await s.daemon.stop();
let daemon: Daemon = await startDaemon(s.home, [], env);

function inbound(user: string, text: string, postId: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}/webhook/mattermost`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goodvibes-mattermost-token': env.MATTERMOST_WEBHOOK_SECRET },
    body: JSON.stringify({ channel_id: `dm-${user}`, channel_type: 'D', user_id: user, user_name: user, post_id: postId, text }),
  });
}
const answered = (channel: string) => posts.filter((post) => post.path === '/api/v4/posts' && post.body.channel_id === channel && !post.held);

try {
  const token = operatorToken(s.home);
  const policy = await api(daemon, token, 'POST', '/api/channels/policies/mattermost', { allowlistUserIds: ['U-OWNER'], allowDirectMessages: true, dmPolicy: 'allow', requireMention: false });
  journey.check('the owner allowlists one sender', 'POST /api/channels/policies/mattermost { allowlistUserIds: [U-OWNER] }', `${policy.status} ${short(policy.text, 200)}`, policy.status === 200);

  s.model.scriptWrapped('RTJ14REPLY', [{ text: 'RTJ14 the answer that must arrive once.' }]);
  const first = await inbound('U-OWNER', 'RTJ14REPLY what is on today?', 'post-j14-1');
  const firstBody = await first.text();
  const held = await Promise.race([holding.then(() => true), Bun.sleep(30_000).then(() => false)]);
  await daemon.kill();
  daemon = await startDaemon(s.home, [], env);
  const arrived = await waitFor(() => answered('dm-U-OWNER').length > 0 ? true : undefined, 30_000);
  // Long enough for a second send of the same answer to show.
  await Bun.sleep(5_000);
  const replies = answered('dm-U-OWNER');
  journey.check('a channel answer whose send the daemon died in reaches the conversation once after the restart',
    'POST /webhook/mattermost; the recorder holds the reply POST; SIGKILL the daemon; start it again',
    `message ${first.status} ${short(firstBody, 160)}; reply held before the kill ${held}; replies after the restart ${JSON.stringify(replies.map((post) => post.body.message))}`,
    first.status === 200 && held && arrived === true && replies.length === 1 && String(replies[0]!.body.message).includes('RTJ14 the answer that must arrive once.'),
    replies.length === 0 ? 'the answer was lost: nothing sent it after the restart' : replies.length > 1 ? `the answer was sent ${replies.length} times` : undefined);
} catch (error) {
  journey.check('journey ran to the end', 'j14', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await daemon.stop();
  s.model.stop();
  mattermost.stop(true);
}
journey.finish(s.base);
