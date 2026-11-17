/**
 * Journey 3: a channel message, on a Mattermost surface whose server is a
 * loopback recorder this script runs (nothing reaches a real Mattermost).
 *
 *  - an allowlisted sender's message reaches a session and the reply is
 *    delivered to the channel exactly once, also when the webhook is
 *    delivered twice;
 *  - a sender not on the allowlist is not answered and is held for the owner
 *    (an owner inbox item);
 *  - the owner admits them, and their next message is answered;
 *  - the owner removes them, the daemon restarts, and they stay removed.
 */
import { Journey, api, invoke, operatorToken, short, stage, startDaemon, waitFor, type Daemon } from './lib.ts';

const journey = new Journey('j3-channels');
const posts: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = [];
const mattermost = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const text = request.method === 'POST' ? await request.text() : '';
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { raw: text }; }
    posts.push({ path: url.pathname, auth: request.headers.get('authorization'), body });
    if (url.pathname.endsWith('/users/me')) return Response.json({ id: 'rt-bot', username: 'rtbot' });
    return Response.json({ id: `post-${posts.length}`, create_at: Date.now() }, { status: 201 });
  },
});
const env = { MATTERMOST_BOT_TOKEN: 'rt-local-bot-token', MATTERMOST_WEBHOOK_SECRET: 'rt-local-hook-secret' };
const s = await stage('j3', { extraSettings: { surfaces: { mattermost: { enabled: true, baseUrl: `http://127.0.0.1:${mattermost.port}`, teamId: 'team-rt', defaultChannelId: 'ch-rt' } } } });
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
const repliesTo = (channel: string) => posts.filter((post) => post.path === '/api/v4/posts' && post.body.channel_id === channel);

try {
  const token = operatorToken(s.home);
  const policy = await api(daemon, token, 'POST', '/api/channels/policies/mattermost', { allowlistUserIds: ['U-OWNER'], allowDirectMessages: true, dmPolicy: 'allow', requireMention: false });
  journey.check('the owner allowlists one sender', 'POST /api/channels/policies/mattermost { allowlistUserIds: [U-OWNER] }', `${policy.status} ${short(policy.text, 200)}`, policy.status === 200);

  s.model.scriptWrapped('RTJ3OWNER', [{ text: 'RTJ3 reply to the owner.' }]);
  const first = await inbound('U-OWNER', 'RTJ3OWNER what is on today?', 'post-owner-1');
  const firstBody = await first.text();
  const again = await inbound('U-OWNER', 'RTJ3OWNER what is on today?', 'post-owner-1');
  const againBody = await again.text();
  const delivered = await waitFor(() => repliesTo('dm-U-OWNER').length > 0 ? true : undefined, 30_000);
  await Bun.sleep(3_000);
  const ownerReplies = repliesTo('dm-U-OWNER');
  const modelSaw = s.model.requests.filter((entry) => entry.marker === 'RTJ3OWNER').length;
  journey.check('an allowlisted sender\'s message reaches a session and is answered', 'POST /webhook/mattermost from U-OWNER',
    `${first.status} ${short(firstBody, 200)}; model requests ${modelSaw}; replies ${JSON.stringify(ownerReplies.map((post) => post.body.message))}`,
    first.status === 200 && delivered === true && modelSaw >= 1 && ownerReplies.some((post) => post.body.message === 'RTJ3 reply to the owner.') && ownerReplies[0]?.auth === `Bearer ${env.MATTERMOST_BOT_TOKEN}`);
  journey.check('the same message delivered twice is answered once', 'the same webhook (same post id) again',
    `second delivery ${again.status} ${short(againBody, 200)}; replies to the owner ${ownerReplies.length}; model requests ${modelSaw}`,
    ownerReplies.length === 1 && modelSaw === 1);

  s.model.scriptWrapped('RTJ3STRANGER', [{ text: 'RTJ3 reply to the new sender.' }]);
  const stranger = await inbound('U-NEW', 'RTJ3STRANGER hello, can you help?', 'post-new-1');
  const strangerBody = await stranger.text();
  const held = await waitFor(async () => {
    const listed = await invoke(daemon, token, 'inbox.list', {});
    return ((listed.body as { items?: Array<Record<string, unknown>> }).items ?? []).find((item) => item.kind === 'claim' && (item.metadata as { userId?: string } | undefined)?.userId === 'U-NEW' && item.status === 'open');
  }, 10_000);
  journey.check('a sender not on the allowlist is not answered and is held for the owner', 'POST /webhook/mattermost from U-NEW; inbox.list',
    `${stranger.status} ${short(strangerBody, 160)}; replies ${repliesTo('dm-U-NEW').length}; inbox item ${short(held ?? 'none', 300)}`,
    stranger.status === 403 && repliesTo('dm-U-NEW').length === 0 && held !== undefined && s.model.requests.every((entry) => entry.marker !== 'RTJ3STRANGER'));

  if (held) {
    const answered = await invoke(daemon, token, 'inbox.answer', { itemId: held.id, option: 'accept' });
    const admitted = await waitFor(async () => {
      const policies = await api(daemon, token, 'GET', '/api/channels/policies');
      return policies.text.includes('U-NEW') ? policies.text : undefined;
    }, 10_000);
    const next = await inbound('U-NEW', 'RTJ3STRANGER hello again', 'post-new-2');
    const nextBody = await next.text();
    const answeredReply = await waitFor(() => repliesTo('dm-U-NEW').length > 0 ? true : undefined, 30_000);
    journey.check('the owner admits the held sender and their next message is answered', 'inbox.answer { option: accept }; another message from U-NEW',
      `answer ${answered.status} ${short(answered.text, 160)}; allowlist has U-NEW ${admitted !== undefined}; next ${next.status} ${short(nextBody, 120)}; replies ${repliesTo('dm-U-NEW').length}`,
      answered.status === 200 && admitted !== undefined && next.status === 200 && answeredReply === true);

    const removed = await api(daemon, token, 'POST', '/api/channels/allowlist/mattermost/edit', { kind: 'user', remove: ['U-NEW'] });
    await daemon.stop();
    daemon = await startDaemon(s.home, [], env);
    const token2 = operatorToken(s.home);
    const policiesAfter = await api(daemon, token2, 'GET', '/api/channels/policies');
    const mattermostPolicy = ((policiesAfter.body as { policies?: Array<Record<string, unknown>> }).policies ?? []).find((entry) => entry.surface === 'mattermost');
    const before = repliesTo('dm-U-NEW').length;
    const blocked = await inbound('U-NEW', 'RTJ3STRANGER are you there?', 'post-new-3');
    await Bun.sleep(3_000);
    journey.check('a removed sender stays removed after a daemon restart', 'allowlist edit { kind: user, remove: [U-NEW] }; restart the daemon; message from U-NEW',
      `remove ${removed.status} ${short(removed.text, 300)}; allowlist after restart ${JSON.stringify(mattermostPolicy?.allowlistUserIds)}; message ${blocked.status}; new replies ${repliesTo('dm-U-NEW').length - before}`,
      removed.status === 200 && Array.isArray(mattermostPolicy?.allowlistUserIds) && !(mattermostPolicy!.allowlistUserIds as string[]).includes('U-NEW')
      && blocked.status === 403 && repliesTo('dm-U-NEW').length === before);
  }
} catch (error) {
  journey.check('journey ran to the end', 'j3', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await daemon.stop();
  s.model.stop();
  mattermost.stop(true);
}
journey.finish(s.base);
