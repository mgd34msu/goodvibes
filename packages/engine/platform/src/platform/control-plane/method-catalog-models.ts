/**
 * method-catalog-models.ts, the model catalog and the daemon's current model.
 *
 * Three routes that have been served and called for a long time,
 * `GET /api/models`, `GET /api/models/current`, `PATCH /api/models/current`
 * (platform/daemon/http/model-routes.ts), and which no method descriptor
 * described. Every generated client is derived from this catalog, so a route
 * outside it is a route each consumer has to hand-write a row for: the web
 * surface did exactly that, and a hand-written row is a second statement of the
 * same shape with nothing keeping the two in step.
 *
 * These descriptors are the one statement of those shapes; the generated
 * contract and every client read them from here.
 *
 * `models.current.set` is a PATCH and NOT `models.select`: the id's verb tail is
 * the catalog's own vocabulary (core-verbs.ts), and setting the current model is
 * a plain `set` on one named thing. `select` would be a fourth word for it.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { nullableSchema } from './operator-contract-schemas-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/** How a provider's credentials were supplied, when it has any. */
const CONFIGURED_VIA_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: ['env', 'secrets', 'subscription', 'anonymous'],
};

/** One model, named the way the registry names it. */
const PROVIDER_MODEL_REF_SCHEMA = objectSchema({
  registryKey: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  id: STRING_SCHEMA,
}, ['registryKey', 'provider', 'id']);

/**
 * The reasoning levels one model actually offers, resolved by the same
 * precedence the turn path uses (live catalog, then a declaration on the exact
 * model, then the curated family table, then a labelled best guess). Absent on
 * a model that does not reason at all.
 */
const MODEL_REASONING_OPTIONS_SCHEMA = objectSchema({
  levels: arraySchema(STRING_SCHEMA),
  source: { type: 'string', enum: ['catalog', 'declared', 'family', 'fallback'] },
  effectiveByRequested: { type: 'object', additionalProperties: nullableSchema(STRING_SCHEMA) },
}, ['levels', 'source']);

const PROVIDER_MODEL_ENTRY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  registryKey: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  label: STRING_SCHEMA,
  contextWindow: NUMBER_SCHEMA,
  reasoningOptions: MODEL_REASONING_OPTIONS_SCHEMA,
  textWork: { type: 'string', enum: ['text', 'other', 'unknown'] },
  priceTier: { type: 'string', enum: ['free', 'paid', 'subscription', 'unknown'] },
  recommended: STRING_SCHEMA,
}, ['id', 'registryKey', 'provider', 'textWork', 'priceTier']);

/** One way a provider can be authenticated, and whether it currently is. */
const PROVIDER_AUTH_ROUTE_SCHEMA = objectSchema({
  route: { type: 'string', enum: ['api-key', 'secret-ref', 'service-oauth', 'subscription-oauth', 'anonymous', 'none'] },
  label: STRING_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  usable: BOOLEAN_SCHEMA,
  freshness: { type: 'string', enum: ['healthy', 'expiring', 'expired', 'pending', 'unconfigured'] },
  detail: STRING_SCHEMA,
  envVars: arraySchema(STRING_SCHEMA),
  secretKeys: arraySchema(STRING_SCHEMA),
  serviceNames: arraySchema(STRING_SCHEMA),
  providerId: STRING_SCHEMA,
  repairHints: arraySchema(STRING_SCHEMA),
}, ['route', 'label', 'configured']);

/** Where a provider's model list came from: the provider now, its last stored list, or the shared catalog. */
const MODEL_LIST_SOURCE_SCHEMA: Record<string, unknown> = { type: 'string', enum: ['live', 'cache', 'catalog'] };

/** One provider's model list as it stands: its source, when it was read, why its last reading failed. */
const MODEL_LIST_READING_SCHEMA = objectSchema({
  source: MODEL_LIST_SOURCE_SCHEMA,
  listedAt: NUMBER_SCHEMA,
  error: STRING_SCHEMA,
}, ['source']);

const PROVIDER_MODEL_PROVIDER_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  configuredVia: CONFIGURED_VIA_SCHEMA,
  envVars: arraySchema(STRING_SCHEMA),
  routes: arraySchema(PROVIDER_AUTH_ROUTE_SCHEMA),
  models: arraySchema(PROVIDER_MODEL_ENTRY_SCHEMA),
  modelList: MODEL_LIST_READING_SCHEMA,
}, ['id', 'label', 'configured', 'envVars', 'models', 'modelList']);

const MODEL_LIST_REFRESH_REPORT_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  models: NUMBER_SCHEMA,
  source: MODEL_LIST_SOURCE_SCHEMA,
  added: arraySchema(STRING_SCHEMA),
  removed: arraySchema(STRING_SCHEMA),
  listedAt: NUMBER_SCHEMA,
  error: STRING_SCHEMA,
  notAsked: BOOLEAN_SCHEMA,
}, ['providerId', 'label', 'models', 'source', 'added', 'removed']);

const CURRENT_MODEL_SCHEMA = objectSchema({
  model: { anyOf: [PROVIDER_MODEL_REF_SCHEMA, { type: 'null' }] },
  configured: BOOLEAN_SCHEMA,
  configuredVia: CONFIGURED_VIA_SCHEMA,
  routes: arraySchema(PROVIDER_AUTH_ROUTE_SCHEMA),
  effort: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
}, ['model', 'configured']);

export const builtinGatewayModelMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'models.list',
    title: 'Model Catalog',
    description: 'Every provider this daemon knows about with the models it offers, whether it is configured, and how it was configured. A GET also triggers the TTL-respecting live-discovery re-check that the terminal\'s model picker triggers on open: a provider\'s list stored more than 24 hours ago is read from the provider again, and the shared model catalog checked when its last check is that old; a list that changes is announced as a providers change, so every client reads it again. Each provider carries `modelList`: where its list came from (`live` from the provider, `cache` its last stored list, `catalog` the shared model catalog), `listedAt` when it was read, and `error` when the last reading from the provider failed. `currentModel` is the daemon\'s current selection, or null when nothing is selected. `secretsResolutionSkipped` is true when secret-backed credentials were not resolved for this read, so a caller can tell "not configured" from "not checked". Each model that reasons carries `reasoningOptions`: the levels it actually offers and which source resolved them; a model with no entry does not reason at all. Each model carries `textWork`, what the model catalog says about holding a conversation: `text`, `other` (an image, speech or embedding model) or `unknown`. Each model carries `priceTier`, what it costs to use: `free`, `paid` (charged per token), `subscription` (served through a plan the person signed in with) or `unknown`; a picker shows it beside the model, and a model the person uses that the catalog stops listing as free is announced as a PROVIDER_WARNING when the catalog is next checked. `pinned` are the registry keys of the models the person pinned and `recent` the ten used most recently, newest first: a picker lists pinned, then recent, then the rest, as the terminal\'s does. A connected provider\'s models may carry `recommended`, why the model is on that provider\'s short list of at most five, in catalog facts only ("newest claude-sonnet", "largest context: 1M tokens", "lowest price: $0.15 in, $0.60 out per 1M tokens"); a picker shows them after pinned and recent, and a provider the catalog gives no such facts for has none.',
    category: 'providers',
    effects: ['providers.read'],
    http: { method: 'GET', path: '/api/models' },
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      providers: arraySchema(PROVIDER_MODEL_PROVIDER_SCHEMA),
      currentModel: { anyOf: [PROVIDER_MODEL_REF_SCHEMA, { type: 'null' }] },
      pinned: arraySchema(STRING_SCHEMA),
      recent: arraySchema(STRING_SCHEMA),
      secretsResolutionSkipped: BOOLEAN_SCHEMA,
    }, ['providers', 'currentModel', 'pinned', 'recent', 'secretsResolutionSkipped']),
  }),
  methodDescriptor({
    id: 'models.current.get',
    title: 'Current Model',
    description: 'The model this daemon would use for a turn right now, with whether its provider is actually configured and by which authentication route. `model` is null when nothing is selected, which is a real state, not an error, and a caller rendering a picker needs to tell it from a selection whose provider has lost its credentials. `effort` is the persisted reasoning level, null when none has been set explicitly.',
    category: 'providers',
    effects: ['providers.read'],
    http: { method: 'GET', path: '/api/models/current' },
    inputSchema: objectSchema({}, []),
    outputSchema: CURRENT_MODEL_SCHEMA,
  }),
  methodDescriptor({
    id: 'models.current.set',
    repeat: 'safe',
    title: 'Switch the Current Model',
    description: 'Switch the daemon\'s current model live, by the registry key `models.list` returns. The switch applies to the next turn on every surface this daemon serves and is persisted, so it survives a restart; `persisted` says whether the write to settings succeeded. An unknown key is refused with MODEL_NOT_FOUND and a provider with no usable credentials with PROVIDER_NOT_CONFIGURED, naming the environment variables it looked for, a caller must not have to guess which of the two happened. An optional `effort` persists a reasoning level with the selection: it is validated against the known severity ladder here, and each turn maps it onto the active model\'s real options, snapping down and never promoting. It changes the model for every surface, so it needs an admin.',
    category: 'providers',
    effects: ['providers.administer'],
    dangerous: true,
    http: { method: 'PATCH', path: '/api/models/current' },
    inputSchema: objectSchema({ registryKey: STRING_SCHEMA, effort: { anyOf: [STRING_SCHEMA, { type: 'null' }] } }, ['registryKey']),
    outputSchema: objectSchema({
      model: { anyOf: [PROVIDER_MODEL_REF_SCHEMA, { type: 'null' }] },
      configured: BOOLEAN_SCHEMA,
      configuredVia: CONFIGURED_VIA_SCHEMA,
      routes: arraySchema(PROVIDER_AUTH_ROUTE_SCHEMA),
      effort: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
      persisted: BOOLEAN_SCHEMA,
    }, ['model', 'configured', 'persisted']),
  }),
  methodDescriptor({
    id: 'models.refresh',
    repeat: 'safe',
    title: 'Read the Model Lists Again',
    description: 'Read the model lists from the providers now, past each stored list: every provider, or the one named by `providerId`; the shared model catalog is checked with them. Answers each provider that has a listing of its own: how many models it lists now, `source` (`live` when it answered; `cache` or `catalog` when it did not), the models `added` and `removed`, `listedAt`, `error` when its list could not be read, and `notAsked` when it has no key or sign-in to list with yet. A list that changed is announced as a providers change, so every client reads it again. An unknown `providerId` is refused with PROVIDER_NOT_FOUND. It sends requests to the providers with the owner\'s credentials, so it needs an admin.',
    category: 'providers',
    effects: ['providers.administer'],
    http: { method: 'POST', path: '/api/models/refresh' },
    inputSchema: objectSchema({ providerId: STRING_SCHEMA }, []),
    outputSchema: objectSchema({ providers: arraySchema(MODEL_LIST_REFRESH_REPORT_SCHEMA) }, ['providers']),
  }),
  methodDescriptor({
    id: 'providers.subscription.signIn.begin',
    // A repeat starts a new sign-in that replaces the one still waiting; nothing is stored until a finish.
    repeat: 'safe',
    title: 'Begin A Subscription Sign-in',
    description: 'Begin signing in to a provider through its own sign-in page, from any client (the web UI\'s "Sign in again"), on the same code path as the terminal\'s /provider sign-in. Answers `authorizationUrl` (open it) and `finishes`: `on-its-own` when the provider returns to an address on the daemon\'s machine and a browser there completes it (the daemon then stores the sign-in and announces it with PROVIDERS_CHANGED), `paste` when the page shows a code or an address to send to providers.subscription.signIn.finish (a browser on another device always finishes this way). A new begin replaces one still waiting. Tokens are kept in the subscription store and never answered or logged. A provider with no subscription sign-in is refused 404; an API-key provider is signed in by storing its key with credentials.set. Admin, like the terminal command.',
    category: 'providers',
    effects: ['providers.administer'],
    transport: ['ws'],
    inputSchema: objectSchema({ provider: STRING_SCHEMA }, ['provider']),
    outputSchema: objectSchema({
      provider: STRING_SCHEMA,
      authorizationUrl: STRING_SCHEMA,
      finishes: { type: 'string', enum: ['on-its-own', 'paste'] },
      listenerNote: STRING_SCHEMA,
    }, ['provider', 'authorizationUrl', 'finishes']),
  }),
  methodDescriptor({
    id: 'providers.subscription.signIn.finish',
    // A code is used once: a repeat with the same code is refused by the provider, after the first stored the sign-in.
    repeat: 'unsafe',
    title: 'Finish A Subscription Sign-in',
    description: 'Finish a sign-in providers.subscription.signIn.begin started, with what the provider\'s page showed: the code, or the whole address it ended on (its state must match the begin). Stores the sign-in and announces it with PROVIDERS_CHANGED; answers the provider, `signedIn: true`, `tokenType` and `expiresAt`, never a token. A refused code is 400 with the provider\'s reason. Admin.',
    category: 'providers',
    effects: ['providers.administer'],
    transport: ['ws'],
    inputSchema: objectSchema({ provider: STRING_SCHEMA, code: STRING_SCHEMA }, ['provider', 'code']),
    outputSchema: objectSchema({
      provider: STRING_SCHEMA,
      signedIn: BOOLEAN_SCHEMA,
      tokenType: STRING_SCHEMA,
      expiresAt: NUMBER_SCHEMA,
    }, ['provider', 'signedIn', 'tokenType']),
  }),
  methodDescriptor({
    id: 'providers.apiKey.set',
    // Storing the same key again leaves the same state.
    repeat: 'safe',
    title: 'Store A Provider API Key',
    description: 'Sign an API-key provider in from any client (the web UI\'s provider row): `key` is stored in the secret store under the provider\'s own key name (the first of its key names the credential scope registry files, such as OPENAI_API_KEY), at the scope the ownership rules resolve (a key the daemon needs lands in the daemon tier), and the provider\'s credentials are read again, so its row reads signed in and PROVIDERS_CHANGED is announced. Answers `provider`, `keyName`, `scope` and `signedIn`; the key is never answered or logged. A provider that takes no key (one signed in with providers.subscription.signIn.begin) or whose key name is not filed is refused 400; an unknown provider 404; a goodvibes:// reference instead of a key 400. Admin.',
    category: 'providers',
    effects: ['providers.administer', 'secret.write'],
    transport: ['ws'],
    inputSchema: objectSchema({ provider: STRING_SCHEMA, key: STRING_SCHEMA }, ['provider', 'key']),
    outputSchema: objectSchema({
      provider: STRING_SCHEMA,
      keyName: STRING_SCHEMA,
      scope: STRING_SCHEMA,
      signedIn: BOOLEAN_SCHEMA,
    }, ['provider', 'keyName', 'scope', 'signedIn']),
  }),
];
