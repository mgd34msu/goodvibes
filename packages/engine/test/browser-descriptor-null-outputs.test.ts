/**
 * The browser verbs' output schemas describe what the engine really returns:
 * a fact that does not apply (no profile on an attached browser, no driver on a
 * machine without one) is null, and a client that validates responses must
 * accept that instead of failing the call after it succeeded.
 */
import { expect, test } from 'bun:test';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import type { BrowserSessionInfo } from '../platform/src/platform/browser/browser-types.ts';

const outputSchemaOf = (id: string): Record<string, unknown> => {
  const schema = new GatewayMethodCatalog().get(id)?.outputSchema;
  if (!schema) throw new Error(`${id} has no output schema`);
  return schema;
};

const attached: BrowserSessionInfo = {
  sessionId: 'bs-1', origin: 'attached', profileDirectory: null, cdpEndpoint: 'http://127.0.0.1:9222', executablePath: null,
  source: null, headless: false, startedAt: '2026-01-01T00:00:00.000Z', pageCount: 0, activePageId: null, closableByAgent: false,
};

test('status on a machine with no browser provisioned validates', () => {
  const body = {
    browserAvailable: false, binarySource: null, executablePath: null, driverVersion: null, browsersPath: '/home/u/.browsers',
    displayAvailable: false, defaultMode: 'headless (no display on this machine)', sessions: [attached], provisionSteps: [],
    problem: 'No browser is installed.', fix: 'Run browser.provision.',
  };
  expect(firstJsonSchemaFailure(outputSchemaOf('browser.status'), body)).toBeUndefined();
});

test('listing and attaching a session with no profile, executable or page validates', () => {
  expect(firstJsonSchemaFailure(outputSchemaOf('browser.sessions.list'), { sessions: [attached] })).toBeUndefined();
  expect(firstJsonSchemaFailure(outputSchemaOf('browser.sessions.attach'), { session: attached, pages: [] })).toBeUndefined();
});

test('a field that is neither a string nor null is still refused', () => {
  const failure = firstJsonSchemaFailure(outputSchemaOf('browser.sessions.list'), { sessions: [{ ...attached, profileDirectory: 5 }] });
  expect(failure).toBeDefined();
});
