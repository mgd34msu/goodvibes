// Proves: A message sent into a session counts as typed by the owner at their own program only when the daemon authenticated a person's credential of the owner, the program's label and a person's claim, never on the caller's word.
// Red when: The session message route keeps a caller's own owner-typed mark, or stamps it for a credential that cannot make a person's claim, for a request without the claim, or for one that names no terminal program.
// Proves: A web chat message is the owner's own turn only from their own sign-in or their terminal program the daemon registered, never from a copied operator token or a paired device.
// Red when: The web chat's owner check takes the operator token with no program registration, a paired device (the owner's own included), or any credential of an owner-class actor, as the owner in person.
/**
 * A session the daemon hosts runs a message stamped "typed by the owner at their own program" as the owner's own turn:
 * its edits and commands run in the session's project under the owner's mode. Everything else fed to it stays an input-only
 * instruction. So the stamp is a permission boundary, and it is set in one place: the session message routes
 * (daemon-api `runtime-session-routes.ts`, `OWNER_TYPED_METADATA_KEY`) from the router's check of the request
 * (`daemon/http/owner-typed.ts`). The real routes and the real session broker over their files; the credential each
 * request was authenticated with is given as the authenticated principal, as the router hands it over.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonRuntimeSessionRouteHandlers, OWNER_TYPED_METADATA_KEY } from '../daemon-api/src/index.ts';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/index.ts';
import { localOwnerActor, type RequestPrincipal } from '../daemon-api/src/http-policy.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { buildRouterSessionBrokerAdapter } from '../platform/src/platform/daemon/http/router-session-broker-adapter.ts';
import { ownerHimselfOf, ownerTypedAtProgram } from '../platform/src/platform/daemon/http/owner-typed.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function principal(credentialKind: RequestPrincipal['credentialKind']): RequestPrincipal {
  // A device the owner paired in person is the actor the daemon builds for it (daemon-api actor.ts): an admin marked as
  // the owner's device, never the owner in person.
  const actor = credentialKind === 'device-token'
    ? Object.freeze({ class: 'admin' as const, id: 'pairing:owner-phone', scopes: 'all' as const, via: 'http' as const, ownerDevice: { madeFromIt: [] } })
    : localOwnerActor();
  return {
    principalId: credentialKind === 'device-token' ? 'pairing:owner-phone' : 'owner', principalKind: credentialKind === 'device-token' ? 'token' : 'user',
    admin: true, scopes: ['*'], scopeSet: new Set(['*']), roles: [], credentialKind, authRevision: 1, actor,
  };
}

test('a message is marked typed by the owner only for a person\'s credential of the owner, a program\'s label and a person\'s claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-owner-typed-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  // The agent fleet is the stand-in: the one agent answering this conversation is running.
  const broker = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: (id: string) => (id === 'agent-answering' ? { id, status: 'running' } : null) } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]['agentStatusProvider'],
    messageSender: { send: () => false },
  });
  await broker.start();
  cleanups.push(() => broker.stop());
  // A conversation whose agent is answering, so each message sent now waits in its inputs as it arrived.
  const route = await routeBindings.upsertBinding({ kind: 'channel', surfaceKind: 'webhook', surfaceId: 'webhook', externalId: 'hosted', channelId: 'hosted' });
  const first = await broker.submitMessage({ routeId: route.id, surfaceKind: 'webhook', surfaceId: 'webhook', externalId: 'hosted', body: 'first', providerMessageId: 'first' });
  await broker.bindAgent(first.session.id, 'agent-answering', first.input!.id);

  // The credential each request was authenticated with, and the program registration the router checked and bound for
  // it, as the router hands them to the route.
  const authenticated = new WeakMap<Request, RequestPrincipal>();
  const registered = new WeakMap<Request, string>();
  const handlers = createDaemonRuntimeSessionRouteHandlers({
    sessionBroker: buildRouterSessionBrokerAdapter(broker),
    parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
    requireAdmin: () => null,
    recordApiResponse: (_req: Request, _path: string, response: Response) => response,
    ownerTypedAtProgram: (req: Request) => ownerTypedAtProgram(authenticated.get(req), req.headers, registered.get(req)),
  } as unknown as DaemonRuntimeRouteContext);

  const marked = async (label: string, credential: RequestPrincipal['credentialKind'], headers: Record<string, string>, metadata?: Record<string, unknown>, registration?: string): Promise<string> => {
    const req = new Request(`http://daemon.local/api/sessions/${first.session.id}/follow-up`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ body: label, surfaceKind: 'tui', surfaceId: 'tui:test', ...(metadata ? { metadata } : {}) }),
    });
    authenticated.set(req, principal(credential));
    if (registration) registered.set(req, registration);
    const answer = await handlers.postSharedSessionFollowUp(first.session.id, req);
    if (answer.status >= 300) return `${label} answered ${answer.status}`;
    const input = broker.getInputs(first.session.id).find((row) => row.body === label);
    return `${label} ${input?.metadata?.[OWNER_TYPED_METADATA_KEY] === true ? 'owner typed' : 'not owner typed'}`;
  };
  const program = { 'x-goodvibes-client': 'tui' };
  const claim = { 'x-goodvibes-explicit-user-request': 'true' };
  const rows = [
    await marked('owner here, registered program, claim', 'local', { ...program, ...claim }, undefined, 'tui'),
    await marked('operator token, no registration, program, claim', 'local', { ...program, ...claim }),
    await marked('owner here, registered program, no claim', 'local', program, undefined, 'tui'),
    await marked('no claim, own mark', 'local', program, { [OWNER_TYPED_METADATA_KEY]: true }, 'tui'),
    await marked('shared token from elsewhere', 'shared-token', { ...program, ...claim }),
    await marked('agent credential', 'agent', { ...program, ...claim }),
    await marked('no program named', 'local', claim, undefined, 'tui'),
    await marked('paired device, program, claim', 'device-token', { 'x-goodvibes-client': 'agent', ...claim }),
  ];
  expect(rows).toEqual([
    'owner here, registered program, claim owner typed',
    'operator token, no registration, program, claim not owner typed',
    'owner here, registered program, no claim not owner typed',
    'no claim, own mark not owner typed',
    'shared token from elsewhere not owner typed',
    'agent credential not owner typed',
    'no program named not owner typed',
    'paired device, program, claim not owner typed',
  ]);
});

test('a web chat message is the owner\'s turn from their sign-in or their registered program, never from a copied operator token or a paired device', () => {
  // The router asks this of every web chat message, edit and steer (router.ts `isOwnerCaller`), with the credential it
  // authenticated and the program registration it checked; the chat runs the message as the owner's turn on yes.
  const rows = ([
    ['the owner\'s sign-in', 'user-session', undefined],
    ['the owner\'s paired device', 'device-token', undefined],
    ['the owner\'s terminal app, registered', 'local', 'tui'],
    ['the operator token copied elsewhere, no registration', 'local', undefined],
    ['the operator token naming a program it never registered', 'local', 'browser'],
    ['a shared token from elsewhere', 'shared-token', undefined],
    ['the Agent\'s credential', 'agent', undefined],
  ] as const).map(([label, credential, registration]) => `${label}: ${ownerHimselfOf(principal(credential), registration) ? 'the owner\'s turn' : 'someone else\'s input'}`);
  expect(rows).toEqual([
    'the owner\'s sign-in: the owner\'s turn',
    'the owner\'s paired device: someone else\'s input',
    'the owner\'s terminal app, registered: the owner\'s turn',
    'the operator token copied elsewhere, no registration: someone else\'s input',
    'the operator token naming a program it never registered: someone else\'s input',
    'a shared token from elsewhere: someone else\'s input',
    'the Agent\'s credential: someone else\'s input',
  ]);
});
