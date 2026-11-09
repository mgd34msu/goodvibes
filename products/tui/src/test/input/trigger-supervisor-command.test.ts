import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog, registerTriggerSupervisorGatewayMethods } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { TriggerManager } from '@goodvibes-jev/engine/sdk/platform/triggers';
import type { OpenSelection } from '@goodvibes-jev/engine/terminal-shell/selection-modal';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTriggerCommands } from '../../input/commands/trigger-supervisor.ts';
import { beginTuiHostPairing, completeTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
// Fixed original saved-v1 recipe, not a fresh production identity/checksum.
const previous = '{"version":1,"daemonBootId":"actual-older-boot","savedAt":1000,"triggers":[{"definition":{"id":"condition-one","label":"Build readiness","createdAt":1000,"spec":{"kind":"condition","probe":{"kind":"file","path":"/nonexistent-owned-trigger-fixture"},"extract":{"kind":"raw"},"rule":{"kind":"change"}},"action":{"kind":"agent-turn","prompt":"not-for-wire"}},"state":"idle","observations":[],"runs":[],"ruleState":{},"strikes":0,"backoffRung":0,"firedCount":0,"droppedLines":0,"updatedAt":1000}],"grants":[],"eventLog":[],"checksum":"00bfa6dde707e3168ba0f88824be46d5fb461b2fa14892ea484fefd77b326266"}';
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(2); }
  throw new Error('The trigger command did not settle');
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tui-trigger-command-'));
  const old = join(root, 'triggers.json'), path = join(root, 'triggers-v2.json'); writeFileSync(old, previous);
  const supervisor = new TriggerManager({ storePath: path, previousStorePath: old, now: () => 1000, config: { enabled: true },
    actions: { async runAgentTurn() { throw new Error('No fixture trigger action'); }, async runGrant() { throw new Error('No fixture trigger action'); } } });
  supervisor.start();
  const catalog = new GatewayMethodCatalog(); registerTriggerSupervisorGatewayMethods(catalog, supervisor);
  let principalId = 'pairing:fixture-owner', scopes = ['read:watchers', 'write:watchers'];
  let authWait: Promise<void> | undefined;
  const requests: { path: string; body: unknown }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('authorization') !== 'Bearer synthetic-trigger-command-bearer') return Response.json({ error: 'unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    const body: unknown = request.method === 'POST' ? await request.json() : undefined;
    requests.push({ path: url.pathname, body });
    if (url.pathname === '/api/control-plane/auth') {
      await authWait;
      return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true,
        sessionCookiePresent: false, principalId, principalKind: 'token', admin: true, scopes, roles: [] });
    }
    const matched = /^\/api\/control-plane\/methods\/(watchers\.triggers\.(?:status|migrate))\/invoke$/.exec(url.pathname);
    if (!matched) return Response.json({ error: 'Unknown fixture route' }, { status: 404 });
    try {
      const input = body && typeof body === 'object' && 'body' in body ? body.body : body;
      return Response.json(await catalog.invoke(matched[1]!, { context: { principalId, principalKind: 'token', admin: true, scopes },
        body: input, signal: request.signal, isAuthorized: required => (required ?? []).every(scope => scopes.includes(scope)) }));
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
        return Response.json({ error: 'Fixture operator refusal', code: 'code' in error ? error.code : 'UNKNOWN' }, { status: error.status });
      }
      throw error;
    }
  } });
  const config = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'config'), workingDir: root, homeDir: root });
  config.set('daemon.enabled', true); config.set('controlPlane.publicBaseUrl', server.url.origin);
  const attempt = { attemptId: 'fixture-trigger-owner', name: 'TUI trigger operator', startedAt: Date.now() };
  expect((await beginTuiHostPairing(root, server.url.origin, attempt)).status).toBe('begun');
  expect((await completeTuiHostPairing(root, server.url.origin, attempt.attemptId, {
    token: 'synthetic-trigger-command-bearer', tokenId: 'fixture-owner', name: attempt.name, createdAt: attempt.startedAt,
  })).status).toBe('paired');
  const messages: string[] = [];
  let selection: Parameters<OpenSelection>[3] | undefined, selectionSignal: AbortSignal | undefined;
  const context = { print: (message: string) => messages.push(message), renderRequest() {}, invokedByModel: false,
    platform: { configManager: config }, workspace: { shellPaths: { homeDirectory: root } },
    openSelection: ((_title, _items, options, callback) => { selection = callback; selectionSignal = options?.signal; }) as OpenSelection,
  } as unknown as CommandContext;
  const registry = new CommandRegistry(); registerTriggerCommands(registry);
  cleanup.push(async () => { selection?.(null); supervisor.shutdown(); await supervisor.join(); await server.stop(true); rmSync(root, { recursive: true, force: true }); });
  return { root, old, supervisor, config, messages, requests, registry, context,
    open: (args = ['migrate']) => registry.executeFromOwner('triggers', args, context),
    choose: (id: string) => { expect(selection).toBeDefined(); selection!({ action: 'select', item: { id, label: id } }); },
    signal: () => selectionSignal,
    setPrincipal: () => { principalId = 'pairing:replacement-owner'; }, setReadOnly: () => { scopes = ['read:watchers']; },
    holdAuth: (wait: Promise<void>) => { authWait = wait; } };
}

test('actual TUI command exposes daemon status/help and never migrates during inspection or model dispatch', async () => {
  const f = await fixture();
  expect(f.registry.get('triggers')?.description).toContain('selected daemon');
  expect(f.registry.get('triggers')?.usage).toContain('--older-instances-closed');
  await f.registry.execute('triggers', ['migrate', '--older-instances-closed'], f.context);
  expect(f.requests).toHaveLength(0); expect(f.messages.join('\n')).toContain('directly in the owner terminal');
  await f.open(['status']);
  expect(f.messages.join('\n'), JSON.stringify(f.requests)).toContain('Run /triggers migrate');
  expect(f.supervisor.executionOwnership).toBe('migration-required');
  expect(f.requests.some(value => value.path.includes('watchers.triggers.status'))).toBe(true);
  expect(f.requests.some(value => value.path.includes('watchers.triggers.migrate'))).toBe(false);
});

test('actual TUI delayed owner selection reaches original catalog migration exactly once', async () => {
  const f = await fixture(); await f.open();
  expect(f.supervisor.executionOwnership).toBe('migration-required');
  f.choose('migrate'); f.choose('migrate');
  await until(() => f.messages.some(message => message.includes('Migration completed')));
  expect(f.supervisor.executionOwnership).toBe('local');
  expect(f.requests.filter(value => value.path.includes('watchers.triggers.migrate')).map(value => value.body))
    .toEqual([{ body: { confirm: true, olderInstancesClosed: true } }]);
  expect(readFileSync(f.old, 'utf8')).toBe(previous);
  expect(f.signal()?.aborted).toBe(true);
  expect(f.messages.join('\n')).not.toContain('synthetic-trigger-command-bearer');
});

test('explicit original keyboard statement works without a picker and server scopes remain enforced', async () => {
  const f = await fixture(); delete f.context.openSelection;
  await f.open(['migrate', '--older-instances-closed']);
  expect(f.supervisor.executionOwnership).toBe('local');
  const readOnly = await fixture(); readOnly.setReadOnly(); await readOnly.open(['migrate', '--older-instances-closed']);
  expect(readOnly.supervisor.executionOwnership).toBe('migration-required');
  expect(readOnly.requests.some(value => value.path.includes('watchers.triggers.migrate'))).toBe(false);
});

test('retired host configuration aborts the original picker and sends no migration', async () => {
  const f = await fixture(); await f.open(); f.config.set('display.stream', false);
  expect(f.signal()?.aborted).toBe(true); f.choose('migrate');
  await until(() => f.messages.some(message => message.includes('unavailable')));
  expect(f.requests.some(value => value.path.includes('watchers.triggers.migrate'))).toBe(false);
  expect(f.supervisor.executionOwnership).toBe('migration-required');
});

test('changed principal cannot reuse a prior displayed acknowledgment', async () => {
  const f = await fixture(); await f.open(); f.setPrincipal(); f.choose('migrate');
  await until(() => f.messages.some(message => message.includes('unavailable')));
  expect(f.requests.some(value => value.path.includes('watchers.triggers.migrate'))).toBe(false);
});

test('future source refusal survives the actual HTTP route as actionable value-free guidance', async () => {
  const f = await fixture(); writeFileSync(f.old, '{"version":99,"private":"must-not-display"}');
  await f.open(['status']);
  expect(f.messages.join('\n')).toContain('newer GoodVibes reader');
  expect(f.messages.join('\n')).not.toContain('must-not-display');
  expect(readFileSync(f.old, 'utf8')).toBe('{"version":99,"private":"must-not-display"}');
});

test('closing the confirmation keeps original triggers stopped and makes its callback unusable', async () => {
  const f = await fixture(); await f.open(); f.choose('keep'); f.choose('migrate');
  expect(f.signal()?.aborted).toBe(true);
  expect(f.requests.some(value => value.path.includes('watchers.triggers.migrate'))).toBe(false);
  expect(f.supervisor.executionOwnership).toBe('migration-required');
});

test('configuration retirement while an actual HTTP authentication is pending prevents all subsequent RPCs', async () => {
  const f = await fixture(); let release!: () => void;
  f.holdAuth(new Promise<void>(resolve => { release = resolve; }));
  const opening = f.open();
  try {
    await until(() => f.requests.some(value => value.path === '/api/control-plane/auth'));
    f.config.set('display.stream', false);
  } finally { release(); }
  await opening;
  expect(f.requests).toHaveLength(1);
  expect(f.supervisor.executionOwnership).toBe('migration-required');
  expect(f.messages.join('\n')).not.toContain('synthetic-trigger-command-bearer');
});

test('an actual independently completed migration is not automatically retried or misreported', async () => {
  const f = await fixture(); await f.open(); f.supervisor.migratePrevious({ olderInstancesClosed: true }); f.choose('migrate');
  await until(() => f.messages.some(message => message.includes('do not currently require migration')));
  expect(f.requests.filter(value => value.path.includes('watchers.triggers.migrate'))).toHaveLength(1);
  expect(f.messages.join('\n')).not.toContain('Migration completed');
});
