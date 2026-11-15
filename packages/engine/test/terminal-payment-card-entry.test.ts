import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { createTerminalCommandRegistry } from '../terminal-shell/src/command-registry.js';
import type { ConcealedInputRequest } from '../terminal-shell/src/concealed-input.js';
import {
  CARD_ENTRY_FIELDS, createCardEntryPrompter, createPaymentCardCommands, createPaymentCardHost, describeCard, renderCardList,
  type CardSummary,
} from '../terminal-shell/src/card-field-prompts.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const NUMBER = '4242424242424242';
const CVV = '737';
const HOLDER = 'Jane Q Fixture';
const ANSWERS = ['groceries card', '', '4242 4242 4242 4242', '09/29', CVV, HOLDER];

function fixture(options: { readonly scopes?: readonly string[]; readonly createStatus?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-card-entry-')); roots.push(root);
  const credentialFile = join(root, 'paired.json'); writeFileSync(credentialFile, 'private credential source');
  const manager = new ConfigManager({ surfaceRoot: 'tui', configDir: root, workingDir: root, homeDir: root });
  const stored: CardSummary[] = [];
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    if (url.pathname === '/api/control-plane/auth') {
      return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true,
        sessionCookiePresent: false, principalId: 'pairing:owner', principalKind: 'token', admin: true,
        scopes: options.scopes ?? ['read:payments', 'write:payments'], roles: [] });
    }
    if (url.pathname === '/api/payments/cards' && init?.method === 'POST') {
      // A daemon error that quotes the request: the terminal must not pass it on.
      if (options.createStatus) return Response.json({ error: `rejected card ${NUMBER}` }, { status: options.createStatus });
      const input = body as { label: string; kind: 'virtual' | 'real'; number: string; expiryMonth: number; expiryYear: number };
      const card: CardSummary = { id: 'card-1', label: input.label, brand: 'visa', last4: input.number.slice(-4), kind: input.kind,
        expiryMonth: input.expiryMonth, expiryYear: input.expiryYear, issuerCapMinorUnits: null, materialComplete: true };
      stored.push(card);
      return Response.json({ card: { ...card, addedAt: '2026-01-01T00:00:00.000Z' } });
    }
    if (url.pathname === '/api/payments/cards') {
      return Response.json({ cards: stored.map(card => ({ ...card, addedAt: '2026-01-01T00:00:00.000Z' })), defaultCardId: stored[0]?.id ?? '' });
    }
    if (url.pathname.startsWith('/api/payments/cards/') && init?.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/payments/cards/'.length));
      const index = stored.findIndex(card => card.id === id);
      if (index >= 0) stored.splice(index, 1);
      return Response.json({ id, deleted: index >= 0, secretsCleared: index >= 0 ? 4 : 0 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const printed: string[] = [];
  const asked: ConcealedInputRequest[] = [];
  const context = {
    invokedByModel: false,
    print: (text: string) => printed.push(text),
    renderRequest() {},
    beginConcealedInput: (request: ConcealedInputRequest) => { asked.push(request); },
  };
  const host = createPaymentCardHost<typeof context>({
    owner: () => manager, home: () => root,
    read(_ctx, observation) { return { baseUrl: 'https://host.invalid', token: 'fixture-operator-bearer', identity: observation.observe(['https://host.invalid'], manager), expectedPrincipalId: 'pairing:owner' }; },
    files: () => [credentialFile], fetchImpl,
  });
  const prompter = createCardEntryPrompter<typeof context>((ctx, card) => host.create(ctx, card), {
    prompt: field => `ask ${field.label}`, stored: card => `stored ${describeCard(card)}`,
  });
  const commands = createTerminalCommandRegistry<typeof context>();
  const registry = new commands.CommandRegistry();
  createPaymentCardCommands<typeof context>({
    surface: 'tui', announcement: 'card entry', promptFields: prompter,
    status: async ctx => renderCardList(await host.list(ctx)),
    remove: (ctx, id) => host.remove(ctx, id),
    description: 'Payments', usage: '/payments', argsHint: '',
  }).registerPaymentCardCommands(registry);
  const submitAll = async (answers: readonly string[]) => {
    for (const answer of answers) {
      const request = asked.shift();
      if (!request) throw new Error('the flow did not ask for the next field');
      await request.onSubmit(answer);
    }
  };
  return { context, registry, printed, asked, requests, stored, submitAll,
    run: (args: string[]) => registry.execute('payments', args, context) };
}

const leaked = (text: string) => [NUMBER, '4242 4242 4242 4242', CVV, HOLDER].some(value => text.includes(value));

describe('/payments card on the selected daemon', () => {
  test('one create request carries the whole card and the daemon then lists it with its material complete', async () => {
    const f = fixture();
    await f.run(['card']);
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]?.label).toBe(CARD_ENTRY_FIELDS[0]?.label);
    await f.submitAll(ANSWERS);

    const creates = f.requests.filter(request => request.method === 'POST');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({ label: 'groceries card', kind: 'virtual', number: NUMBER, expiryMonth: 9, expiryYear: 2029,
      cvv: CVV, cardholderName: HOLDER, issuerCapMinorUnits: null });

    const afterEntry = f.printed.join('\n');
    expect(afterEntry).toContain('stored groceries card - virtual visa ending 4242, expires 09/2029');
    expect(leaked(afterEntry)).toBe(false);

    f.printed.length = 0;
    await f.run(['status']);
    const status = f.printed.join('\n');
    expect(status).toContain('groceries card - virtual visa ending 4242');
    expect(status).not.toContain('incomplete');
    expect(leaked(status)).toBe(false);
  });

  test('an invalid answer asks the same field again and nothing is sent', async () => {
    const f = fixture();
    await f.run(['card']);
    await f.submitAll(['groceries card', '', NUMBER, '13/29']);
    expect(f.asked[0]?.label).toBe('Expiry (MM/YY)');
    expect(f.printed.join('\n')).toContain('Expiry must look like MM/YY');
    expect(f.printed.join('\n')).toContain('Nothing has been sent');
    await f.submitAll(['09/29', CVV, HOLDER]);
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  test('Esc before the last answer discards the answers and sends nothing', async () => {
    const f = fixture();
    await f.run(['card']);
    await f.submitAll(ANSWERS.slice(0, 5));
    f.asked.shift()?.onCancel?.();
    expect(f.printed.join('\n')).toContain('Nothing was sent');
    expect(f.requests).toHaveLength(0);
    expect(f.stored).toHaveLength(0);
  });

  test('a daemon refusal prints fixed text, never the daemon message or the typed values', async () => {
    const f = fixture({ createStatus: 422 });
    await f.run(['card']);
    await f.submitAll(ANSWERS);
    const text = f.printed.join('\n');
    expect(text).toContain('Nothing was saved');
    expect(text).toContain('/payments card');
    expect(text).not.toContain('rejected card');
    expect(leaked(text)).toBe(false);
  });

  test('a credential without write:payments is refused before the card is sent', async () => {
    const f = fixture({ scopes: ['read:payments'] });
    await f.run(['card']);
    await f.submitAll(ANSWERS);
    expect(f.requests.some(request => request.method === 'POST')).toBe(false);
    expect(f.printed.join('\n')).toContain('write:payments');
    expect(f.printed.join('\n')).toContain('Nothing was sent');
  });

  test('a card the daemon holds without all its material is labelled incomplete', () => {
    const card: CardSummary = { id: 'c', label: 'old', brand: 'visa', last4: '4242', kind: 'real', expiryMonth: 1, expiryYear: 2030, issuerCapMinorUnits: null, materialComplete: false };
    expect(renderCardList({ cards: [card], defaultCardId: 'c' }).join('\n')).toContain('incomplete');
  });

  test('card remove asks for confirmation first, then deletes only the named card on the daemon', async () => {
    const f = fixture();
    await f.run(['card']);
    await f.submitAll(ANSWERS);
    f.printed.length = 0;
    f.requests.length = 0;

    await f.run(['card', 'remove', 'card-1']);
    expect(f.requests).toEqual([]);
    expect(f.stored).toHaveLength(1);
    expect(f.printed.join('\n')).toContain('/payments card remove card-1 confirm');

    await f.run(['card', 'remove', 'card-1', 'confirm']);
    expect(f.requests.filter(request => request.method === 'DELETE').map(request => request.path)).toEqual(['/api/payments/cards/card-1']);
    expect(f.stored).toHaveLength(0);
    expect(f.printed.join('\n')).toContain('was deleted from the selected daemon');

    f.printed.length = 0;
    await f.run(['card', 'remove', 'card-1', 'confirm']);
    expect(f.printed.join('\n')).toContain('no card with id card-1');
  });

  test('a model-run command cannot remove a card and sends nothing', async () => {
    const f = fixture();
    await f.run(['card']);
    await f.submitAll(ANSWERS);
    f.requests.length = 0;
    await f.registry.execute('payments', ['card', 'remove', 'card-1', 'confirm'], { ...f.context, invokedByModel: true });
    expect(f.requests).toEqual([]);
    expect(f.stored).toHaveLength(1);
  });

  test('status lists each card with the id remove takes', async () => {
    const f = fixture();
    await f.run(['card']);
    await f.submitAll(ANSWERS);
    f.printed.length = 0;
    await f.run(['status']);
    expect(f.printed.join('\n')).toContain('[id card-1]');
  });
});
