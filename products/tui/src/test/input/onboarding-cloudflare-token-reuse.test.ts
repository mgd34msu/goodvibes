import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { handleCloudflareOnboardingActionForHandler } from '../../input/handler-onboarding-cloudflare.ts';
import type { InputHandlerLike } from '../../input/handler-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeHarness(home: string): { handler: InputHandlerLike; fields: Map<string, string | boolean> } {
  const fields = new Map<string, string | boolean>([
    ['cloudflare.setup-source', 'bootstrap-token'],
    ['cloudflare.bootstrap-token', 'bootstrap-secret'],
  ]);
  const config: Record<string, unknown> = { 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 3421, 'controlPlane.publicBaseUrl': '' };
  const wizard = {
    runtimeSnapshot: undefined,
    steps: [],
    textState: new Map<string, string>(),
    getStringFieldValue: (id: string, fallback: string) => {
      const value = fields.get(id);
      return typeof value === 'string' ? value : fallback;
    },
    getBooleanFieldValue: (id: string, fallback: boolean) => {
      const value = fields.get(id);
      return typeof value === 'boolean' ? value : fallback;
    },
    clearApplyFeedback() {},
    setApplyFeedback() {},
    setStep() {},
    setFieldValue() {},
  };
  const handler = {
    onboardingApplyPending: false,
    onboardingWizard: wizard,
    uiServices: {
      platform: { configManager: { get: (key: string) => config[key] } },
      environment: { homeDirectory: home },
    },
    requestRender() {},
    refreshOnboardingHydration: async () => {},
  } as unknown as InputHandlerLike;
  return { handler, fields };
}

const realFetch = globalThis.fetch;
let home: string;
let tokenCreates: unknown[];
let provisions: Array<Record<string, unknown>>;

beforeEach(() => {
  home = makeProjectTempDir('cloudflare-token-reuse');
  tokenCreates = [];
  provisions = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith('/api/cloudflare/token/create')) {
      tokenCreates.push(body);
      const n = tokenCreates.length;
      return Response.json({ ok: true, tokenId: `id-${n}`, tokenName: `operational-${n}`, tokenSource: 'bootstrap', apiTokenRef: `goodvibes://secrets/token-${n}`, accountId: 'acct', permissions: [] });
    }
    if (url.endsWith('/api/cloudflare/provision')) {
      provisions.push(body);
      return Response.json({ ok: false, steps: [{ name: 'worker', status: 'warning', message: 'not ready' }] });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
});

describe('Cloudflare bootstrap provisioning', () => {
  test('retrying Provision reuses the operational token made for the same selection', async () => {
    const { handler } = makeHarness(home);
    await handleCloudflareOnboardingActionForHandler(handler, 'cloudflare-provision');
    await handleCloudflareOnboardingActionForHandler(handler, 'cloudflare-provision');

    expect(tokenCreates).toHaveLength(1);
    expect(provisions).toHaveLength(2);
    expect(provisions.map((body) => body.apiTokenRef)).toEqual(['goodvibes://secrets/token-1', 'goodvibes://secrets/token-1']);
  });

  test('provisioning after an explicit token creation does not make a second token', async () => {
    const { handler } = makeHarness(home);
    await handleCloudflareOnboardingActionForHandler(handler, 'cloudflare-create-operational-token');
    await handleCloudflareOnboardingActionForHandler(handler, 'cloudflare-provision');

    expect(tokenCreates).toHaveLength(1);
    expect(provisions[0]?.apiTokenRef).toBe('goodvibes://secrets/token-1');
  });

  test('a changed component selection gets its own token', async () => {
    const { handler, fields } = makeHarness(home);
    await handleCloudflareOnboardingActionForHandler(handler, 'cloudflare-provision');
    fields.set('cloudflare.component.r2', true);
    await handleCloudflareOnboardingActionForHandler(handler, 'cloudflare-provision');

    expect(tokenCreates).toHaveLength(2);
  });

  test('provisioning after the daemon persisted the zone from token creation does not make a second token', async () => {
    const { handler, fields } = makeHarness(home);
    fields.set('cloudflare.zone-id', 'zone-1');
    // Creating the token makes the daemon persist the zone, and the hydration refresh then
    // exposes it through the runtime snapshot, including a zone name the user never typed.
    const wizard = handler.onboardingWizard as unknown as { runtimeSnapshot: unknown };
    (handler as unknown as { refreshOnboardingHydration: () => Promise<void> }).refreshOnboardingHydration = async () => {
      wizard.runtimeSnapshot = { config: { cloudflare: { accountId: 'acct', zoneId: 'zone-1', zoneName: 'zone-1', apiTokenRef: '' } } };
    };
    await handleCloudflareOnboardingActionForHandler(handler, 'cloudflare-create-operational-token');
    await handleCloudflareOnboardingActionForHandler(handler, 'cloudflare-provision');

    expect(wizard.runtimeSnapshot).toBeDefined();
    expect(tokenCreates).toHaveLength(1);
  });
});
