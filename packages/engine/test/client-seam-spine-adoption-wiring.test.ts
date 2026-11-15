/**
 * A refreshed daemon token must reach the wire bundle, and an adoption that
 * fails part-way must be undone so the next signal starts clean.
 */
import { expect, test } from 'bun:test';
import { createSpineAdoptionSync } from '../platform/src/platform/runtime/client/spine-adoption.ts';
import type { SpineWireBundle } from '../platform/src/platform/runtime/client/spine-adoption.ts';

function harness(unionActivate: () => void = () => {}) {
  const events: string[] = [];
  const tokens: string[] = [];
  const bundle = (): SpineWireBundle => ({
    sessionTransport: { register: async () => ({ outcome: 'ok' }) as never, close: async () => ({ outcome: 'ok' }) as never },
    inboundInputs: { listInputs: async () => ({ inputs: [] }) as never, deliverInput: async () => ({}) },
    sessionList: { list: async () => [] },
  });
  const sync = createSpineAdoptionSync({
    sessionSpine: {
      activate: () => { events.push('session:activate'); },
      deactivate: () => { events.push('session:deactivate'); },
      foldLegacyRecords: () => ({ folded: 0 }) as never,
    },
    sessionInboundInputs: {
      activate: () => { events.push('inbound:activate'); },
      deactivate: () => { events.push('inbound:deactivate'); },
    },
    sessionUnionCache: {
      activate: () => { events.push('union:activate'); unionActivate(); },
      deactivate: () => { events.push('union:deactivate'); },
    },
    connect: (_baseUrl, token) => { tokens.push(token); return bundle(); },
    legacyStorePath: '/nonexistent/spine-adoption-wiring/sessions.json',
    workingDirectory: '/nonexistent/spine-adoption-wiring',
    onDetached: () => { events.push('detached'); },
    log: { info: () => {}, debug: () => {} },
  });
  return { sync, events, tokens };
}

test('the same daemon with a refreshed token is reconnected with the new token', () => {
  const { sync, tokens, events } = harness();
  sync({ mode: 'external', baseUrl: 'http://127.0.0.1:1' }, 'token-a');
  sync({ mode: 'external', baseUrl: 'http://127.0.0.1:1' }, 'token-a');
  expect(tokens).toEqual(['token-a']);
  sync({ mode: 'external', baseUrl: 'http://127.0.0.1:1' }, 'token-b');
  expect(tokens).toEqual(['token-a', 'token-b']);
  expect(events).toContain('detached');
});

test('an adoption that throws part-way is undone, and the next signal retries it', () => {
  let failing = true;
  const { sync, events, tokens } = harness(() => { if (failing) throw new Error('union refused'); });
  expect(() => sync({ mode: 'external', baseUrl: 'http://127.0.0.1:1' }, 'token-a')).toThrow('union refused');
  expect(events).toContain('detached');
  expect(events).toContain('inbound:deactivate');
  failing = false;
  sync({ mode: 'external', baseUrl: 'http://127.0.0.1:1' }, 'token-a');
  expect(tokens).toEqual(['token-a', 'token-a']);
});
