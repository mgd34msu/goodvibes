import type { RuntimeEventDomain } from '../runtime/events/index.js';
import type { ContractErrorCode, ContractReplayKey } from '../types/foundation-contract.js';
import type { NativeExecutionAuthority } from '../security/http-auth.js';
import type { Actor, CredentialKind, PrincipalKind } from '../daemon/http-policy.js';
import { effectFacts, type EffectId } from '../security/effect-authority.js';
import { declaredMethodRisk, METHOD_RISKS, type MethodRisk } from './method-risk.js';
export type { NativeExecutionAuthority, NativePairedSnapshot } from '../security/http-auth.js';
export type { MethodRisk } from './method-risk.js';

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
  /**
   * Other verbs at the same path that are this same method (`PATCH /api/channels/policies/{surface}` beside its
   * `POST`): a request with one of them is found as this method (method-catalog.ts `findByHttpBinding`), so it is
   * decided where the method is (daemon/method-owner-decision.ts) and served by the method's own route.
   */
  readonly alsoAt?: readonly ('GET' | 'POST' | 'PATCH' | 'DELETE')[] | undefined;
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
   * a card security code, withdrawing access he granted): only the owner's
   * credential makes it; another is refused, or its call put to the owner. For
   * a plugin's method, a declared `ownerOnly` means a model never calls it.
   */
  readonly ownerOnly?: boolean | undefined;
  /** A model never makes the call, whoever it acts for; an agent is refused and told how the owner does it. */
  readonly modelRefused?: boolean | undefined;
  /**
   * The confirmation the call needs before it runs (control-plane/confirmation-gate.ts):
   * `confirm` (input `confirm: true`, not declared a non-person request),
   * `owner-request` (`confirm: true` from a credential that states a person
   * asked), or `not-declined`. Refused with one body, CONFIRMATION_REQUIRED.
   */
  readonly confirmation?: 'confirm' | 'owner-request' | 'not-declined' | undefined;
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
  /**
   * The inputs that name a folder a turn or a process will work in (an outside coding agent's `cwd`, a trigger's or a
   * schedule's `workingDirectory`, a hosted session's `workspaceRoot`, a runner's `backendConfig.cwd`), as paths into
   * the body: `a.b` for a nested field, `a[]` for each entry of a list. The daemon's dispatch runs the one check of a
   * caller's project (workspace/caller-project.ts `checkCallerProject`) on each before the handler runs, for the
   * credential that made the call. See `FOLDER_INPUT_NAMES`: an input so named and declared nowhere stops the catalog.
   */
  readonly workFolders?: readonly string[] | undefined;
  /**
   * The inputs named like a folder that no turn or process works in, each with why (a project a list is filtered by, a
   * record's field, the owner's own registration of a workspace): declared so the catalog knows they were looked at.
   */
  readonly notWorkFolders?: Readonly<Record<string, string>> | undefined;
  /**
   * The inputs that name a file or folder on the daemon's disk the method reads or writes (an artifact made from a file
   * by path, a knowledge source read from a file, a screenshot saved): for anyone but the owner's own program each must
   * be inside a project given to that caller (control-plane/caller-paths.ts). See `FILE_INPUT_NAMES`.
   */
  readonly daemonFiles?: readonly string[] | undefined;
  /** The inputs named like a file that name none on this disk, each with why (a path in a URL, a label, a file in a checkpoint). */
  readonly notDaemonFiles?: Readonly<Record<string, string>> | undefined;
  /**
   * What calling it does that the owner decides (control-plane/method-risk.ts): `loosens-a-protection`,
   * `cannot-be-undone`, `spends-money`, `writes-a-secret`, `owner-act`, `answers-the-owner`, or `none`. Every builtin method has one
   * (`methodDescriptor` stamps it from the table, or stops the catalog); the daemon's dispatch decides a call of any
   * class but `none` as the capability that does the same act would be (daemon/method-owner-decision.ts).
   */
  readonly risk?: MethodRisk | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * The input names that name a file: every one in a builtin method's input schema, at any depth, is declared in
 * `daemonFiles` or `notDaemonFiles` (or as a work folder), or the catalog does not load.
 */
export const FILE_INPUT_NAMES: ReadonlySet<string> = new Set(['path', 'paths', 'filePath', 'file', 'files', 'folderPath', 'dest', 'out', 'outputPath']);

/**
 * The input names that name a folder: every one in a builtin method's input schema, at any depth, is declared in
 * `workFolders` or `notWorkFolders`, or the catalog does not load (as a write that does not say what a repeat does).
 */
export const FOLDER_INPUT_NAMES: ReadonlySet<string> = new Set([
  'cwd', 'workingDirectory', 'workingDir', 'workdir', 'workspaceRoot', 'projectRoot', 'projectDir', 'worktreePath',
  'directory', 'allowedPaths', 'root', 'project', 'mainWorktreeRoot', 'repoPath',
]);

/** Every path (as `workFolders` writes them) of an input named in `names`, in an input schema. */
function folderInputPaths(schema: unknown, names: ReadonlySet<string> = FOLDER_INPUT_NAMES): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, at: string, seen: ReadonlySet<unknown>): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    const next = new Set(seen).add(node);
    const shape = node as Record<string, unknown>;
    const properties = shape['properties'];
    if (properties !== null && typeof properties === 'object') {
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        const path = at ? `${at}.${name}` : name;
        if (names.has(name)) found.add(path);
        walk(child, path, next);
      }
    }
    if (shape['items'] !== null && typeof shape['items'] === 'object') walk(shape['items'], `${at}[]`, next);
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const alternatives = shape[key];
      if (Array.isArray(alternatives)) for (const alternative of alternatives) walk(alternative, at, next);
    }
  };
  walk(schema, '', new Set());
  return [...found];
}

/**
 * A builtin method's folder inputs, checked when its descriptor is made: each input named like a folder is declared
 * once, as a folder worked in or as one that is not (with why), and nothing is declared that is neither.
 */
function checkFolderInputs(id: string, schema: unknown, works: readonly string[] | undefined, not: Readonly<Record<string, string>> | undefined,
  files?: readonly string[] | undefined, notFiles?: Readonly<Record<string, string>> | undefined): void {
  const declared = new Set([...(works ?? []), ...Object.keys(not ?? {})]);
  const undeclared = folderInputPaths(schema).filter((path) => !declared.has(path));
  if (undeclared.length > 0) {
    throw new Error(`Gateway method ${id} takes ${undeclared.join(', ')}, named like a folder, and does not declare whether a turn or process works in it (workFolders, or notWorkFolders with why).`);
  }
  for (const [path, why] of Object.entries(not ?? {})) {
    if (!why.trim()) throw new Error(`Gateway method ${id} declares ${path} as no folder worked in without saying why.`);
    if (works?.includes(path)) throw new Error(`Gateway method ${id} declares ${path} both as a folder worked in and as not one.`);
  }
  // Every input named like a file: a file on the daemon's disk, or said why not (a folder declared above counts).
  const fileDeclared = new Set([...declared, ...(files ?? []), ...Object.keys(notFiles ?? {})]);
  const undeclaredFiles = folderInputPaths(schema, FILE_INPUT_NAMES).filter((path) => !fileDeclared.has(path));
  if (undeclaredFiles.length > 0) {
    throw new Error(`Gateway method ${id} takes ${undeclaredFiles.join(', ')}, named like a file, and does not declare whether it names a file on this daemon's disk (daemonFiles, or notDaemonFiles with why).`);
  }
  for (const [path, why] of Object.entries(notFiles ?? {})) {
    if (!why.trim()) throw new Error(`Gateway method ${id} declares ${path} as no file on this disk without saying why.`);
    if (files?.includes(path)) throw new Error(`Gateway method ${id} declares ${path} both as a file on this disk and as not one.`);
  }
}

/**
 * The values at each of a method's declared work folders in a call's body, with the path each was read at: a string
 * at a plain path, each string of a list at `a[]`. A value that is not text is left to the method's own validation.
 */
export function workFolderValues(body: unknown, paths: readonly string[]): { readonly path: string; readonly value: string }[] {
  const out: { path: string; value: string }[] = [];
  const read = (node: unknown, parts: readonly string[], at: string): void => {
    if (parts.length === 0) {
      if (typeof node === 'string' && node.trim()) out.push({ path: at, value: node });
      // A list of folders (a tool server's allowed paths): each one.
      if (Array.isArray(node)) node.forEach((entry, index) => { if (typeof entry === 'string' && entry.trim()) out.push({ path: `${at}[${index}]`, value: entry }); });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const [head, ...rest] = parts as [string, ...string[]];
    const list = head.endsWith('[]');
    const name = list ? head.slice(0, -2) : head;
    const child = Array.isArray(node) ? undefined : (node as Record<string, unknown>)[name];
    const here = at ? `${at}.${name}` : name;
    if (!list) { read(child, rest, here); return; }
    if (Array.isArray(child)) child.forEach((entry, index) => read(entry, rest, `${here}[${index}]`));
  };
  for (const path of paths) read(body, path.split('.'), '');
  return out;
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

/**
 * The call context: where a call acts and which conversation it came from, as the caller named it. A terminal program
 * sets it once and sends it on every request (runtime/client/call-context.ts headers); `capabilities.run` also takes it
 * in its body (`workingDirectory`, `sessionId`: the web UI's chosen project and an outside caller give it so). The
 * daemon reads a per-project thing's project from here and never puts its own folder in its place.
 */
export interface CallContext {
  /** The project folder, absolute, as the caller named it. */
  readonly project?: string | undefined;
  /** The conversation the call came from. */
  readonly sessionId?: string | undefined;
  /**
   * Which program of the principal asks: the fingerprint of its registration key (daemon-api control-routes.ts
   * `readProgramRegistration`). Tells holders of one credential apart; grants nothing.
   */
  readonly registration?: string | undefined;
  /** The registered program's process on this machine (`<pid>:<start>`), bound by the daemon with the registration. */
  readonly process?: string | undefined;
  /** The daemon served the request to itself, in process (a turn it hosts): bound by its router, never from a header. */
  readonly daemonHosted?: true | undefined;
  /**
   * A daemon-run turn acting on someone else's input (security/turn-input-party.ts: a member's web chat, a guest, a
   * channel message, work nobody but the owner approved): set in process only, by the daemon's own turn
   * (tools/capability/daemon-tools.ts). Such a turn reaches only the chats and sessions its own caller made
   * (control-plane/caller-reach.ts `reaches`); it only ever narrows what a call reaches.
   */
  readonly othersInput?: true | undefined;
  /** With `othersInput`: the principal whose own conversation the turn runs in (a member's web chat: hers), when known. */
  readonly othersInputFor?: string | undefined;
  /**
   * A call nested in one of the daemon's own turns, sent with the daemon's credential (set by the dispatch only for its
   * in-process `daemonTurn` input, removed from any other): it names its turn's `project` only.
   */
  readonly daemonTurn?: true | undefined;
  /**
   * What the calling program's own conversation read from outside, as it says (daemon-api control-routes.ts
   * `CALL_READ_OUTSIDE_HEADER`; security/conversation-exposure.ts `decodeCarriedExposure`). It only tightens: the
   * dispatch runs the call inside that conversation, marked exposed (`withCarriedExposure`).
   */
  readonly readOutside?: string | undefined;
}

export interface GatewayMethodInvocationContext {
  /** Where the call acts and the conversation it came from, as its caller named them ({@link CallContext}). */
  readonly call?: CallContext | undefined;
  readonly principalId?: string | undefined;
  readonly principalKind?: PrincipalKind | undefined;
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
  /**
   * Set only by the transport: how the request reached the daemon (loopback,
   * TLS, the tailnet or a plain network). An effect that may only cross some
   * links (a card number) reads it. Absent for a call made in-process.
   */
  readonly transport?: 'loopback' | 'tls' | 'tailnet' | 'plain-network' | undefined;
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
  modelRefused: BOOLEAN_SCHEMA,
  confirmation: stringEnumSchema(['confirm', 'owner-request', 'not-declined']),
  irreversible: BOOLEAN_SCHEMA,
  changesContract: BOOLEAN_SCHEMA,
  recipients: arraySchema(STRING_SCHEMA),
  invokable: BOOLEAN_SCHEMA,
  workFolders: arraySchema(STRING_SCHEMA),
  notWorkFolders: JSON_OBJECT_SCHEMA,
  daemonFiles: arraySchema(STRING_SCHEMA),
  notDaemonFiles: JSON_OBJECT_SCHEMA,
  risk: stringEnumSchema(METHOD_RISKS),
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
 *   each conversation. A person's own web chat is not someone else's
 *   transcript: its maker reads it (the companion chat reads, effect
 *   `chat.read`) under the sessions scope she made it with, `read:sessions`
 *   or `write:sessions`; every other chat stays behind `read:transcripts`.
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
type EffectDerivedField = 'access' | 'scopes' | 'ownerOnly' | 'modelRefused' | 'irreversible' | 'changesContract' | 'effect' | 'effects';

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
  const inputSchema = withConfirmField(input.id, input.confirmation, input.inputSchema);
  checkFolderInputs(input.id, inputSchema, input.workFolders, input.notWorkFolders, input.daemonFiles, input.notDaemonFiles);
  // What it does that the owner decides (method-risk.ts): stated, or the catalog does not load.
  const risk = input.risk ?? declaredMethodRisk(input.id, effect);
  if (risk === undefined) {
    throw new Error(`Gateway method ${input.id} changes something but declares no risk class (control-plane/method-risk.ts: loosens-a-protection, steers-a-model, cannot-be-undone, spends-money, writes-a-secret, owner-act, answers-the-owner or none).`);
  }
  return {
    source: input.source ?? 'builtin',
    transport: input.transport ?? ['http', 'ws'],
    ...input,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    access,
    scopes: facts.scopes,
    effects: [...input.effects],
    ...(dangerous === undefined ? {} : { dangerous }),
    ...(facts.ownerOnly ? { ownerOnly: true } : {}),
    ...(facts.modelRefused ? { modelRefused: true } : {}),
    ...(facts.irreversible ? { irreversible: true } : {}),
    ...(facts.changesContract ? { changesContract: true } : {}),
    effect,
    repeat,
    risk,
  };
}

/**
 * A method that runs only with `confirm: true` (confirmation `confirm` or
 * `owner-request`) has `confirm` as a required boolean in its input schema,
 * taken from that one declaration, so a client compiled against the contract
 * sends it. A missing `confirm` is refused by the confirmation gate
 * (CONFIRMATION_REQUIRED), not by schema validation (invoke-input-validation.ts).
 */
function withConfirmField(
  id: string,
  confirmation: GatewayMethodDescriptor['confirmation'],
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (confirmation !== 'confirm' && confirmation !== 'owner-request') return schema;
  return requireConfirm(id, schema);
}

/** `schema` with `confirm` required: in each alternative of a `oneOf`, else in the object schema itself. A `confirm` property already stated (`const: true`) is kept. */
function requireConfirm(id: string, schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const alternatives = schema?.['oneOf'];
  if (schema && Array.isArray(alternatives)) {
    return { ...schema, oneOf: alternatives.map((alternative: unknown) => requireConfirm(id, typeof alternative === 'object' && alternative !== null ? alternative as Record<string, unknown> : undefined)) };
  }
  const properties = schema?.['properties'];
  if (!schema || schema['type'] !== 'object' || typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error(`Gateway method ${id} runs only with confirm: true, so its input schema must be an object schema that can carry confirm.`);
  }
  const required = Array.isArray(schema['required']) ? (schema['required'] as readonly unknown[]) : [];
  return {
    ...schema,
    properties: 'confirm' in properties ? properties : { ...properties, confirm: BOOLEAN_SCHEMA },
    required: required.includes('confirm') ? [...required] : [...required, 'confirm'],
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
