import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { previewTuiHostPairing } from '../../runtime/tui-host-pairing.ts';
import { beginTuiHostPairing, clearTuiHostPairingAttempt, readTuiHostPairing, tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const shared = 'synthetic-tui-bootstrap';
const minted = 'gvp_' + 't'.repeat(32);
const id = 'pair-12345678-1234-1234-1234-123456789abc';
function fixture(options: { migrationResponse?: () => Response | Promise<Response>; mutate?: () => void; rejectMinted?: boolean; holdAuth?: number; redirectAuth?: boolean } = {}) {
  const home = makeProjectTempDir('tui-host-pairing');
  const configManager = new TuiConfigManager({ surfaceRoot: 'tui', configDir: join(home, '.goodvibes', 'tui'), workingDir: home, homeDir: home });
  let authorized = true; let migrations = 0; let authCalls = 0; let reads = 0; const paths: string[] = []; const attempts: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; paths.push(path);
    const token = request.headers.get('authorization')?.replace('Bearer ', '');
    if (path === '/api/control-plane/auth') {
      authCalls++;
      if (options.redirectAuth) return new Response(null, { status: 307, headers: { location: '/must-not-follow-auth' } });
      if (authCalls === options.holdAuth) return new Promise<Response>(() => {});
      return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
        principalId: token === minted ? `pairing:${id}` : 'shared-token', principalKind: 'token', credential: (token === minted ? `pairing:${id}` : 'shared-token') === 'shared-token' ? 'shared-token' as const : 'device-token' as const, admin: authorized && !(options.rejectMinted && token === minted), scopes: ['*'], roles: [] });
    }
    if (path === '/api/control-plane/methods/pairing.tokens.migrate/invoke' && request.method === 'POST') {
      migrations++; expect(token).toBe(shared);
      const body = await request.json() as { body: { name: string; attemptId?: unknown } };
      attempts.push(body.body.attemptId);
      options.mutate?.();
      return options.migrationResponse?.() ?? Response.json({ token: { token: minted, id, name: body.body.name, createdAt: Date.now() } });
    }
    reads++; return new Response('Unexpected route', { status: 404 });
  } });
  configManager.set('controlPlane.host', '127.0.0.1'); configManager.set('controlPlane.port', server.port!); configManager.set('daemon.enabled', true);
  const tokenPath = join(home, '.goodvibes', 'daemon', 'operator-tokens.json'); mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: shared }), { mode: 0o600 });
  const optionsForPairing = { configManager, homeDirectory: home, bootstrapShared: true };
  return { home, host: server.url.origin, configManager, tokenPath, options: optionsForPairing, paths, attempts,
    get migrations() { return migrations; }, get authCalls() { return authCalls; }, set authorized(value: boolean) { authorized = value; },
    close() { expect(reads).toBe(0); server.stop(true); } };
}
async function pair(f: ReturnType<typeof fixture>) {
  const preview = await previewTuiHostPairing(f.options, 'TUI fixture'); expect(preview.result.status).toBe('preview');
  return preview.confirm!(preview.result.confirmation!);
}

describe('TUI-owned explicit host pairing', () => {
  test('bootstrap is opt-in, preview is read-only, owner confirmation pairs once, restart verifies same credential', async () => {
    const f = fixture(); try {
      const before = readFileSync(f.tokenPath);
      expect((await previewTuiHostPairing({ ...f.options, bootstrapShared: false })).result.status).toBe('blocked');
      expect(f.authCalls).toBe(0); expect(f.migrations).toBe(0);
      const preview = await previewTuiHostPairing(f.options, '  TUI fixture  ');
      expect(preview.result).toMatchObject({ status: 'preview', host: f.host, name: 'TUI fixture' });
      expect(preview.result.scopeDisclosure).toContain('persistent administrative'); expect(preview.result.scopeDisclosure).toContain('daemon-global');
      expect(JSON.stringify(preview)).not.toContain(shared); expect(JSON.stringify(preview)).not.toContain(minted);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('missing'); expect(existsSync(tuiHostPairingStorePath(f.home))).toBe(false);
      expect((await preview.confirm!(preview.result.confirmation!)).status).toBe('paired');
      expect((await preview.confirm!(preview.result.confirmation!)).status).toBe('cancelled');
      expect(f.migrations).toBe(1); expect(readFileSync(f.tokenPath)).toEqual(before);
      expect(resolveNativeHostCredential(f.options)).toMatchObject({ available: true, baseUrl: f.host, token: minted });
      expect((await previewTuiHostPairing({ ...f.options, bootstrapShared: false })).result.status).toBe('already-paired'); expect(f.migrations).toBe(1);
    } finally { f.close(); }
  });
  test('wrong confirmation consumes capability and never starts migration', async () => {
    const f = fixture(); try {
      const p = await previewTuiHostPairing(f.options);
      expect((await p.confirm!('yes')).status).toBe('cancelled');
      expect((await p.confirm!(p.result.confirmation!)).status).toBe('cancelled'); expect(f.migrations).toBe(0);
    } finally { f.close(); }
  });
  for (const change of ['host', 'token', 'store', 'revocation', 'disabled', 'home'] as const) {
    test(`confirmation fences changed ${change} before mutation`, async () => {
      const f = fixture(); let home = f.home;
      try {
        const p = await previewTuiHostPairing({ ...f.options, homeDirectory: () => home });
        if (change === 'host') f.configManager.set('controlPlane.port', 1);
        if (change === 'token') writeFileSync(f.tokenPath, JSON.stringify({ token: 'different-synthetic-token' }));
        if (change === 'store') await beginTuiHostPairing(f.home, f.host, { attemptId: 'other', name: 'Other', startedAt: Date.now() });
        if (change === 'revocation') f.authorized = false;
        if (change === 'disabled') f.configManager.set('daemon.enabled', false);
        if (change === 'home') home = makeProjectTempDir('changed-tui-home');
        expect((await p.confirm!(p.result.confirmation!)).status).toBe('changed'); expect(f.migrations).toBe(0);
      } finally { f.close(); }
    });
  }
  test('independent confirmations CAS to one migration', async () => {
    const f = fixture(); try {
      const [a, b] = await Promise.all([previewTuiHostPairing(f.options), previewTuiHostPairing(f.options)]);
      const results = await Promise.all([a.confirm!(a.result.confirmation!), b.confirm!(b.result.confirmation!)]);
      expect(results.filter(result => result.status === 'paired')).toHaveLength(1); expect(f.migrations).toBe(1);
    } finally { f.close(); }
  });
  for (const fault of ['lost', 'malformed', 'too-large', 'redirect'] as const) test(`${fault} result preserves durable unknown; only the same attempt is repeated`, async () => {
    const f = fixture({ migrationResponse: () => fault === 'lost' ? new Response(shared, { status: 503 }) : fault === 'malformed' ? Response.json({ token: shared }) : fault === 'too-large' ? new Response('x'.repeat(17_000)) : new Response(null, { status: 307, headers: { location: '/do-not-follow' } }) });
    try {
      const result = await pair(f); expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain(shared);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('unknown'); expect(resolveNativeHostCredential(f.options).available).toBe(false);
      // Without the bootstrap selected nothing is sent.
      expect((await previewTuiHostPairing({ ...f.options, bootstrapShared: false })).result.status).toBe('unknown'); expect(f.migrations).toBe(1);
      expect((await previewTuiHostPairing(f.options)).result.status).toBe('unknown'); expect(f.migrations).toBe(2);
      expect(typeof f.attempts[0]).toBe('string'); expect(f.attempts[1]).toBe(f.attempts[0]);
    } finally { f.close(); }
  });
  test('an unresolved attempt is forgotten only after its fresh owner confirmation, and a paired record is never cleared', async () => {
    const f = fixture({ migrationResponse: () => new Response(shared, { status: 503 }) });
    try {
      expect((await pair(f)).status).toBe('unknown');
      const preview = await previewTuiHostPairing({ ...f.options, bootstrapShared: false });
      expect(preview.result.status).toBe('unknown');
      expect(preview.result.confirmation).toMatch(/^CLEAR /);
      expect((await preview.confirm!('CLEAR nonsense')).status).toBe('cancelled');
      expect(readTuiHostPairing(f.home, f.host).status).toBe('unknown');
      expect((await preview.confirm!(preview.result.confirmation!)).status).toBe('cleared');
      expect((await preview.confirm!(preview.result.confirmation!)).status).toBe('cancelled');
      expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
      expect(f.migrations).toBe(1);
    } finally { f.close(); }
    const paired = fixture();
    try {
      expect((await pair(paired)).status).toBe('paired');
      expect((await clearTuiHostPairingAttempt(paired.home, paired.host, 'any-attempt')).status).toBe('conflict');
      expect(readTuiHostPairing(paired.home, paired.host).status).toBe('paired');
    } finally { paired.close(); }
  });
  test('saved credential survives rejected verification and does not remint on restart', async () => {
    const f = fixture({ rejectMinted: true }); try {
      expect((await pair(f)).status).toBe('paired-unverified'); expect(readTuiHostPairing(f.home, f.host).status).toBe('paired');
      expect((await previewTuiHostPairing(f.options)).result.status).toBe('paired-unverified'); expect(f.migrations).toBe(1);
    } finally { f.close(); }
  });
  test('host change during migration saves only original host and stays unverified', async () => {
    let f: ReturnType<typeof fixture>; f = fixture({ mutate: () => f.configManager.set('controlPlane.port', 1) });
    try {
      expect((await pair(f)).status).toBe('paired-unverified'); expect(readTuiHostPairing(f.home, f.host).status).toBe('paired');
      expect(readTuiHostPairing(f.home, 'http://127.0.0.1:1').status).toBe('missing'); expect(resolveNativeHostCredential(f.options).available).toBe(false);
    } finally { f.close(); }
  });
  test('a lost reply is settled by repeating the same attempt, which pairs without a second credential', async () => {
    let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
    let replies = 0;
    const f = fixture({ mutate: start, migrationResponse: () => replies++ === 0 ? new Promise<Response>(() => {}) : Response.json({ token: { token: minted, id, name: 'GoodVibes TUI', createdAt: Date.now() } }) });
    try {
      const p = await previewTuiHostPairing(f.options); const controller = new AbortController();
      const result = p.confirm!(p.result.confirmation!, controller.signal); await started; controller.abort();
      expect((await result).status).toBe('unknown');
      expect((await previewTuiHostPairing({ ...f.options, bootstrapShared: false })).result.status).toBe('unknown'); expect(f.migrations).toBe(1);
      expect((await previewTuiHostPairing(f.options)).result.status).toBe('paired');
      expect(f.migrations).toBe(2); expect(f.attempts[1]).toBe(f.attempts[0]);
      expect(resolveNativeHostCredential(f.options)).toMatchObject({ available: true, token: minted });
    } finally { f.close(); }
  });
  for (const status of [403, 429]) test(`a ${status} answer from the host releases the marker so pairing can be previewed again`, async () => {
    const f = fixture({ migrationResponse: () => new Response(JSON.stringify({ error: 'refused' }), { status }) });
    try {
      const result = await pair(f);
      expect(result.status).toBe('blocked'); expect(result.message).toContain(`HTTP ${status}`);
      expect(readTuiHostPairing(f.home, f.host).status).toBe('missing'); expect(resolveNativeHostCredential(f.options).available).toBe(false);
      expect((await previewTuiHostPairing(f.options)).result.status).toBe('preview'); expect(f.migrations).toBe(1);
    } finally { f.close(); }
  });
  test('abort before confirmation creates no intent', async () => {
    const f = fixture(); try {
      const p = await previewTuiHostPairing(f.options); const controller = new AbortController(); controller.abort();
      expect((await p.confirm!(p.result.confirmation!, controller.signal)).status).toBe('cancelled'); expect(f.migrations).toBe(0); expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
    } finally { f.close(); }
  });
  for (const unsafe of ['mode', 'symlink', 'oversized', 'corrupt'] as const) test(`unsafe ${unsafe} bootstrap fails closed without repair or network`, async () => {
    const f = fixture(); try {
      if (unsafe === 'mode') chmodSync(f.tokenPath, 0o644);
      if (unsafe === 'symlink') { const target = join(f.home, 'other-secret'); writeFileSync(target, readFileSync(f.tokenPath), { mode: 0o600 }); const { unlinkSync } = await import('node:fs'); unlinkSync(f.tokenPath); symlinkSync(target, f.tokenPath); }
      if (unsafe === 'oversized') writeFileSync(f.tokenPath, 'x'.repeat(17_000));
      if (unsafe === 'corrupt') writeFileSync(f.tokenPath, `{"token":"${shared}`);
      expect((await previewTuiHostPairing(f.options)).result.status).toBe('blocked'); expect(f.authCalls).toBe(0); expect(f.migrations).toBe(0);
    } finally { f.close(); }
  });
  test('pairing preview never accepts redirected authority', async () => {
    const f = fixture({ redirectAuth: true }); try {
      expect((await previewTuiHostPairing(f.options)).result.status).toBe('blocked');
      expect(f.migrations).toBe(0); expect(readTuiHostPairing(f.home, f.host).status).toBe('missing');
    } finally { f.close(); }
  });
  test('selection change during platform preparation prevents bootstrap dispatch', async () => {
    const f = fixture(); try {
      const pending = previewTuiHostPairing(f.options);
      f.configManager.set('controlPlane.port', 1);
      expect((await pending).result.status).toBe('blocked'); expect(f.authCalls).toBe(0); expect(f.migrations).toBe(0);
    } finally { f.close(); }
  });

});
