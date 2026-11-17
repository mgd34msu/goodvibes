/**
 * Journey 6: devices and who may read what.
 *
 *  - on the daemon's own machine the apps use the credential they have, with
 *    no pairing step (an Agent run and the auth report);
 *  - pairing a second device mints a named token that device uses; revoking
 *    it ends that device's open event stream at once and refuses its next
 *    request;
 *  - a signed-in user without admin cannot read the owner's transcripts or
 *    paired devices.
 */
import { AGENT_ENTRY, Journey, api, invoke, operatorToken, permissionAnswerer, runProduct, sendNativeHostedTurn, short, stage, waitFor } from './lib.ts';

const journey = new Journey('j6-pairing');
const s = await stage('j6');

async function asToken(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; body: unknown }> {
  return api(s.daemon, token, method, path, body);
}

try {
  const owner = operatorToken(s.home);
  // 1. The owner's own machine: no pairing step.
  await s.registerWorkspace();
  s.model.script('RTJ6LOCAL', [{ text: 'Local and unpaired.' }]);
  const local = await runProduct(s.home, AGENT_ENTRY, ['run', '--output', 'json', 'RTJ6LOCAL hello'], { onLine: permissionAnswerer(() => true) });
  const auth = await asToken(owner, 'GET', '/api/control-plane/auth');
  journey.check('the apps on the daemon\'s machine use the credential they have, no pairing', 'goodvibes-agent run (no pairing done); GET /api/control-plane/auth with the machine\'s operator token',
    `run exit ${local.code} ${short(local.json?.response, 80)}; auth ${auth.status} ${short(auth.text, 220)}`, local.code === 0 && auth.status === 200);

  // 2. A second device.
  const minted = await invoke(s.daemon, owner, 'pairing.tokens.create', { name: 'rt-second-laptop' });
  const mintedBody = (minted.body as { token?: { id?: string; token?: string; name?: string } }).token ?? {};
  const device = mintedBody.token ?? '';
  // A minted token is an offer until the device first uses it; then it is a paired device.
  const deviceRead = await asToken(device, 'GET', '/api/sessions');
  const listed = await invoke(s.daemon, owner, 'pairing.tokens.list', {});
  journey.check('pairing a second device mints a named token the device uses, listed once used', 'pairing.tokens.create { name: rt-second-laptop }; the device reads /api/sessions; pairing.tokens.list',
    `create ${minted.status} id ${mintedBody.id} name ${mintedBody.name}; device read ${deviceRead.status}; list ${short(listed.text, 260)}`,
    minted.status === 200 && typeof mintedBody.token === 'string' && deviceRead.status === 200 && listed.text.includes('rt-second-laptop') && !listed.text.includes(mintedBody.token ?? '\u0000'));
  const controller = new AbortController();
  const stream = await fetch(`${s.daemon.baseUrl}/api/control-plane/events?domains=session`, { headers: { authorization: `Bearer ${device}`, accept: 'text/event-stream' }, signal: controller.signal });
  let streamEndedAt: number | undefined;
  const reading = (async () => {
    try { const reader = stream.body!.getReader(); for (;;) { const { done } = await reader.read(); if (done) break; } }
    catch { /* closed */ }
    streamEndedAt = Date.now();
  })();
  await Bun.sleep(500);
  const openBefore = streamEndedAt === undefined;
  const revokedAt = Date.now();
  const revoked = await invoke(s.daemon, owner, 'pairing.tokens.delete', { id: mintedBody.id });
  await waitFor(() => streamEndedAt !== undefined ? true : undefined, 5_000, 50);
  const after = await asToken(device, 'GET', '/api/sessions');
  journey.check('revoking the device ends its open connection at once and refuses its next request', 'the device opens the event stream; pairing.tokens.delete { id }',
    `stream ${stream.status}, open before revoke ${openBefore}; revoke ${revoked.status}; stream closed ${streamEndedAt === undefined ? 'no' : `${streamEndedAt - revokedAt} ms after`}; next request ${after.status}`,
    stream.status === 200 && openBefore && revoked.status === 200 && streamEndedAt !== undefined && streamEndedAt - revokedAt < 2_000 && after.status === 401);
  controller.abort();
  await reading;

  // 3. A signed-in user without admin.
  s.model.script('RTJ6PRIVATE', [{ text: 'This is the owner\'s private conversation.' }]);
  const ownerTurn = await sendNativeHostedTurn(s.daemon, owner, 'RTJ6PRIVATE my private notes');
  const sessionId = (ownerTurn.start.body as { sessionId?: string }).sessionId ?? '';
  await waitFor(async () => ((await invoke(s.daemon, owner, 'sessions.hosted.list', {})).text.includes(sessionId) ? true : undefined), 10_000);
  const created = await asToken(owner, 'POST', '/api/local-auth/users', { username: 'rt-guest', password: 'rt-guest-password-123', roles: ['user'] });
  const login = await fetch(`${s.daemon.baseUrl}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'rt-guest', password: 'rt-guest-password-123' }) });
  const loginBody = await login.json() as { token?: string };
  const guest = loginBody.token ?? '';
  const transcript = await asToken(guest, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  const session = await asToken(guest, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  const devices = await invoke(s.daemon, guest, 'pairing.tokens.list', {});
  const leaked = [transcript.text, session.text, devices.text].some((text) => text.includes('private conversation') || text.includes('my private notes'));
  journey.check('a signed-in user without admin cannot read the owner\'s transcripts or paired devices', 'create user rt-guest (role user); POST /login; read the owner\'s session messages, session, pairing.tokens.list',
    `user ${created.status}; login ${login.status}; messages ${transcript.status}; session ${session.status}; devices ${devices.status} ${short(devices.text, 120)}; leaked ${leaked}`,
    created.status < 300 && login.status === 200 && guest.length > 0 && [transcript.status, session.status, devices.status].every((status) => status === 403 || status === 404) && !leaked);
} catch (error) {
  journey.check('journey ran to the end', 'j6', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
}
journey.finish(s.base);
