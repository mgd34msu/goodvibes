import { describe, expect, test } from 'bun:test';
import type { AuthenticatedPrincipal } from '../daemon-api/src/index.js';
import { BrowserJudgmentReferences } from '../platform/src/platform/judgment-browser/references.js';
import { BrowserJudgmentRegistry } from '../platform/src/platform/judgment-browser/registry.js';
import { BrowserJudgmentService } from '../platform/src/platform/judgment-browser/service.js';

const principal = { principalId: 'operator', principalKind: 'user', admin: true, scopes: ['write:judgment'] } as unknown as AuthenticatedPrincipal;

describe('browser judgment service with a battery the daemon has not registered', () => {
  test('answers that the battery is unknown instead of sending the operator to check model keys', async () => {
    const service = new BrowserJudgmentService({
      registry: new BrowserJudgmentRegistry(),
      references: new BrowserJudgmentReferences(),
      currentRoute: () => undefined,
      authorize: () => true,
    });
    const request = { protocolVersion: 1, requestId: '12345678-1234-4234-9234-123456789abc', battery: 'webui.errors.daemon-refusal', batteryVersion: 1, input: { errorRef: 'fixture-error' } };
    await expect(service.execute(request, principal, new AbortController().signal, () => principal))
      .rejects.toMatchObject({ code: 'JUDGMENT_BATTERY_UNKNOWN', status: 404 });
    await service.close();
  });
});
