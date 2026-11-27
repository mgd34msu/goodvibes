// Proves: A request the owner's ChatGPT subscription refused for a reason other than the model is sent again on the owner's paid OpenAI API key, or later requests stay on the key.
// Red when: The subscription's 400 about a parameter is read as a refusal of the model (`refusedModel` matching loosely), so the same request, and any later one, reaches the API key's endpoint.
/**
 * With both sign-ins set up, a request goes to the subscription and moves to
 * the API key only when the subscription refuses the model itself (its
 * `model_not_found`) or fails as a sign-in. A 400 about a parameter is the
 * request's own fault: it is reported, the API key is not charged for it, and
 * the next request goes to the subscription again. The real OpenAIProvider and
 * subscription store over a temp file; both OpenAI endpoints are stand-ins at
 * the HTTP wire that record what arrived.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIProvider } from '../platform/src/platform/providers/openai.ts';
import { SubscriptionManager } from '../platform/src/platform/config/subscriptions.ts';
import { BASE64URL, syntheticChars, syntheticCredential } from '../platform/src/platform/utils/fixture-credentials.ts';

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base64url = (text: string) => Buffer.from(text).toString('base64url');

test('a subscription 400 about a parameter is not sent again on the API key, and the next request stays on the subscription', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-openai-routes-'));
  dirs.push(dir);
  const subscriptions = new SubscriptionManager(join(dir, 'subscriptions.json'));
  const now = Date.now();
  await subscriptions.saveSubscription({
    provider: 'openai',
    accessToken: [base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), base64url(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fixture' } })), syntheticChars('openai-routes', 43, BASE64URL)].join('.'),
    tokenType: 'Bearer', expiresAt: now + 3_600_000, authMode: 'oauth', overrideAmbientApiKeys: false, createdAt: now, updatedAt: now,
  });
  const provider = new OpenAIProvider(syntheticCredential('sk-', 'openai-routes', 48), undefined, undefined, { subscriptionManager: subscriptions });

  let subscriptionAnswer = { code: '', message: '' };
  const arrived: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://chatgpt.com/')) {
      arrived.push('subscription');
      return Response.json({ error: subscriptionAnswer }, { status: 400 });
    }
    arrived.push('api-key');
    return Response.json({ error: { message: 'stand-in', type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 });
  }) as typeof fetch;
  const ask = () => provider.chat({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'hello' }] }).then(() => null, (error: unknown) => error);

  subscriptionAnswer = { code: 'unsupported_parameter', message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." };
  const first = await ask();
  const second = await ask();
  expect({ refused: [first instanceof Error, second instanceof Error], arrived }).toEqual({ refused: [true, true], arrived: ['subscription', 'subscription'] });

  // Control: a refusal of the model itself moves the request to the API key.
  arrived.length = 0;
  subscriptionAnswer = { code: 'model_not_found', message: 'The model gpt-5.1 is not available on your plan.' };
  await ask();
  expect(arrived).toEqual(['subscription', 'api-key']);
});
