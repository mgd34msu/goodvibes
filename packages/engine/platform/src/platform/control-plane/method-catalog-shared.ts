import type { RuntimeEventDomain } from '../runtime/events/index.js';
import type { ContractErrorCode, ContractReplayKey } from '../types/foundation-contract.js';
import type { NativeExecutionAuthority } from '../security/http-auth.js';
import type { Actor, CredentialKind } from '../daemon/http-policy.js';
import { effectFacts, type EffectId } from '../security/effect-authority.js';
export type { NativeExecutionAuthority, NativePairedSnapshot } from '../security/http-auth.js';

export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'public' | 'authenticated' | 'admin' | 'remote-peer';
export type GatewayEventTransport = 'sse' | 'ws' | 'internal';
/**
 * What calling a method does beyond this daemon: `read` changes nothing,
 * `write` changes state the owner holds here, `outward` sends something to a
 * third party or a provider (a message, an invitation, a remote command,
 * metered model work). A caller that must not let read content cause a send
 * asks for a send admission on every `outward` method.
 */
export type GatewayMethodEffect = 'read' | 'write' | 'outward';
/** What a repeat of a method does; see `GatewayMethodDescriptor.repeat`. */
export type GatewayMethodRepeat = 'safe' | 'keyed' | 'unsafe';

export interface GatewayHttpBinding {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  /**
   * The status a success answers with, declared once here: the daemon's router
   * answers a success with it and the generated specs list it. Absent: 200.
   */
  readonly successStatus?: 201 | 202 | undefined;
}

export interface GatewayMethodDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly access: GatewayMethodAccess;
  readonly transport: readonly GatewayMethodTransport[];
  readonly scopes: readonly string[];
  readonly http?: GatewayHttpBinding | undefined;
  readonly events?: readonly string[] | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly pluginId?: string | undefined;
  readonly dangerous?: boolean | undefined;
  /**
   * What calling the method causes, as rows of the effect table
   * (security/effect-authority.ts). Every builtin method declares them, and
   * its `access`, `scopes`, `ownerOnly`, `irreversible`, `changesContract`
   * and `effect` are computed from them; admission reads them
   * (`admitEffects`). A plugin's method declares access and scopes instead.
   */
  readonly effects?: readonly EffectId[] | undefined;
  /** Set by `methodDescriptor` for every builtin method; see `GatewayMethodEffect`. */
  readonly effect?: GatewayMethodEffect | undefined;
  /**
   * The owner's own act (answering a purchase window or the owner inbox, typing
   * a card security code): the daemon takes it only from the owner's authority
   * as the transport established it, and an agent is refused and told how the
   * owner does it.
   */
  readonly ownerOnly?: boolean | undefined;
  /**
   * The call cannot be undone (it deletes what nothing restores, or ends work
   * for good): an agent's call is the owner's to decide, and Jev is never
   * offered it (gate/classify.ts `irreversible-operator`).
   */
  readonly irreversible?: boolean | undefined;
  /** The call changes what a running contract requires: an agent's call is the owner's to decide (`change-contract`). */
  readonly changesContract?: boolean | undefined;
  /**
   * Where in the input the recipients a call sends to as the owner sit, as
   * argument paths (`to`, `attendees[]`): an agent's send to one he has not
   * allowed is his to decide (`new-recipient`).
   */
  readonly recipients?: readonly string[] | undefined;
  /** The header or body field that makes a retry safe; the route that reads it is its owner. */
  readonly replay?: ContractReplayKey | undefined;
  /**
   * What sending the same call twice does, read from its handler: `safe`, the
   * repeat changes nothing more (it sets what is already set, or finds the
   * thing already gone); `keyed`, safe when the call carries its `replay` key;
   * `unsafe`, the repeat acts again (a second record, a second message, a
   * second run). `methodDescriptor` sets `keyed` for a method with `replay`
   * and `safe` for a read; every other builtin states it.
   */
  readonly repeat?: GatewayMethodRepeat | undefined;
  /** Codes this method's route puts on an error body beyond the shared engine codes. */
  readonly errorCodes?: readonly ContractErrorCode[] | undefined;
  /**
   * Defaults to `true`. When explicitly `false`, this method is NOT dispatchable
   * through the generic HTTP/WS method-invocation surface
   * (`invokeGatewayMethodCall`/`invokeWebSocketControlPlaneCall` in
   * `../daemon/control-plane.ts`, guarded by `validateGatewayInvocation`, which
   * rejects it with an honest 400 `NOT_INVOKABLE` before any handler or route is
   * even considered), nothing more, nothing less.
   *
   * This is a statement about ONE dispatch path, not a claim that the method can
   * never run anywhere. Two independent reasons a descriptor carries
   * `invokable: false`:
   *  - No route or internal handler exists at all for this build (e.g. `email.*`,
   *    `calendar.*`, cataloged so the contract is honest about the capability's
   *    shape, but genuinely unavailable everywhere).
   *  - A real route DOES exist and IS served (e.g. `voice.tts.stream`,
   *    `control.events.stream`, `artifacts.content.get`), just not through the
   *    generic JSON-envelope invoke path, the response is binary/streaming/HTML
   *    (see `metadata.responseKind`) and callers must use the direct HTTP path
   *    instead.
   *
   * A runtime that registers a real in-process handler for this method id (via
   * `GatewayMethodCatalog.register(descriptor, handler)`) and calls
   * `GatewayMethodCatalog.invoke()` DIRECTLY (bypassing `validateGatewayInvocation`)
   * still serves it, `invoke()` itself does not consult this flag, by design: a
   * consuming runtime that has wired up a genuine handler is authoritative over
   * whether the method actually works, this descriptor is not. `invoke()` only
   * refuses when BOTH `invokable === false` AND no handler is registered, see
   * `method-catalog.ts`'s `invoke()`.
   */
  readonly invokable?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GatewayEventDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly transport: readonly GatewayEventTransport[];
  readonly scopes: readonly string[];
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
  readonly wireEvents?: readonly string[] | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly pluginId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GatewayMethodInvocationContext {
  readonly principalId?: string | undefined;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
  readonly admin?: boolean | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly clientKind?: string | undefined;
  readonly authToken?: string | undefined;
  /**
   * Which credential the transport authenticated the caller with. Set only by
   * the transport; `agent` is the GoodVibes Agent calling on the owner's
   * behalf, and the calls it makes are judged by that.
   */
  readonly credentialKind?: CredentialKind | undefined;
  /**
   * Set only by the transport: who is causing what this call does (actor.ts),
   * derived once from the credential it authenticated. A handler that decides
   * an effect beyond its declared ones (a write that loosens a setting) admits
   * it for this actor (`admitEffects`). Absent for a call the daemon makes
   * in-process, which is the program's own (`systemActor`).
   */
  readonly actor?: Actor | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GatewayMethodInvocation {
  /** Transport-created, nonserialized paired owner. Never copied from body/context metadata. */
  readonly nativeExecutionAuthority?: NativeExecutionAuthority | undefined;
  /** Trusted transport lifecycle and live authorization; never parsed from payloads. */
  readonly signal?: AbortSignal | undefined;
  readonly isAuthorized?: ((requiredScopes?: readonly string[]) => boolean) | undefined;
  readonly body?: unknown | undefined;
  readonly query?: Record<string, unknown> | undefined;
  readonly context: GatewayMethodInvocationContext;
}

export type GatewayMethodHandler = (input: GatewayMethodInvocation) => unknown | Promise<unknown>;
export interface GatewayMethodListOptions {
  readonly category?: string | undefined;
  readonly source?: GatewayMethodSource | undefined;
  readonly pluginId?: string | undefined;
}

export interface GatewayEventListOptions {
  readonly category?: string | undefined;
  readonly source?: GatewayMethodSource | undefined;
  readonly pluginId?: string | undefined;
  readonly domain?: RuntimeEventDomain | undefined;
}

export const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
export const STRING_SCHEMA = { type: 'string' } as const;
export const BOOLEAN_SCHEMA = { type: 'boolean' } as const;
export const NUMBER_SCHEMA = { type: 'number' } as const;
const NULL_SCHEMA = { type: 'null' } as const;
export const JSON_VALUE_SCHEMA: Record<string, unknown> = {};
export const JSON_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: JSON_VALUE_SCHEMA,
};
export const JSON_ARRAY_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: JSON_VALUE_SCHEMA,
};

Object.assign(JSON_VALUE_SCHEMA, {
  anyOf: [
    STRING_SCHEMA,
    NUMBER_SCHEMA,
    BOOLEAN_SCHEMA,
    NULL_SCHEMA,
    JSON_OBJECT_SCHEMA,
    JSON_ARRAY_SCHEMA,
  ],
});

export function arraySchema(itemSchema: Record<string, unknown>): Record<string, unknown> {
  return { type: 'array', items: itemSchema };
}

export function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: readonly string[] = [],
  options: { readonly additionalProperties?: boolean } = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: options.additionalProperties ?? false,
  };
}

export const GATEWAY_HTTP_BINDING_SCHEMA = objectSchema({
  method: STRING_SCHEMA,
  path: STRING_SCHEMA,
}, ['method', 'path']);

export const METHOD_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  description: STRING_SCHEMA,
  category: STRING_SCHEMA,
  source: STRING_SCHEMA,
  access: STRING_SCHEMA,
  transport: arraySchema(STRING_SCHEMA),
  scopes: arraySchema(STRING_SCHEMA),
  http: GATEWAY_HTTP_BINDING_SCHEMA,
  events: arraySchema(STRING_SCHEMA),
  inputSchema: JSON_OBJECT_SCHEMA,
  outputSchema: JSON_OBJECT_SCHEMA,
  pluginId: STRING_SCHEMA,
  dangerous: BOOLEAN_SCHEMA,
  effects: arraySchema(STRING_SCHEMA),
  effect: stringEnumSchema(['read', 'write', 'outward']),
  ownerOnly: BOOLEAN_SCHEMA,
  irreversible: BOOLEAN_SCHEMA,
  changesContract: BOOLEAN_SCHEMA,
  recipients: arraySchema(STRING_SCHEMA),
  invokable: BOOLEAN_SCHEMA,
  replay: objectSchema({ in: STRING_SCHEMA, name: STRING_SCHEMA, behavior: STRING_SCHEMA }, ['in', 'name', 'behavior']),
  repeat: stringEnumSchema(['safe', 'keyed', 'unsafe']),
  errorCodes: arraySchema(objectSchema({ code: STRING_SCHEMA, status: NUMBER_SCHEMA, meaning: STRING_SCHEMA }, ['code', 'status', 'meaning'])),
  metadata: JSON_OBJECT_SCHEMA,
}, ['id', 'title', 'description', 'category', 'source', 'access', 'transport', 'scopes']);

export const EVENT_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  description: STRING_SCHEMA,
  category: STRING_SCHEMA,
  source: STRING_SCHEMA,
  transport: arraySchema(STRING_SCHEMA),
  scopes: arraySchema(STRING_SCHEMA),
  domains: arraySchema(STRING_SCHEMA),
  wireEvents: arraySchema(STRING_SCHEMA),
  outputSchema: JSON_OBJECT_SCHEMA,
  pluginId: STRING_SCHEMA,
  metadata: JSON_OBJECT_SCHEMA,
}, ['id', 'title', 'description', 'category', 'source', 'transport', 'scopes']);

export function listOutputSchema(
  key: string,
  itemSchema: Record<string, unknown>,
): Record<string, unknown> {
  return objectSchema({ [key]: arraySchema(itemSchema) }, [key], { additionalProperties: false });
}

/**
 * The listing envelope a daemon route sends (daemon-api pagination.ts
 * `listingEnvelope`): one object holding the page (`items`, `hasMore`,
 * `nextCursor` while more remain) and the same items again under the
 * resource's own key, with or without `limit`/`cursor`. `extra` adds the
 * route's own optional fields.
 */
export function listingOutputSchema(
  key: string,
  itemSchema: Record<string, unknown>,
  extra: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  return objectSchema({
    items: arraySchema(itemSchema),
    hasMore: BOOLEAN_SCHEMA,
    nextCursor: STRING_SCHEMA,
    [key]: arraySchema(itemSchema),
    ...extra,
  }, ['items', 'hasMore', key]);
}

export function entityOutputSchema(
  key: string,
  entitySchema: Record<string, unknown>,
): Record<string, unknown> {
  return objectSchema({ [key]: entitySchema }, [key], { additionalProperties: false });
}

export function actionResultOutputSchema(
  key: string,
  entitySchema: Record<string, unknown>,
): Record<string, unknown> {
  return objectSchema({
    [key]: entitySchema,
  }, [key], { additionalProperties: true });
}

export function bodyEnvelopeSchema(
  properties: Record<string, Record<string, unknown>> = {},
  required: readonly string[] = [],
  options: { readonly dependentRequired?: Readonly<Record<string, readonly string[]>> } = {},
): Record<string, unknown> {
  return {
    ...objectSchema({ ...properties }, required, { additionalProperties: true }),
    ...(options.dependentRequired ? { dependentRequired: { ...options.dependentRequired } } : {}),
  };
}

/**
 * An input schema for a verb whose required set is CONDITIONAL, "id when kind
 * names a specific item", "one of dataBase64/text/path/uri", "cron when the
 * schedule is a cron".
 *
 * Handlers like these refuse a call that a flat `required` array calls valid,
 * and the flat array cannot be repaired by adding the field: `id` is genuinely
 * not required for `kind: 'overview'`, so declaring it required would refuse
 * calls that work today.
 *
 * The encoding is a BASE schema, every property, plus whatever is required
 * unconditionally, carrying an `anyOf` of small requirement branches. Both
 * consumers read it that way:
 *   - `invoke-input-validation.ts` checks the base first and then requires one
 *     branch to match (proper JSON Schema conjunction).
 *   - `scripts/check-foundation-io-types.ts` renders it as `Base & (B1 | B2)`.
 *
 * Why factored rather than a union of whole objects, which reads more directly:
 * repeating a thirty-property object four times, twice (automation's job and
 * schedule create verbs), made the operator client's method map exceed
 * TypeScript's union-complexity limit outright, `client-core.ts` stopped
 * compiling with TS2590. Intersecting one base with small branches says the
 * same thing at a fraction of the type size.
 *
 * Each branch must still be a real object schema naming its own required
 * fields as properties, with `additionalProperties: true` so it constrains
 * only what it names, `requirementBranch` builds that shape. A bare
 * `{ required: [...] }` fragment would render as `unknown`, which is how
 * `knowledge.ingest.connector` ended up with no consumer type at all.
 */
export function branchedSchema(
  base: Record<string, unknown>,
  requirementBranches: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { ...base, anyOf: [...requirementBranches] };
}

/**
 * One requirement branch: the fields this alternative makes mandatory, and
 * nothing else. Anything the branch does not name is left to the base schema,
 * which is where the full property list and the open-ended body envelope live.
 *
 * The branch is `additionalProperties: true`, and that is not incidental. These
 * schemas are PUBLISHED, they become the operator contract artifact and the
 * OpenAPI document that third-party validators read. A branch saying
 * `{ required: ['text'], additionalProperties: false }` inside an `anyOf`
 * rejects `{ text: 'hello', kind: 'note' }`, because the only branch that
 * accepts `text` forbids `kind`. Our own invoke gate never enforces
 * `additionalProperties` so nothing would break here, and the published
 * contract would be quietly wrong for everyone else, the worst kind of wrong,
 * since it reads as more precise.
 *
 * `scripts/check-foundation-io-types.ts` drops the resulting index signature
 * when it renders a branch, because the base it is intersected with already
 * carries one. Stating it once rather than once per branch is what keeps the
 * client's method map inside TypeScript's union-complexity limit.
 */
export function requirementBranch(
  properties: Record<string, Record<string, unknown>>,
  required: readonly string[],
): Record<string, unknown> {
  return objectSchema(properties, required, { additionalProperties: true });
}

/** A string constrained to a fixed set of values. */
export function stringEnumSchema(values: readonly string[]): Record<string, unknown> {
  return { type: 'string', enum: [...values] };
}

/**
 * A string enum for a published schema that must list every member of a source
 * union: `exhaustiveStringEnumSchema<Kind>()([...])` refuses to compile when a
 * member of `Kind` is missing from the list (and when the list holds a value
 * that is not a member), so the daemon cannot serve a value its own schema rejects.
 */
export function exhaustiveStringEnumSchema<Member extends string>() {
  return <const Listed extends readonly Member[]>(
    values: Listed,
    // Empty when every member is listed; otherwise one required argument named after the gap.
    ...uncovered: [Exclude<Member, Listed[number]>] extends [never] ? [] : [missing: Exclude<Member, Listed[number]>]
  ): Record<string, unknown> => {
    void uncovered;
    return stringEnumSchema(values);
  };
}

/** A method is a read when every scope it needs is a read scope, else a write; `outward` comes from its effects. */
function defaultMethodEffect(scopes: readonly string[]): GatewayMethodEffect {
  return scopes.length > 0 && scopes.every((scope) => scope.startsWith('read:')) ? 'read' : 'write';
}

/**
 * Read scopes over the owner's content: mail, the owner profile, purchases and
 * cards, the dates he keeps, memory, transcripts, paired devices and peers,
 * his calendar, approvals and the questions waiting on him, the people he
 * named, workspace file contents, and the records of his browser, knowledge,
 * channels, automations, fleet and skills. They are not in the default grant
 * of a credential without the admin role (method-catalog.ts
 * `grantedGatewayScopes`); a paired device whose pairing stores its own scope
 * list holds them when the list names them. Such a user keeps the status of
 * each area (counts, states, names, configuration) on its ordinary read scope.
 *
 * - `read:transcripts`: every read that returns conversation or message text:
 *   shared session messages and inputs, queued messages, companion chat
 *   history and its stream, the messages surfaces received
 *   (`control.messages.list`, `control.snapshot`, the surface-message event),
 *   an agent task's prompt, progress and result (`tasks.get`, `tasks.status`;
 *   `tasks.list` serves its counts and states without it), batch requests and
 *   answers, check-in briefings and the messages they sent, and the session
 *   listings (`sessions.list`, `sessions.search`, `sessions.hosted.list`,
 *   `sessions.integration.snapshot`, `companion.chat.sessions.list`), whose
 *   titles come from what was said and whose participants name the people in
 *   each conversation.
 * - `read:pairing`, `read:remote`: paired devices, device nodes and their
 *   grants, remote peers, their pair requests and the work sent to them.
 * - `read:checkpoints`: workspace file contents (checkpoint diffs and
 *   previews, a session's changes, a rewind plan).
 * - `read:calendar`, `read:approvals`, `read:principals`: every read in the area.
 * - `read:browser-content`, `read:knowledge-content`, `read:channel-content`,
 *   `read:automation-content`, `read:fleet-content`, `read:skill-content`: the
 *   records of an area whose status stays on `read:browser`, `read:knowledge`,
 *   `read:channels`, `read:automation`, `read:fleet` and `read:skills`.
 *   Delivery records (they name the recipient) are automation records, and
 *   route bindings (a chat's title and who wrote from it) channel records.
 *
 * A contract is shown only to the principal that started it.
 */
export const OWNER_PRIVATE_READ_SCOPES: ReadonlySet<string> = new Set([
  'read:email', 'read:profile', 'read:profile-document', 'read:payments', 'read:occasions', 'read:memory',
  'read:transcripts', 'read:pairing', 'read:remote', 'read:checkpoints', 'read:calendar', 'read:approvals',
  'read:principals', 'read:browser-content', 'read:knowledge-content', 'read:channel-content',
  'read:automation-content', 'read:fleet-content', 'read:skill-content',
]);

/** Scopes whose admin writes change who can sign in or what the daemon is allowed to do. */
const ACCESS_AND_SETTINGS_WRITE_SCOPES: ReadonlySet<string> = new Set(['write:auth', 'write:config']);

/** The fields a builtin method's effects decide; a builtin descriptor states its effects instead. */
type EffectDerivedField = 'access' | 'scopes' | 'ownerOnly' | 'irreversible' | 'changesContract' | 'effect' | 'effects';

/** What a builtin method states: its effects (at least one), never the fields computed from them. */
export type BuiltinMethodInput = Omit<GatewayMethodDescriptor, 'source' | 'transport' | EffectDerivedField>
  & Partial<Pick<GatewayMethodDescriptor, 'source' | 'transport'>>
  & { readonly effects: readonly [EffectId, ...EffectId[]] };

/**
 * A builtin method descriptor. `access`, `scopes`, `ownerOnly`,
 * `irreversible`, `changesContract` and `effect` are computed from the
 * effects it states (security/effect-authority.ts `effectFacts`), so the
 * published contract and the admission check read the same rows.
 *
 * `dangerous` means: a client should confirm before calling, and a generated
 * tool list marks it destructive. Every admin method that writes accounts,
 * sign-in or settings (a `write:auth` or `write:config` scope) is dangerous
 * unless its descriptor says `dangerous: false`; any other method sets the flag
 * itself.
 */
export function methodDescriptor(input: BuiltinMethodInput): GatewayMethodDescriptor {
  const facts = effectFacts(input.effects);
  const access = facts.access;
  const dangerous = input.dangerous
    ?? (access === 'admin' && facts.scopes.some((scope) => ACCESS_AND_SETTINGS_WRITE_SCOPES.has(scope)) ? true : undefined);
  const effect: GatewayMethodEffect = facts.outward ? 'outward' : defaultMethodEffect(facts.scopes);
  const repeat = methodRepeat(input.id, effect, input.repeat, input.replay);
  return {
    source: input.source ?? 'builtin',
    transport: input.transport ?? ['http', 'ws'],
    ...input,
    access,
    scopes: facts.scopes,
    effects: [...input.effects],
    ...(dangerous === undefined ? {} : { dangerous }),
    ...(facts.ownerOnly ? { ownerOnly: true } : {}),
    ...(facts.irreversible ? { irreversible: true } : {}),
    ...(facts.changesContract ? { changesContract: true } : {}),
    effect,
    repeat,
  };
}

/**
 * A method's repeat declaration: `keyed` exactly when it has a retry key, and
 * `safe` for a read. A write must state it, or the catalog does not load: a
 * client deciding whether to send a lost call again has nothing else to go by.
 */
function methodRepeat(id: string, effect: GatewayMethodEffect, stated: GatewayMethodRepeat | undefined, replay: ContractReplayKey | undefined): GatewayMethodRepeat {
  if (replay) {
    if (stated !== undefined && stated !== 'keyed') throw new Error(`Gateway method ${id} has a retry key, so a repeat of it is keyed, not ${stated}.`);
    return 'keyed';
  }
  if (stated === 'keyed') throw new Error(`Gateway method ${id} is declared keyed but names no retry key (replay).`);
  if (stated !== undefined) return stated;
  if (effect === 'read') return 'safe';
  throw new Error(`Gateway method ${id} changes state but does not declare what a repeat does (repeat: safe or unsafe, or a replay key).`);
}

export function eventDescriptor(input: Omit<GatewayEventDescriptor, 'source'> & Partial<Pick<GatewayEventDescriptor, 'source'>>): GatewayEventDescriptor {
  return {
    source: input.source ?? 'builtin',
    ...input,
  };
}

export function runtimeEventId(domain: RuntimeEventDomain): string {
  return `runtime.${domain}`;
}

export function runtimeDomainEvent(domain: RuntimeEventDomain, description: string): GatewayEventDescriptor {
  return eventDescriptor({
    id: runtimeEventId(domain),
    title: `${domain} Domain Events`,
    description,
    category: 'runtime-domain',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    domains: [domain],
    wireEvents: [domain],
    outputSchema: JSON_OBJECT_SCHEMA,
  });
}
