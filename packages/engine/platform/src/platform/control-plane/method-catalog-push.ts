/**
 * method-catalog-push.ts
 *
 * Browser-push (Web Push) verb descriptors: the VAPID public-key read, and the
 * subscription lifecycle (register / list / delete / verify) a PWA uses to
 * receive approvals and completions as notifications.
 *
 * These are pure descriptors so `buildOperatorContract` / the generated catalog
 * / api docs see them; the handlers are attached at RuntimeServices construction
 * time in routes/push.ts (the same `catalog.register(descriptor, handler)`
 * pattern fleet.* uses), reached over HTTP through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint.
 *
 * Verb tails follow docs/decisions/2026-07-06-core-verb-spec.md: register is
 * `create`, unregister is `delete`, the collection read is `list`, the public
 * key read is `get`. `verify` (send a live test push to prove the round trip)
 * is not a generic CRUD word, it is documented in the `push-delivery` exempt
 * category in packages/contracts/src/core-verbs.ts.
 *
 * Like the other handler-registered verb groups (fleet.*, checkpoints.*,
 * sessions.search) these declare `transport: ['ws']` and carry NO dedicated
 * REST `http` binding: they are served by the registered in-process handler
 * through the generic `/api/control-plane/methods/{id}/invoke` endpoint, not by
 * a path route in the external daemon-api package. Advertising an `http` path
 * that no route serves would trip the capability-advertisement honesty gate
 * (method-catalog-route-reconcile.ts), so it is deliberately omitted.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const PUSH_SUBSCRIPTION_KEYS_SCHEMA = objectSchema({
  p256dh: STRING_SCHEMA,
  auth: STRING_SCHEMA,
}, ['p256dh', 'auth']);

/** The wire-safe (redacted) subscription view, no capability URL, no key material. */
const PUBLIC_PUSH_SUBSCRIPTION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  principalId: STRING_SCHEMA,
  deviceId: STRING_SCHEMA,
  endpointOrigin: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  lastDeliveryAt: NUMBER_SCHEMA,
  lastOutcome: STRING_SCHEMA,
  consecutiveFailures: NUMBER_SCHEMA,
}, ['id', 'principalId', 'endpointOrigin', 'createdAt']);

/** Why a device was removed: the push service said it was gone or kept rejecting it, or the record was unusable. */
const PUSH_SUBSCRIPTION_REMOVAL_SCHEMA = objectSchema({
  subscriptionId: STRING_SCHEMA,
  principalId: STRING_SCHEMA,
  endpointOrigin: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  evidence: STRING_SCHEMA,
  removedAt: NUMBER_SCHEMA,
}, ['subscriptionId', 'principalId', 'endpointOrigin', 'reason', 'evidence', 'removedAt']);

const PUSH_DELIVERY_RECEIPT_SCHEMA = objectSchema({
  subscriptionId: STRING_SCHEMA,
  endpointOrigin: STRING_SCHEMA,
  outcome: STRING_SCHEMA,
  httpStatus: NUMBER_SCHEMA,
  detail: STRING_SCHEMA,
}, ['subscriptionId', 'endpointOrigin', 'outcome']);

export const builtinGatewayPushMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'push.vapid.get',
    title: 'Get Web Push Public Key',
    description: 'Return the daemon\'s public VAPID key (base64url application-server key) that a browser client passes to pushManager.subscribe(). The matching private key never leaves the daemon and is never returned by any verb.',
    category: 'push',
    scopes: ['read:push'],
    transport: ['ws'],
    outputSchema: objectSchema({ publicKey: STRING_SCHEMA }, ['publicKey']),
  }),
  methodDescriptor({
    id: 'push.subscriptions.create',
    title: 'Register Web Push Subscription',
    description: 'Store a browser Push subscription (endpoint capability URL + p256dh/auth keys) for the authenticated operator so the daemon can deliver notifications to that device. When a stable deviceId is supplied the record reconciles on that device identity, a browser whose push endpoint rotated re-registers the same deviceId with a new endpoint and heals the one record in place rather than piling up a stale duplicate; without a deviceId it reconciles on the raw endpoint (legacy). The stored endpoint and keys are never returned over the wire; the response is the redacted subscription view.',
    category: 'push',
    scopes: ['write:push'],
    transport: ['ws'],
    inputSchema: objectSchema({
      endpoint: STRING_SCHEMA,
      keys: PUSH_SUBSCRIPTION_KEYS_SCHEMA,
      deviceId: STRING_SCHEMA,
    }, ['endpoint', 'keys']),
    outputSchema: objectSchema({ subscription: PUBLIC_PUSH_SUBSCRIPTION_SCHEMA }, ['subscription']),
  }),
  methodDescriptor({
    id: 'push.subscriptions.reconcile',
    title: 'Reconcile Web Push Subscription',
    description: 'Reconcile-on-open: the client presents its device identity (deviceId) and its CURRENT endpoint + p256dh/auth keys, and the daemon heals the record for that device in place, updating a stale endpoint the daemon had been holding, then reports what drifted (created / endpoint-updated / keys-updated / unchanged) so the client learns whether the daemon was out of date. A live reconcile also clears the bounded-retry failure counter. The stored endpoint and keys are never returned; the response is the redacted subscription view plus the drift discriminant.',
    category: 'push',
    scopes: ['write:push'],
    transport: ['ws'],
    inputSchema: objectSchema({
      deviceId: STRING_SCHEMA,
      endpoint: STRING_SCHEMA,
      keys: PUSH_SUBSCRIPTION_KEYS_SCHEMA,
    }, ['deviceId', 'endpoint', 'keys']),
    outputSchema: objectSchema({
      subscription: PUBLIC_PUSH_SUBSCRIPTION_SCHEMA,
      drift: STRING_SCHEMA,
    }, ['subscription', 'drift']),
  }),
  methodDescriptor({
    id: 'push.subscriptions.list',
    title: 'List Web Push Subscriptions',
    description: 'List the authenticated operator\'s registered push devices as redacted subscription views (id, deviceId when the record has one, endpoint origin, timestamps, last delivery outcome; two records on the same push service share an origin, so tell them apart by id or deviceId), plus lastRemoval: the most recent device the daemon removed and why (reason gone: the push service answered 404/410; failure-threshold: the push service rejected the endpoint push.subscriptions.failureThreshold times in a row; unusable or malformed: the stored record could never receive a push). Network errors, timeouts, rate limits and push-service outages never remove a device. The capability URL and key material are never included.',
    category: 'push',
    scopes: ['read:push'],
    transport: ['ws'],
    outputSchema: objectSchema({
      subscriptions: arraySchema(PUBLIC_PUSH_SUBSCRIPTION_SCHEMA),
      lastRemoval: PUSH_SUBSCRIPTION_REMOVAL_SCHEMA,
    }, ['subscriptions']),
  }),
  methodDescriptor({
    id: 'push.subscriptions.delete',
    title: 'Delete Web Push Subscription',
    description: 'Permanently remove one of the authenticated operator\'s push subscriptions: the stored record (endpoint + keys) is dropped and cannot be listed afterward. An unknown id, or one owned by another principal, is a 404 SUBSCRIPTION_NOT_FOUND, never a 200-noop.',
    category: 'push',
    scopes: ['write:push'],
    transport: ['ws'],
    inputSchema: objectSchema({ subscriptionId: STRING_SCHEMA }, ['subscriptionId']),
    outputSchema: objectSchema({
      subscriptionId: STRING_SCHEMA,
      deleted: BOOLEAN_SCHEMA,
    }, ['subscriptionId', 'deleted']),
  }),
  methodDescriptor({
    id: 'push.subscriptions.verify',
    title: 'Send Test Web Push',
    description: 'Send a live test notification to one of the authenticated operator\'s subscriptions and return an honest delivery receipt (delivered / pruned / failed). A subscription whose endpoint reports 404/410 gone, or that the push service has now rejected push.subscriptions.failureThreshold times in a row, is pruned as part of the attempt and the receipt says so; a network error, timeout, 408, 413, 429 or 5xx is reported as failed and never counts against the device. An unknown id, or one owned by another principal, is a 404 SUBSCRIPTION_NOT_FOUND.',
    category: 'push',
    scopes: ['write:push'],
    transport: ['ws'],
    inputSchema: objectSchema({ subscriptionId: STRING_SCHEMA }, ['subscriptionId']),
    outputSchema: objectSchema({ receipt: PUSH_DELIVERY_RECEIPT_SCHEMA }, ['receipt']),
  }),
];
