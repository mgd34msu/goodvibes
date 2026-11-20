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
import { createHmac } from 'node:crypto';
import { Journey, api, operatorToken, short, stage, startDaemon, waitFor, type Daemon } from './lib.ts';

const journey = new Journey('j14-save-then-acknowledge');
const posts: Array<{ path: string; body: Record<string, unknown>; held: boolean }> = [];
/** The first reply POST is held unanswered (the daemon dies waiting); later ones are answered. */
let holdNextReply = true;
/** Channels whose next post is held unanswered (a scheduled run's delivery the daemon dies in). */
const holdChannelOnce = new Set<string>();
let reachedChannelHold: () => void = () => {};
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
    if (url.pathname === '/api/v4/posts' && typeof body.channel_id === 'string' && holdChannelOnce.delete(body.channel_id)) {
      posts.push({ path: url.pathname, body, held: true });
      reachedChannelHold();
      return await new Promise<Response>(() => {});
    }
    if (url.pathname === '/api/v4/posts' && holdNextReply && body.channel_id === 'dm-U-OWNER') {
      holdNextReply = false;
      posts.push({ path: url.pathname, body, held: true });
      reachedHold();
      return await new Promise<Response>(() => {});
    }
    posts.push({ path: url.pathname, body, held: false });
    return Response.json({ id: `post-${posts.length}`, create_at: Date.now() }, { status: 201 });
  },
});
const env = { MATTERMOST_BOT_TOKEN: 'rt-local-bot-token', MATTERMOST_WEBHOOK_SECRET: 'rt-local-hook-secret',
  RT_GENERIC_HOOK_SECRET: 'rt-local-generic-secret', SLACK_SIGNING_SECRET: 'rt-local-slack-signing' };
const s = await stage('j14', { extraSettings: { surfaces: {
  mattermost: { enabled: true, baseUrl: `http://127.0.0.1:${mattermost.port}`, teamId: 'team-rt', defaultChannelId: 'ch-rt' },
  webhook: { enabled: true, secret: 'goodvibes://secrets/env/RT_GENERIC_HOOK_SECRET' },
  slack: { enabled: true },
} } });
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

  const restart = async (): Promise<void> => { await daemon.kill(); daemon = await startDaemon(s.home, [], env); };
  const modelCalls = (marker: string) => s.model.requests.filter((request) => request.marker === marker && request.step === 0).length;

  // F51: a generic webhook message is saved with its correlationId; the same message after a restart starts nothing.
  await api(daemon, token, 'POST', '/api/channels/policies/webhook', { allowlistUserIds: ['U-HOOK'], allowDirectMessages: true, dmPolicy: 'allow', requireMention: false });
  s.model.scriptWrapped('RTJ14HOOK', [{ text: 'RTJ14HOOK answered.' }]);
  const hook = (text: string) => fetch(`${daemon.baseUrl}/webhook/generic`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goodvibes-webhook-secret': env.RT_GENERIC_HOOK_SECRET },
    body: JSON.stringify({ task: text, correlationId: 'rt-corr-1', userId: 'U-HOOK', channelId: 'hook-1' }) });
  const hookFirst = await hook('RTJ14HOOK what changed?');
  const hookFirstText = await hookFirst.text();
  await restart();
  const callsBefore = modelCalls('RTJ14HOOK');
  const hookSecond = await hook('RTJ14HOOK what changed?');
  const hookSecondText = await hookSecond.text();
  const callsAfter = modelCalls('RTJ14HOOK');
  const hookSession = String((JSON.parse(hookFirstText) as { sessionId?: string }).sessionId ?? '');
  const hookInputs = await api(daemon, token, 'GET', `/api/sessions/${hookSession}/inputs`);
  const hookRows = ((hookInputs.body as { inputs?: Array<{ body?: string }> }).inputs ?? []).filter((input) => input.body?.includes('RTJ14HOOK')).length;
  journey.check('a generic webhook message keyed by correlationId is acknowledged once saved, and its repeat after a SIGKILL starts nothing',
    'POST /webhook/generic correlationId rt-corr-1; SIGKILL; restart; the same POST again',
    `first ${hookFirst.status} ${short(hookFirstText, 140)}; repeat ${hookSecond.status} ${short(hookSecondText, 140)}; inputs stored for it ${hookRows}; model turns before/after the repeat ${callsBefore}/${callsAfter}`,
    hookFirst.status === 200 && hookSecond.status === 200 && hookRows === 1 && callsAfter === callsBefore);

  // F70: a Slack slash command is acknowledged only once saved: its input row is there after a SIGKILL right after the answer.
  const slackPolicy = await api(daemon, token, 'POST', '/api/channels/policies/slack', { allowlistUserIds: ['U-SLACK'], allowGroupMessages: true, groupPolicy: 'allow', requireMention: false });
  if (slackPolicy.status !== 200) throw new Error(`slack policy ${slackPolicy.status} ${slackPolicy.text}`);
  s.model.scriptWrapped('RTJ14SLASH', [{ text: 'RTJ14SLASH answered.' }]);
  const slash = (trigger: string) => {
    const raw = new URLSearchParams({ command: '/goodvibes', text: 'RTJ14SLASH status please', user_id: 'U-SLACK', user_name: 'owner', channel_id: 'C-SLASH',
      team_id: 'T-RT', trigger_id: trigger, response_url: '' }).toString();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac('sha256', env.SLACK_SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest('hex')}`;
    return fetch(`${daemon.baseUrl}/webhook/slack`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body: raw });
  };
  const slashFirst = await slash('rt-trigger-1');
  const slashFirstText = await slashFirst.text();
  await restart();
  const sessions = await api(daemon, token, 'GET', '/api/sessions?limit=50');
  const listed = ((sessions.body as { sessions?: Array<{ id: string; surfaceKinds?: string[] }> }).sessions ?? []).filter((session) => session.surfaceKinds?.includes('slack'));
  let slashRows = 0;
  for (const session of listed) {
    const inputs = await api(daemon, token, 'GET', `/api/sessions/${session.id}/inputs`);
    slashRows += ((inputs.body as { inputs?: Array<{ body?: string }> }).inputs ?? []).filter((input) => input.body?.includes('RTJ14SLASH')).length;
  }
  const slashAgain = await slash('rt-trigger-1');
  const slashAgainText = await slashAgain.text();
  let slashRowsAfter = 0;
  for (const session of listed) {
    const inputs = await api(daemon, token, 'GET', `/api/sessions/${session.id}/inputs`);
    slashRowsAfter += ((inputs.body as { inputs?: Array<{ body?: string }> }).inputs ?? []).filter((input) => input.body?.includes('RTJ14SLASH')).length;
  }
  journey.check('a Slack slash command acknowledged "Received" is on disk after a SIGKILL right after the answer, and its redelivery adds nothing',
    'POST /webhook/slack (signed slash command, trigger rt-trigger-1); SIGKILL; restart; GET the session inputs; the same command again',
    `ack ${slashFirst.status} ${short(slashFirstText, 120)}; rows after the restart ${slashRows}; redelivery ${slashAgain.status} ${short(slashAgainText, 100)}; rows after it ${slashRowsAfter}`,
    slashFirst.status === 200 && /Received/.test(slashFirstText) && slashRows === 1 && slashRowsAfter === 1);

  // F332/F139: a web chat send keyed by clientMessageId is answered 202 once synced; after a SIGKILL the key returns the first message, and one is stored.
  const chat = await api(daemon, token, 'POST', '/api/companion/chat/sessions', { title: 'rt chat' });
  const chatId = String(((chat.body as { session?: { id?: string }; id?: string }).session?.id) ?? (chat.body as { id?: string }).id ?? '');
  s.model.scriptWrapped('RTJ14CHAT', [{ text: 'RTJ14CHAT answered.' }]);
  const post = (content: string) => api(daemon, token, 'POST', `/api/companion/chat/sessions/${chatId}/messages`, { content, clientMessageId: 'rt-chat-key-1' });
  const chatFirst = await post('RTJ14CHAT is the build green?');
  await restart();
  const chatAgain = await post('RTJ14CHAT is the build green?');
  const chatOther = await post('RTJ14CHAT a different question');
  const chatList = await api(daemon, token, 'GET', `/api/companion/chat/sessions/${chatId}/messages`);
  const stored = ((chatList.body as { messages?: Array<{ role: string; content: string }> }).messages ?? []).filter((message) => message.role === 'user' && message.content.includes('RTJ14CHAT'));
  journey.check('a keyed web chat send is kept across a SIGKILL after its 202, its repeat returns the first message, and the key with other text is refused',
    'POST /api/companion/chat/sessions/{id}/messages clientMessageId rt-chat-key-1; SIGKILL; restart; the same POST; the key with other text; GET messages',
    `first ${chatFirst.status} ${short(chatFirst.text, 100)}; repeat ${chatAgain.status} ${short(chatAgain.text, 100)}; other text ${chatOther.status} ${short(chatOther.text, 120)}; stored ${stored.length}`,
    chatFirst.status === 202 && chatAgain.status === 202 && chatAgain.text === chatFirst.text && chatOther.status === 409 && stored.length === 1);

  // F139: two concurrent keyed posts to a session answer as one and store one message.
  const session = await api(daemon, token, 'POST', '/api/sessions', { title: 'rt keyed' });
  const sessionId = String((session.body as { session?: { id?: string } }).session?.id ?? '');
  const [one, two] = await Promise.all([1, 2].map(() => api(daemon, token, 'POST', `/api/sessions/${sessionId}/messages`, { body: 'RTJ14KEYED note', messageId: 'rt-msg-key-1' })));
  const sessionMessages = await api(daemon, token, 'GET', `/api/sessions/${sessionId}/messages`);
  const keyedStored = ((sessionMessages.body as { messages?: Array<{ body?: string }> }).messages ?? []).filter((message) => message.body?.includes('RTJ14KEYED')).length;
  journey.check('two concurrent posts with one messageId answer alike and store one message',
    'POST /api/sessions/{id}/messages messageId rt-msg-key-1, twice at once; GET messages',
    `${one!.status} ${short(one!.text, 80)} / ${two!.status} ${short(two!.text, 80)}; stored ${keyedStored}`,
    one!.status === 202 && two!.status === 202 && one!.text === two!.text && keyedStored === 1);

  // F21: a scheduled run's answer owed when the daemon died in its delivery is delivered once after the restart.
  s.model.scriptWrapped('RTJ14AUTO', [{ text: 'RTJ14AUTO the run result.' }]);
  const job = await api(daemon, token, 'POST', '/api/automation/jobs', { name: 'rt owed run', prompt: 'RTJ14AUTO summarise today', every: '24h',
    delivery: { mode: 'surface', targets: [{ kind: 'surface', surfaceKind: 'mattermost', address: 'ch-auto' }], fallbackTargets: [], includeSummary: false, includeLinks: false } });
  const jobId = String((job.body as { job?: { id?: string }; id?: string }).job?.id ?? (job.body as { id?: string }).id ?? '');
  holdChannelOnce.add('ch-auto');
  const runHeld = new Promise<void>((resolve) => { reachedChannelHold = resolve; });
  const run = await api(daemon, token, 'POST', `/api/automation/jobs/${jobId}/run`, {});
  const autoHeld = await Promise.race([runHeld.then(() => true), Bun.sleep(30_000).then(() => false)]);
  await restart();
  await waitFor(() => posts.some((entry) => entry.body.channel_id === 'ch-auto' && !entry.held) ? true : undefined, 30_000);
  await Bun.sleep(3_000);
  const autoPosts = posts.filter((entry) => entry.body.channel_id === 'ch-auto' && !entry.held);
  journey.check('a scheduled run whose delivery the daemon died in is delivered once after the restart',
    'POST /api/automation/jobs (delivery mattermost ch-auto); run it; the recorder holds the delivery; SIGKILL; restart',
    `job ${job.status} ${short(job.text, 100)}; run ${run.status}; held ${autoHeld}; deliveries after the restart ${autoPosts.length}`,
    autoHeld && autoPosts.length === 1);
} catch (error) {
  journey.check('journey ran to the end', 'j14', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await daemon.stop();
  s.model.stop();
  mattermost.stop(true);
}
journey.finish(s.base);
