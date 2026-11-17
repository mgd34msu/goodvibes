// Proves: Card number or security code reaches disk in plain text, an error message, a page read or the activity log.
// Red when: The security code is stored in plain text, or a driver error, a page read after the fill or the activity log carries the number or the code.
// Proves: On an install with no decision model, a page snapshot reports the value of a text box, select or misspelt input type, handing a typed card number to the model provider.
// Red when: The no-decision-model fallback in `classifyCardFields` reports a control's value instead of withholding it.
// Proves: With code handling set to "prompt" the security code is stored or an older stored one is still supplied; a deleted card's number stays in the secret store.
// Red when: `DaemonCardStore` writes the code under "prompt", hands back a code stored earlier once "prompt" is on, or a removed card leaves one of its five secret keys set.
/**
 * Card material goes to the daemon's encrypted secret store and nowhere else:
 * not in plain text on disk, not into a settings key a surface can write, not
 * into the activity log, not back out of a page the daemon typed it into, and
 * not through a browser error that quotes what it was asked to type.
 *
 * Real secret store, ownership rules, settings schema, card fill, redactor and
 * activity logger.
 * The checkout page is a stand-in for the merchant's browser page. The card
 * values are obvious fixtures.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../platform/src/platform/config/secrets.js';
import { daemonSecretKeyFor } from '../platform/src/platform/config/daemon-secret-keys.js';
import { CARD_MATERIAL_FIELDS, cardSecretKey, DaemonCardStore, type CvvHandling } from '../platform/src/platform/payments/host/card-store.js';
import { fillCard } from '../platform/src/platform/payments/fill-card.js';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.js';
import { CheckoutRegistry, MemoryCheckoutJournal, type InFlightCheckout } from '../platform/src/platform/payments/checkout-registry.js';
import type { CardMaterial, CardMaterialStore } from '../platform/src/platform/payments/card-material.js';
import type { CheckoutPageDriver } from '../platform/src/platform/payments/checkout-page.js';
import { ActivityLogger } from '../platform/src/platform/utils/logger.js';
import { installDecisionModelPolicyObserver } from '../errors/src/decision-policy.js';
import { classifyCardFields, type FormControlDescriptor } from '../platform/src/platform/security/card-fields.js';

const PAN = '4242424242424242';
const CVV_SENTINEL = 'CVV-SENTINEL-9f3a1c7d';
const CVV = '737';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function secrets(): { manager: SecretsManager; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'gv-cvv-containment-')); homes.push(home);
  const manager = new SecretsManager({ projectRoot: join(home, 'project'), globalHome: home, surfaceRoot: 'goodvibes', policy: 'require_secure' });
  return { manager, home };
}

function everyFile(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: full, text: readFileSync(full, 'latin1') });
    }
  };
  walk(root);
  return out;
}

test('a stored security code is encrypted on disk and still readable by the daemon', async () => {
  const { manager, home } = secrets();
  const key = daemonSecretKeyFor('payments.cards.card-1.cvv');
  await manager.set(key, CVV_SENTINEL, { scope: 'daemon', medium: 'secure' });
  const files = everyFile(home);
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter(file => file.text.includes(CVV_SENTINEL)).map(file => file.path)).toEqual([]);
  expect(await manager.get(key)).toBe(CVV_SENTINEL);
});

test('under "prompt" the security code is neither kept nor supplied, and a deleted card leaves no secret behind', async () => {
  const { manager, home } = secrets();
  let handling: CvvHandling = 'prompt';
  // The daemon's own adapter over its secret store (runtime/payments-composition.ts).
  const store = new DaemonCardStore({ filePath: join(home, 'payments-cards.json'), cvvHandling: () => handling, secrets: {
    get: key => manager.get(key),
    set: async (key, value) => { await manager.set(key, value, { scope: 'daemon', medium: 'secure' }); },
    delete: async key => { await manager.delete(key, { scope: 'daemon' }); },
  } });
  const card = { label: 'Test card', kind: 'virtual' as const, number: PAN, expiryMonth: 7, expiryYear: 2029, cvv: CVV,
    cardholderName: 'Pat Fixture', issuerCapMinorUnits: null };

  const prompted = await store.create(card);
  expect(await manager.get(cardSecretKey(prompted.id, 'cvv'))).toBeNull();
  expect(await store.read(prompted.id)).toBeNull();
  expect((await store.read(prompted.id, { securityCode: '123' }))?.cvv).toBe('123');

  handling = 'stored';
  const kept = await store.create(card);
  expect((await store.read(kept.id))?.cvv).toBe(CVV);
  handling = 'prompt';
  expect(await store.read(kept.id)).toBeNull();

  expect(await store.remove(kept.id)).toEqual({ deleted: true, secretsCleared: 5 });
  for (const field of CARD_MATERIAL_FIELDS) expect(`${field}: ${await manager.get(cardSecretKey(kept.id, field))}`).toBe(`${field}: null`);
});

const MATERIAL: CardMaterial = { number: PAN, expiryMonth: '07', expiryYear: '2029', cvv: CVV, cardholderName: 'Pat Fixture' };
const cards: CardMaterialStore = { metadata: async () => null, read: async () => MATERIAL };

async function armedCheckout(): Promise<CheckoutRegistry> {
  const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
  const checkout: InFlightCheckout = {
    purchaseId: 'pur-1', sessionId: 'session-1', pageId: 'page-1', merchantDomain: 'shop.example', cardId: 'card-1',
    item: 'a kettle' as InFlightCheckout['item'], currency: 'USD' as InFlightCheckout['currency'], phase: 'arming-payment',
    startedAtMs: 1_766_000_000_000, updatedAtMs: 1_766_000_000_000, draw: null, reservationId: 'res-1',
    shippingTierRequested: 'normal', shippingTierUsed: 'normal', stepDown: null, totalMinorUnits: 5_578,
  };
  await registry.open(checkout);
  return registry;
}

test('a browser error that quotes the typed card reaches no caller', async () => {
  const registry = await armedCheckout();
  const redactor = new CardMaterialRedactor();
  const driver = {
    url: async () => 'https://shop.example/checkout',
    fillSecrets: async (fields: readonly { readonly value: string }[]) => {
      throw new Error(`could not type ${fields.map(field => field.value).join(' / ')}`);
    },
  } as unknown as CheckoutPageDriver;
  const result = await fillCard({ sessionId: 'session-1', pageId: 'page-1', targets: [{ field: 'number', target: 'e1' }, { field: 'cvv', target: 'e2' }] },
    { registry, cards, redactor, driver });
  expect(result.ok).toBe(false);
  const reported = JSON.stringify(result);
  expect(reported).not.toContain(PAN);
  expect(reported).not.toContain(CVV);
});

test('after a fill, the page cannot read the number or code back out, however it is formatted', async () => {
  const registry = await armedCheckout();
  const redactor = new CardMaterialRedactor();
  const driver = {
    url: async () => 'https://shop.example/checkout',
    fillSecrets: async (fields: readonly { readonly target: string }[]) => ({ filledTargets: fields.map(field => field.target), failedTarget: null }),
  } as unknown as CheckoutPageDriver;
  const result = await fillCard({ sessionId: 'session-1', pageId: 'page-1', targets: [{ field: 'number', target: 'e1' }, { field: 'cvv', target: 'e2' }] },
    { registry, cards, redactor, driver });
  expect(result).toMatchObject({ ok: true, filled: ['number', 'cvv'] });
  const page = 'Card: 4242 4242 4242 4242, also 4242-4242-4242-4242. CVC 737. Total $41.73';
  const read = redactor.redact('session-1', 'page-1', page);
  expect(read.replace(/\D/g, '')).not.toContain(PAN);
  expect(read).not.toMatch(/(?<!\d)737(?!\d)/);
  expect(read).toContain('$41.73');
});

test('card material written into an activity log entry, in its message or its fields, never reaches the file', () => {
  const { home } = secrets();
  const log = new ActivityLogger();
  log.configure(join(home, 'logs'));
  log.warn(`Driver error: fill #cc ${PAN}, then 4242 4242 4242 4242 with security code ${CVV}`, {
    number: PAN, securityCode: CVV, csc: CVV, cvv: CVV, detail: `card ${PAN.replace(/(\d{4})(?=\d)/g, '$1-')}`, total: '$41.73',
  });
  log.flushSync();
  const written = readFileSync(join(home, 'logs', 'activity.md'), 'utf8');
  expect(written).toContain('Driver error');
  expect(written).toContain('$41.73');
  expect(written.replace(/\D/g, '')).not.toContain(PAN);
  expect(written).not.toMatch(/(?<!\d)737(?!\d)/);
  log.dispose();
});

function control(tag: string, type: string, name: string): FormControlDescriptor {
  return { tag, type, name, autocomplete: '', id: '', placeholder: '', ariaLabel: '', label: '' };
}

test('with no decision model only controls that cannot hold card material report their value', async () => {
  // The policy reads "no decision model set", as on an install that never chose one.
  installDecisionModelPolicyObserver(() => ({ policy: 'Hybrid', operation: 'no-decision-model', reason: 'not-set', revision: 1 }));
  const decisions = await classifyCardFields([
    control('select', '', 'exp-month'),
    control('input', 'creditcard', 'pan'),
    control('input', 'numeric', 'number'),
    control('input', 'text', 'card'),
    control('textarea', '', 'notes'),
    control('input', 'email', 'email'),
    control('input', 'checkbox', 'save'),
  ]);
  expect(decisions).toEqual([
    'no-decision-model', 'no-decision-model', 'no-decision-model', 'no-decision-model', 'no-decision-model',
    'reported', 'reported',
  ]);
});
