// Proves: A caller refused a knowledge write at its catalog path reaches the same write through the Agent's knowledge alias path.
// Red when: The REST access gate looks the alias path up as it arrives instead of as the catalog path it serves, finds no catalog entry and lets the call through.
/**
 * The daemon serves the Agent's knowledge routes under
 * /api/goodvibes-agent/knowledge as aliases of /api/knowledge. The real REST
 * access gate over the real method catalog: a paired device holding only
 * read scopes is refused a knowledge ingest at either path; the owner is let
 * through at the alias.
 */
import { expect, test } from 'bun:test';
import { actorFromPrincipal, NO_OWNER_USER, type Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { gateGatewayBinding } from '../platform/src/platform/daemon/http/gateway-binding-gate.ts';
import { AGENT_KNOWLEDGE_PREFIX } from '../platform/src/platform/daemon/http/route-manifest.ts';

test('a device refused a knowledge write at its catalog path is refused it at the Agent alias path; the owner is not', () => {
  const catalog = new GatewayMethodCatalog();
  const readOnlyDevice = actorFromPrincipal({
    principalId: 'pairing:reader', principalKind: 'token', credentialKind: 'device-token', admin: false, scopes: ['read:knowledge', 'read:knowledge-content'],
  }, NO_OWNER_USER);
  const owner = actorFromPrincipal({ principalId: 'owner', principalKind: 'token', credentialKind: 'shared-token', admin: true, scopes: ['*'] }, NO_OWNER_USER);
  const status = (path: string, actor: Actor): number | 'let through' => {
    const refused = gateGatewayBinding(new Request(`http://127.0.0.1:3421${path}`, { method: 'POST' }), {
      gatewayMethods: catalog,
      authenticateRequest: () => ({ principal: { actor } }),
    });
    return refused ? refused.status : 'let through';
  };

  expect({
    catalogPath: status('/api/knowledge/ingest/url', readOnlyDevice),
    aliasPath: status(`${AGENT_KNOWLEDGE_PREFIX}/ingest/url`, readOnlyDevice),
    ownerAtAlias: status(`${AGENT_KNOWLEDGE_PREFIX}/ingest/url`, owner),
  }).toEqual({ catalogPath: 403, aliasPath: 403, ownerAtAlias: 'let through' });
});
