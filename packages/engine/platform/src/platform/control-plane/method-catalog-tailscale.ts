/**
 * method-catalog-tailscale.ts
 *
 * Tailscale auto-wire verbs: read-only detection of a usable tailscale
 * environment, the one-action affordance that sets up `tailscale serve` for
 * the daemon's web surface (the recommended https path, because the daemon
 * NEVER mints certificates), and the verb that stops it again. Where tailscale
 * is absent, detection says so once and nothing nags.
 *
 * Like the other handler-registered verb groups these declare
 * `transport: ['ws']` and are served through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/** The honest record of one serve or stop attempt. */
const TAILSCALE_SERVE_RECEIPT_SCHEMA = objectSchema({
  at: NUMBER_SCHEMA,
  action: { type: 'string', enum: ['serve', 'stop'] },
  command: STRING_SCHEMA,
  ok: BOOLEAN_SCHEMA,
  url: STRING_SCHEMA,
  port: NUMBER_SCHEMA,
  previousPublicBaseUrl: STRING_SCHEMA,
  enableUrl: STRING_SCHEMA,
  detail: STRING_SCHEMA,
}, ['at', 'command', 'ok', 'detail']);

export const builtinGatewayTailscaleMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'tailscale.get',
    title: 'Detect Tailscale Environment',
    description: 'READ-ONLY detection of a usable tailscale environment: binary present, logged-in status, MagicDNS name, and the https URL `tailscale serve` would yield. Never invokes a state-changing tailscale command. Where tailscale is absent the result says so once, surfaces offer the auto-wire affordance only when this reports a usable environment; nothing nags. Includes the most recent serve or stop receipt (lastServe), and activeServe: the serve this daemon started and has not stopped, which tailscale keeps on until tailscale.serve.stop runs.',
    category: 'remote-access',
    scopes: ['read:control-plane'],
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      available: BOOLEAN_SCHEMA,
      loggedIn: BOOLEAN_SCHEMA,
      magicDnsName: STRING_SCHEMA,
      httpsUrl: STRING_SCHEMA,
      detail: STRING_SCHEMA,
      lastServe: TAILSCALE_SERVE_RECEIPT_SCHEMA,
      activeServe: TAILSCALE_SERVE_RECEIPT_SCHEMA,
    }, ['available', 'loggedIn', 'detail']),
  }),
  methodDescriptor({
    id: 'tailscale.serve.run',
    title: 'Set Up Tailscale Serve For The Daemon',
    description: 'The one-action https affordance: run `tailscale serve --bg <web port>` so tailscale fronts the daemon\'s web surface at its https MagicDNS URL. Run only from this explicit user-initiated verb. The serve persists in tailscaled, also after the daemon stops or restarts, until tailscale.serve.stop runs. The attempt is recorded with an honest receipt either way (when tailscale prints a link to turn Serve on for the tailnet, the receipt carries it as enableUrl); on success web.publicBaseUrl is updated to the https URL from the same resolution and the value it replaced is kept for the stop. The daemon never mints certificates, TLS is terminated by tailscale.',
    category: 'remote-access',
    scopes: ['write:control-plane'],
    // Runs a host command and rewrites web.publicBaseUrl, which changes every
    // pairing and link URL the daemon emits: admin, like config.set. The empty
    // input schema makes the dispatch gate validate (and reject) a stray body.
    access: 'admin',
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      receipt: TAILSCALE_SERVE_RECEIPT_SCHEMA,
      publicBaseUrlUpdated: BOOLEAN_SCHEMA,
      receiptRecorded: BOOLEAN_SCHEMA,
    }, ['receipt', 'publicBaseUrlUpdated', 'receiptRecorded']),
  }),
  methodDescriptor({
    id: 'tailscale.serve.stop',
    title: 'Stop Tailscale Serve For The Daemon',
    description: 'Stop publishing the daemon to the tailnet: run `tailscale serve --https=443 off`, which removes what tailscale.serve.run started. The attempt is recorded with an honest receipt either way. On success, when web.publicBaseUrl still names the tailnet URL, it is put back to the value it had before the serve (cleared when none was recorded); publicBaseUrlDetail says what happened to it.',
    category: 'remote-access',
    scopes: ['write:control-plane'],
    // Runs a host command and rewrites web.publicBaseUrl: admin, like serve.run.
    access: 'admin',
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      receipt: TAILSCALE_SERVE_RECEIPT_SCHEMA,
      publicBaseUrlRestored: BOOLEAN_SCHEMA,
      publicBaseUrlDetail: STRING_SCHEMA,
      receiptRecorded: BOOLEAN_SCHEMA,
    }, ['receipt', 'publicBaseUrlRestored', 'publicBaseUrlDetail', 'receiptRecorded']),
  }),
];
