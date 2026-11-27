/**
 * host-handlers.ts, shared registration and confirmation plumbing for host
 * implementations attached to the engine's canonical gateway catalog.
 *
 * Ported from the daemon's `handlers/register.ts` and `handlers/errors.ts` with
 * behaviour unchanged:
 *
 *  - `registerCatalogHandler` binds a typed host handler to the descriptor the
 *    catalog already holds, BY ID, re-registering it with `{ replace: true }` so
 *    only the handler slot changes; no descriptor or schema is authored here.
 *  - `normalizeContext` reads the invocation context into the least-privilege
 *    envelope (an absent context is the empty one: no principal, no scopes, not
 *    admin, nobody claiming a person asked).
 *  - A descriptor that declares `confirmation` is held to it by the catalog
 *    before any handler runs (control-plane/confirmation-gate.ts).
 *
 * Every host handler refuses with the engine's `GatewayVerbError` (a
 * `RefusalError` with a stable machine `code` and an HTTP `status`, read by
 * shape at the dispatcher).
 */
import type { GatewayMethodCatalog } from './method-catalog.js';
import type {
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
} from './method-catalog-shared.js';
import { RefusalError } from '@goodvibes/engine/errors';
import { GatewayVerbError, readGatewayVerbRefusal } from './routes/gateway-verb-error.js';
import { isRegisteredProgram } from '../daemon/program-registrations.js';

/** Function returned by every registration; calling it removes the attached handler. */
export type Unregister = () => void;

/** Normalized, host-facing principal/auth context derived from the invocation. */
export interface HandlerContextEnvelope {
  readonly signal?: AbortSignal | undefined;
  readonly principalId: string;
  readonly admin: boolean;
  readonly scopes: string[];
  readonly explicitUserRequest: boolean;
  readonly authToken: string;
  readonly principalKind?: GatewayMethodInvocationContext['principalKind'];
  /** Which credential the transport authenticated the caller with; absent for an in-process call. */
  readonly credentialKind?: GatewayMethodInvocationContext['credentialKind'];
  /** Who the caller is admitted as, from the verified principal; absent for an in-process call. */
  readonly actor?: GatewayMethodInvocationContext['actor'];
  readonly nativeExecutionAuthority?: GatewayMethodInvocation['nativeExecutionAuthority'];
  readonly isAuthorized?: GatewayMethodInvocation['isAuthorized'];
  /** How the request reached the daemon, as the transport established it; absent for an in-process call. */
  readonly transport?: GatewayMethodInvocationContext['transport'];
  /**
   * The Agent's call carries the decision of its run's own answerer (a script answering every question): its native
   * admission asks nobody again. Only the dispatch sets it, only for the Agent's credential.
   */
  readonly decidedInRun?: true | undefined;
}

/** Typed, host-facing shape of a single method invocation. */
export interface HandlerInvocation<TBody> {
  readonly body: TBody;
  readonly query: Record<string, string>;
  readonly context: HandlerContextEnvelope;
}

/** A host handler: receives the typed invocation, returns the method result. */
export type TypedHandler<TBody, TResult> = (
  input: HandlerInvocation<TBody>,
) => Promise<TResult>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Derive the host-facing context envelope from the raw invocation context.
 * `explicitUserRequest` is carried in `context.metadata.explicitUserRequest`.
 *
 * An ABSENT context is accepted and read as the empty one. The type says a
 * context is always there and at runtime it is not always: an in-process invoke
 * that builds the invocation by hand can omit it, and reading `.metadata` off
 * `undefined` turned that into a TypeError thrown out of the handler wrapper
 * instead of the refusal every caller can act on. Defaulting to the least
 * privilege can cost a caller an authorization it never proved, never grant one.
 */
export function normalizeContext(
  c: GatewayMethodInvocationContext | undefined,
): HandlerContextEnvelope {
  const context: GatewayMethodInvocationContext = c ?? {};
  const metadata = context.metadata ?? {};
  return {
    principalId: context.principalId ?? '',
    admin: context.admin === true,
    scopes: context.scopes ? [...context.scopes] : [],
    explicitUserRequest: metadata['explicitUserRequest'] === true,
    authToken: context.authToken ?? '',
    ...(context.principalKind ? { principalKind: context.principalKind } : {}),
    ...(context.credentialKind ? { credentialKind: context.credentialKind } : {}),
    // Who the caller is (the one owner definition reads it: the owner's sign-in holds their machine's native identity).
    ...(context.actor ? { actor: context.actor } : {}),
    ...(context.transport ? { transport: context.transport } : {}),
    // Set by the dispatch only for the owner's own Agent program (daemon/control-plane.ts `decidedInRun`,
    // method-owner-decision.ts `ownersAgentProgram`): its credential with its checked registration, or a hosted turn.
    ...(metadata['decidedInRun'] === true && context.credentialKind === 'agent'
      && (isRegisteredProgram(context.call?.registration) || context.call?.daemonHosted === true) ? { decidedInRun: true } : {}),
  };
}

function normalizeQuery(query: GatewayMethodInvocation['query']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') out[key] = value;
    else if (value != null) out[key] = String(value);
  }
  return out;
}

/**
 * The body a handler sees: the invocation body with the query folded in
 * underneath it (body keys win), the way `readInvocationParams` does for the
 * other handler-registered verbs. GET and DELETE inputs travel in the query on
 * the HTTP transports, so a handler that reads only the body would otherwise
 * ignore every filter. Query strings are typed by the descriptor's input
 * schema (`integer`, `number`, `boolean`); an unparseable value is passed on as
 * the string so the handler's own validation refuses it.
 *
 * `confirm` is never taken from the query: a confirmation must be an explicit
 * body field, so a link or a prefetch cannot confirm a mutation.
 */
function foldQueryIntoBody(
  body: unknown,
  query: Record<string, string>,
  inputSchema: Record<string, unknown> | undefined,
): unknown {
  const keys = Object.keys(query).filter((key) => key !== 'confirm');
  if (keys.length === 0) return body;
  const isRecordBody = typeof body === 'object' && body !== null && !Array.isArray(body);
  if (body !== undefined && body !== null && !isRecordBody) return body;
  const properties = (inputSchema?.['properties'] ?? {}) as Record<string, { type?: unknown } | undefined>;
  const folded: Record<string, unknown> = {};
  for (const key of keys) {
    const raw = query[key]!;
    const type = properties[key]?.type;
    if ((type === 'integer' || type === 'number') && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      folded[key] = Number(raw);
    } else if (type === 'boolean' && (raw === 'true' || raw === 'false')) {
      folded[key] = raw === 'true';
    } else {
      folded[key] = raw;
    }
  }
  return { ...folded, ...(isRecordBody ? body as Record<string, unknown> : {}) };
}

/**
 * Attach a typed handler to the descriptor identified by `methodId`. Reuses the
 * descriptor the catalog already holds and re-registers it with the wrapped
 * handler via `{ replace: true }`.
 */
export function registerCatalogHandler<TBody, TResult>(
  catalog: GatewayMethodCatalog,
  methodId: string,
  handler: TypedHandler<TBody, TResult>,
): Unregister {
  const descriptor = catalog.get(methodId);
  if (!descriptor) {
    throw new GatewayVerbError(`Unknown gateway method: ${methodId}`, 'METHOD_NOT_FOUND', 404);
  }

  const wrapped = async (inv: GatewayMethodInvocation): Promise<unknown> => {
    const context: HandlerContextEnvelope = { ...normalizeContext(inv.context), ...(inv.signal ? { signal: inv.signal } : {}),
      ...(inv.nativeExecutionAuthority ? { nativeExecutionAuthority: inv.nativeExecutionAuthority } : {}),
      ...(inv.isAuthorized ? { isAuthorized: inv.isAuthorized } : {}) };
    const query = normalizeQuery(inv.query);
    const body = foldQueryIntoBody(inv.body, query, descriptor.inputSchema) as TBody;
    try {
      return await handler({ body, query, context });
    } catch (error) {
      // A refusal (a GatewayVerbError or a service's RefusalError) goes on
      // unchanged, so its state and next steps reach the caller.
      if (error instanceof RefusalError) throw error;
      // A service error that carries only an HTTP status and a machine code is
      // a refusal the caller can act on, not a handler fault.
      const shaped = readGatewayVerbRefusal(error);
      if (shaped) throw new GatewayVerbError(shaped.message, shaped.code, shaped.status, shaped.field);
      throw new GatewayVerbError(errorMessage(error), 'HANDLER_FAILED', 500);
    }
  };

  return catalog.register(descriptor, wrapped, { replace: true });
}

/** A single id to handler binding for batch registration. */
export interface CatalogHandlerEntry {
  readonly id: string;
  readonly handler: TypedHandler<unknown, unknown>;
}

/**
 * Register many handlers at once. Returns a single `Unregister` that tears them
 * down in REVERSE registration order (best-effort: a failing teardown never
 * aborts the rest).
 */
export function registerCatalogHandlers(
  catalog: GatewayMethodCatalog,
  entries: readonly CatalogHandlerEntry[],
): Unregister {
  const teardowns: Unregister[] = [];
  for (const entry of entries) {
    teardowns.push(registerCatalogHandler(catalog, entry.id, entry.handler));
  }
  return () => {
    for (let i = teardowns.length - 1; i >= 0; i -= 1) {
      try {
        teardowns[i]!();
      } catch {
        // best-effort teardown; continue unwinding the rest
      }
    }
  };
}
