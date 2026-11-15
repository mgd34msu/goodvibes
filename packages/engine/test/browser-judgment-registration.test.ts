import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { BROWSER_JUDGMENT_BATTERY_IDS, BROWSER_JUDGMENT_BATTERY_VERSIONS, type AuthenticatedPrincipal, type BrowserJudgmentBatteryId } from '../daemon-api/src/index.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { builtinBrowserJudgmentMethodDescriptors } from '../platform/src/platform/control-plane/method-catalog-browser-judgment.ts';
import { createWebuiBrowserJudgment } from '../platform/src/platform/judgment-browser/webui-runtime.ts';

const owner: AuthenticatedPrincipal = { principalId: 'registration-fixture', principalKind: 'user', admin: false, scopes: ['write:judgment'] };
const text = { sessionId: 's', messageId: 'm', start: 0, end: 5, contentRevision: 'r' };
const inputs: Record<BrowserJudgmentBatteryId, unknown> = {
  'webui.voice.speech-seams': { ...text, cursor: 0 },
  'webui.errors.daemon-refusal': { errorRef: 'x' },
  'webui.palette.command-rank': { query: { kind: 'inline', text: 'a' }, registryVersion: 'v', candidates: [{ kind: 'builtin', commandId: 'a' }] },
  'webui.mail.reply-subject': { subjectRef: 'x' },
  'webui.credentials.provider-key': { providerId: 'p', keys: ['k'] },
  'webui.code.language': text,
  'webui.config.credential-key': { keys: ['k'] },
  'webui.settings.card-material-key': { keys: ['k'] },
  'webui.models.catalog-provider-match': { providerId: 'p', keys: ['k'] },
};

/** Ids still in the wire contract whose readings the web UI now decides in code; the runtime no longer serves them. */
const RETIRED = new Set<BrowserJudgmentBatteryId>(['webui.palette.command-rank', 'webui.credentials.provider-key', 'webui.code.language', 'webui.config.credential-key', 'webui.settings.card-material-key']);

test('every published battery id is served by the runtime, except the retired ones, and has a contract schema', async () => {
  const log = new SqliteDecisionLog(':memory:');
  const port: JudgmentPort = { model: 'jev-1.13.0', async ask() { throw new Error('no model call is expected'); } };
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(),
    currentRoute: () => ({ revision: 'fixture-route', kind: 'local', port: withDecisionLog(port, log), assertCurrent() {} }),
    authorize: () => false,
  });
  try {
    expect(Object.keys(inputs).sort()).toEqual([...BROWSER_JUDGMENT_BATTERY_IDS].sort());
    for (const battery of BROWSER_JUDGMENT_BATTERY_IDS) {
      const request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery, batteryVersion: BROWSER_JUDGMENT_BATTERY_VERSIONS[battery], input: inputs[battery] };
      const refusal = await service.execute(request, owner, new AbortController().signal, () => owner).catch((error: unknown) => error);
      if (RETIRED.has(battery)) { expect(refusal).toMatchObject({ code: 'JUDGMENT_BATTERY_UNKNOWN' }); continue; }
      expect(refusal).not.toMatchObject({ code: 'JUDGMENT_BATTERY_UNKNOWN' });
      expect(refusal).not.toMatchObject({ code: 'JUDGMENT_BATTERY_VERSION_UNSUPPORTED' });
    }
  } finally { await service.close(); log[Symbol.dispose](); }

  const [descriptor] = builtinBrowserJudgmentMethodDescriptors;
  type Branch = { properties?: { battery: { enum: string[] } }; anyOf?: Branch[] };
  const named = (schema: unknown) => (schema as { anyOf: Branch[] }).anyOf.map((branch) => (branch.properties ?? branch.anyOf![0]!.properties!).battery.enum[0]);
  expect(named(descriptor!.inputSchema).sort()).toEqual([...BROWSER_JUDGMENT_BATTERY_IDS].sort());
  expect(named(descriptor!.outputSchema).sort()).toEqual([...BROWSER_JUDGMENT_BATTERY_IDS].sort());
});
