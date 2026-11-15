/**
 * An external (ACP, MCP, CI) admission uses a fresh request id, so nothing
 * but the admission itself can release the manager's bookkeeping for it: it
 * retires its id once when the response is consumed or the admission closes.
 */
import { expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { admitExternalRequest, type ExternalPermissionHost } from '../platform/src/platform/permissions/external-request.ts';

function fixture(approved: boolean) {
  const admitted: string[] = [];
  const retired: string[] = [];
  let claims = 0;
  const host: ExternalPermissionHost = {
    port: {} as JudgmentPort,
    workspaceTrust: null,
    signal: new AbortController().signal,
    config: { onDidInvalidate: () => () => undefined },
    permissionManager: {
      async admitAutonomous(sourceId: string) {
        admitted.push(sourceId);
        return { result: { approved }, revisionIds: [], claim() { claims++; } } as never;
      },
      retireAutonomousSource(sourceId: string) { retired.push(sourceId); },
    },
  };
  const scope = { connectionId: 'c', destination: 'd', signal: new AbortController().signal, assertCurrent() {} };
  const operation = { sourceOf: () => ({ goal: 'Read project data', criteria: [] }), assertCurrent() {} };
  const admit = () => admitExternalRequest(host, scope, operation, { tool: 'read', args: { path: 'src' } });
  return { admit, admitted, retired, claims: () => claims };
}

test('a consumed response retires its request id once', async () => {
  const fx = fixture(true);
  const admission = await admit(fx);
  admission.claim();
  admission.close();
  expect(fx.claims()).toBe(1);
  expect(fx.retired).toEqual(fx.admitted);
});

test('a denied or abandoned admission retires its id on close, and a second close does nothing', async () => {
  const fx = fixture(false);
  const admission = await admit(fx);
  expect(fx.retired).toEqual([]);
  admission.close();
  admission.close();
  expect(fx.retired).toEqual(fx.admitted);
  expect(fx.retired).toHaveLength(1);
});

test('every admission retires its own id', async () => {
  const fx = fixture(true);
  for (let i = 0; i < 3; i++) (await fx.admit()).close();
  expect(new Set(fx.retired).size).toBe(3);
  expect(fx.retired).toEqual(fx.admitted);
});

function admit(fx: ReturnType<typeof fixture>) { return fx.admit(); }
