import { SESSION_KINDS, SESSION_SURFACE_KINDS, type DaemonRuntimeRouteContext } from './runtime-route-types.js';
import { jsonErrorResponse } from './error-response.js';
import { isJsonRecord } from './route-helpers.js';
import { toSharedSessionRecordResponse } from './runtime-session-routes.js';
import { readCallContext, readProgramRegistration, registrantKeyOf } from './control-routes.js';

function isOneOf<T extends string>(accepted: readonly T[], value: string): value is T {
  return (accepted as readonly string[]).includes(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Handle POST /api/sessions/register, the idempotent registration + heartbeat
 * upsert keyed on a caller-supplied `sessionId`. Requires a participant triple
 * {surfaceKind, surfaceId, userId?}; carries the identity spine (kind + project)
 * onto the record. Re-calling with the same id advances participant.lastSeenAt.
 */
export async function handleRegisterSharedSession(
  context: DaemonRuntimeRouteContext,
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;

  const sessionId = readString(body.sessionId);
  if (!sessionId) {
    return jsonErrorResponse({ error: 'sessions.register requires a non-empty sessionId.' }, { status: 400 });
  }

  const participantInput = isJsonRecord(body.participant) ? body.participant : undefined;
  const surfaceKind = participantInput ? readString(participantInput.surfaceKind) : undefined;
  const surfaceId = participantInput ? readString(participantInput.surfaceId) : undefined;
  if (!surfaceKind || !surfaceId) {
    return jsonErrorResponse(
      { error: 'sessions.register requires a participant with surfaceKind and surfaceId.' },
      { status: 400 },
    );
  }
  if (!isOneOf(SESSION_SURFACE_KINDS, surfaceKind)) {
    return jsonErrorResponse(
      { error: `sessions.register: unknown participant surfaceKind '${surfaceKind}'. Expected one of: ${SESSION_SURFACE_KINDS.join(', ')}.`, code: 'INVALID_ARGUMENT', field: 'participant.surfaceKind' },
      { status: 400 },
    );
  }

  // Honest input validation: an unknown session kind is a 400, NOT a silent
  // coercion to 'tui'. Absent kind is allowed (the broker defaults it).
  const kindRaw = readString(body.kind);
  if (kindRaw !== undefined && !isOneOf(SESSION_KINDS, kindRaw)) {
    return jsonErrorResponse(
      { error: `sessions.register: unknown session kind '${kindRaw}'. Expected one of: ${SESSION_KINDS.join(', ')}.` },
      { status: 400 },
    );
  }

  await context.sessionBroker.start();

  const reopen = body.reopen === true;
  // Who registers it, from the credential the listener authenticated (never the body), and which of that principal's
  // programs (its registration key's fingerprint, when it sent one): a session this call makes is that program's, the
  // only one that may name it as a question's asker (inbox.post) or raise an approval into it.
  const principal = context.requestPrincipalId?.(req);
  const registeredBy = principal ? registrantKeyOf(principal, readProgramRegistration(req)) : undefined;
  const project = readString(body.project) ?? readString(body.workingDirectory) ?? readCallContext(req)?.project;
  const result = await context.sessionBroker.register({
    ...(registeredBy ? { registeredBy } : {}),
    sessionId,
    ...(kindRaw ? { kind: kindRaw } : {}),
    ...(project ? { project } : {}),
    ...(readString(body.title) ? { title: readString(body.title) } : {}),
    participant: {
      surfaceKind,
      surfaceId,
      ...(readString(participantInput?.externalId) ? { externalId: readString(participantInput?.externalId) } : {}),
      ...(readString(participantInput?.userId) ? { userId: readString(participantInput?.userId) } : {}),
      ...(readString(participantInput?.displayName) ? { displayName: readString(participantInput?.displayName) } : {}),
      ...(readString(participantInput?.routeId) ? { routeId: readString(participantInput?.routeId) } : {}),
      lastSeenAt: Date.now(),
    },
    ...(reopen ? { reopen: true } : {}),
  });

  return context.recordApiResponse(req, '/api/sessions/register', Response.json({
    session: toSharedSessionRecordResponse(result.record.id, result.record),
    reopened: result.reopened,
    ...(result.conflict ? { conflict: result.conflict } : {}),
  }, { status: 200 }));
}
