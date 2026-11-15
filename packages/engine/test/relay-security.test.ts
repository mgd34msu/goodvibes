/**
 * relay-security.test.ts
 *
 * Unit coverage for the relay security posture: the WebAuthn step-up policy
 * decision, the mutating-verb signal, the via-relay request predicate, and
 * the certificate-minting PROHIBITION guard: the daemon never mints
 * certificates (no self-provisioned CA, ever), so no cert-minting symbol may
 * exist on the public relay/daemon surface or in the relay source tree.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isRelayTunneledRequest, RELAY_VIA_HEADER } from '../daemon-api/src/relay-registration.js';
import {
  STEP_UP_ASSERTION_HEADER,
  callNeedsStepUp,
  evaluateStepUp,
  isMutatingMethod,
  type StepUpAssertionVerifier,
} from '../platform/src/platform/relay/step-up-policy.js';
import { wrapDispatchWithStepUp, type RelayRequestFacts } from '../platform/src/platform/relay/daemon-wiring.js';
import * as relaySurface from '../platform/src/platform/relay/index.js';

describe('step-up policy decision', () => {
  const refused = { ok: false, reason: 'signature-invalid' } as const;

  test('only bites on mutating relay calls when required', () => {
    // Non-relay, or read-only, or requirement off → always allow.
    expect(evaluateStepUp({ viaRelay: false, mutating: true, requireStepUp: true, verification: refused }).allow).toBe(true);
    expect(evaluateStepUp({ viaRelay: true, mutating: false, requireStepUp: true, verification: refused }).allow).toBe(true);
    expect(evaluateStepUp({ viaRelay: true, mutating: true, requireStepUp: false, verification: refused }).allow).toBe(true);
  });

  test('denies when the assertion is absent or invalid, allows when genuinely verified', () => {
    const denied = evaluateStepUp({ viaRelay: true, mutating: true, requireStepUp: true, verification: refused });
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.code).toBe('step-up-required');
    expect(evaluateStepUp({ viaRelay: true, mutating: true, requireStepUp: true, verification: { ok: true } }).allow).toBe(true);
  });

  test('a cataloged call is judged by its scopes, an uncataloged one by its verb', () => {
    expect(callNeedsStepUp(['read:pairing'], 'POST')).toBe(false);
    expect(callNeedsStepUp(['write:control'], 'GET')).toBe(true);
    expect(callNeedsStepUp(['read:relay', 'write:relay'], 'POST')).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(callNeedsStepUp(null, m)).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(callNeedsStepUp(null, m)).toBe(true);
    expect(isMutatingMethod('DELETE')).toBe(true);
  });
});

describe('relay step-up gate with the daemon catalog', () => {
  const relayed = (path: string, method: string, assertion?: string): Request =>
    new Request(`http://daemon.local${path}`, { method, headers: { [RELAY_VIA_HEADER]: '1', ...(assertion ? { [STEP_UP_ASSERTION_HEADER]: assertion } : {}) } });
  const scopes: Record<string, readonly string[]> = {
    '/api/control-plane/methods/pairing.tokens.list/invoke': ['read:pairing'],
    '/api/status': ['write:control'],
  };
  const facts: RelayRequestFacts = {
    methodScopes: (req) => scopes[new URL(req.url).pathname] ?? null,
    principalId: () => 'pairing:phone',
  };
  const gate = { relayEnabled: () => true, requireStepUp: () => true, rendezvousId: () => 'rid-1' };
  const ran = async (): Promise<Response> => new Response('ran');

  test('a read invoked by POST runs without an assertion; a write bound to GET is refused', async () => {
    const seen: Array<string | null> = [];
    const verifier: StepUpAssertionVerifier = async (assertion) => {
      seen.push(assertion);
      return { ok: false, reason: 'assertion-missing' };
    };
    const dispatch = wrapDispatchWithStepUp(ran, gate, verifier, facts);
    expect((await dispatch(relayed('/api/control-plane/methods/pairing.tokens.list/invoke', 'POST')))!.status).toBe(200);
    const refusedWrite = (await dispatch(relayed('/api/status', 'GET')))!;
    expect(refusedWrite.status).toBe(401);
    expect(await refusedWrite.json()).toMatchObject({ code: 'step-up-required', reason: 'assertion-missing', action: 'sign' });
    expect(seen).toEqual([null]);
  });

  test('the verifier sees the calling principal, and a refusal names the reason and the action', async () => {
    const contexts: unknown[] = [];
    const verifier: StepUpAssertionVerifier = async (_assertion, context) => {
      contexts.push(context);
      return { ok: false, reason: 'no-credential' };
    };
    const response = (await wrapDispatchWithStepUp(ran, gate, verifier, facts)(relayed('/api/status', 'GET', 'signed')))!;
    expect(contexts).toEqual([{ method: 'GET', path: '/api/status', rendezvousId: 'rid-1', principalId: 'pairing:phone' }]);
    expect(response.headers.get('www-authenticate')).toBe('WebAuthn');
    expect(await response.json()).toMatchObject({ code: 'step-up-required', reason: 'no-credential', action: 'register-locally', recoverable: false });
  });
});

describe('via-relay request predicate', () => {
  test('detects the relay marker header', () => {
    expect(isRelayTunneledRequest(new Request('http://d/', { headers: { [RELAY_VIA_HEADER]: '1' } }))).toBe(true);
    expect(isRelayTunneledRequest(new Request('http://d/'))).toBe(false);
  });
});

describe('certificate-minting prohibition (the daemon never mints certificates)', () => {
  test('no cert-minting symbol exists on the public relay surface', () => {
    // The runtime export names of the relay barrel, the exact surface a
    // consumer composes from (and what ./daemon re-exports).
    const names = Object.keys(relaySurface);
    const offenders = names.filter((name) => /cert|x509|openssl/i.test(name));
    expect(offenders).toEqual([]);
  });

  test('no certificate-minting module exists in the relay source tree', () => {
    const relayDir = join(import.meta.dir, '..', 'platform', 'src', 'platform', 'relay');
    const files = readdirSync(relayDir);
    expect(files.some((file) => /cert/i.test(file))).toBe(false);
    // No relay source invokes openssl or self-signs anything.
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      // Comments may legitimately discuss the prohibition; only code is judged.
      const source = readFileSync(join(relayDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(source.includes('openssl'), `${file} must not orchestrate openssl`).toBe(false);
      expect(/self.signed/i.test(source), `${file} must not self-sign`).toBe(false);
    }
  });

  test('the daemon entry source exports no cert-minting name', () => {
    const daemonEntry = readFileSync(join(import.meta.dir, '..', 'platform', 'src', 'daemon.ts'), 'utf8');
    expect(/mint[A-Za-z]*Certificate|LanCert/i.test(daemonEntry)).toBe(false);
  });
});
