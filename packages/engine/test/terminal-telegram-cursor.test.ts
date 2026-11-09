import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { createTerminalCommandRegistry } from '../terminal-shell/src/command-registry.js';
import { SelectionModal, type OpenSelection } from '../terminal-shell/src/selection-modal.js';
import { attachSelectionModalQueue, type SelectionModalCallback } from '../terminal-shell/src/selection-modal-queue.js';
import { handleSelectionModalToken } from '../terminal-shell/src/modal-input-routes.js';
import { createTelegramCursorCommand } from '../terminal-shell/src/telegram-cursor-command.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const exits: (() => void)[] = [];
afterEach(() => { for (const exit of exits.splice(0)) exit(); });
const preview = { state: 'unbound', previewId: 'telegram-cursor:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  accountId: '111', username: 'original_bot', offset: 501, updatedAt: '2026-11-08T12:00:00.000Z', expiresAtMs: Date.now() + 300_000 };
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  throw new Error('Cursor terminal fixture did not settle');
}
function fixture(failWrite = false) {
  const root = makeProjectTempDir('terminal-telegram-cursor'), credential = join(root, 'paired.json'); writeFileSync(credential, 'private original source');
  const manager = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root, homeDir: root });
  const modal = new SelectionModal();
  const ui = { selectionModal: modal, selectionCallback: null as SelectionModalCallback | null, syncFeedSelectionCallback: null,
    modalStack: [] as string[], modalOpened(name: string) { this.modalStack.push(name); }, requestRender() {}, exitApp() {},
    handleEscape() { const cb = this.selectionCallback; this.selectionCallback = null; modal.close(); this.modalStack.pop(); cb?.(null); } };
  const queue = attachSelectionModalQueue(ui); exits.push(() => ui.exitApp());
  let host = 'https://original.invalid';
  const requests: { path: string; body: unknown; headers: Headers }[] = [], messages: string[] = [];
  const context = { invokedByModel: false, print: (text: string) => messages.push(text), renderRequest() {},
    openSelection: ((title, items, opts, cb) => queue.request({ title, items, opts, callback: cb })) as OpenSelection };
  const commands = createTerminalCommandRegistry<typeof context>(), registry = new commands.CommandRegistry();
  const run = createTelegramCursorCommand<typeof context>({ isOwner: ctx => commands.isDirectOwnerCommandContext(ctx, 'channels'),
    owner: () => manager, home: () => root,
    read: (_ctx, observation) => ({ baseUrl: host, token: 'synthetic-private-token', identity: observation.observe([host], manager), expectedPrincipalId: 'pairing:owner' }),
    files: () => [credential], fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined, headers: new Headers(init?.headers) });
      if (url.pathname === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true,
        authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: 'pairing:owner', principalKind: 'token', admin: true,
        scopes: ['read:channels', 'write:channels'], roles: [] });
      const actionId = url.pathname.split('/').at(-1);
      if (actionId === 'cursor-migration-preview') return Response.json({ surface: 'telegram', actionId, result: preview });
      if (failWrite) return Response.json({ error: 'Preview changed' }, { status: 409 });
      return Response.json({ surface: 'telegram', actionId, result: { state: 'migrated', accountId: '111', offset: 501, running: true, message: 'Saved original position.' } });
    }) as typeof fetch });
  registry.register({ name: 'channels', description: 'Channels', async handler(_args, ctx) { await run(ctx); } });
  const choose = (id: string) => {
    const index = modal.filteredItems.findIndex(item => item.id === id); expect(index).toBeGreaterThanOrEqual(0); modal.selectedIndex = index;
    handleSelectionModalToken(ui, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
  };
  return { registry, context, modal, requests, messages, choose, credential, setHost: () => { host = 'https://replacement.invalid'; },
    open: () => registry.executeFromOwner('channels', ['telegram-cursor'], context) };
}

test('model dispatch cannot open recovery; a real owner reviews the bot before one exact write', async () => {
  const f = fixture(); await f.registry.execute('channels', ['telegram-cursor'], f.context);
  expect(f.requests).toEqual([]); expect(f.modal.active).toBe(false);
  await f.open(); expect(f.modal.items[0]?.id, f.messages.join('\n')).toBe('keep-blocked');
  expect(f.modal.items[1]?.detail).toContain('@original_bot'); expect(f.modal.items[1]?.detail).toContain('501');
  f.choose('migrate'); await until(() => f.messages.some(message => message.includes('Saved original position.')));
  const writes = f.requests.filter(request => request.path.endsWith('cursor-migration-commit'));
  expect(writes).toHaveLength(1); expect(writes[0]?.body).toEqual({ previewId: preview.previewId, confirm: true });
  expect(writes[0]?.headers.get('x-goodvibes-explicit-user-request')).toBe('true');
});

test('the displayed confirmation cannot be sent after the selected host changes', async () => {
  const f = fixture(); await f.open(); f.setHost(); f.choose('migrate');
  await until(() => f.messages.some(message => message.includes('changed')));
  expect(f.requests.filter(request => request.path.endsWith('cursor-migration-commit'))).toHaveLength(0);
});

test('a rejected migration is never retried using its consumed preview', async () => {
  const f = fixture(true); await f.open(); f.choose('migrate');
  await until(() => f.messages.some(message => message.includes('before trying again')));
  expect(f.requests.filter(request => request.path.endsWith('cursor-migration-commit'))).toHaveLength(1);
  expect(f.modal.active).toBe(false);
});
