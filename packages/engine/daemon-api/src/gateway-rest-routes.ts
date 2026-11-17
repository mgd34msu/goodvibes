import type { DaemonGatewayRestRouteHandlers } from './context.js';
import { InvalidPathEncodingError, invalidPathEncodingResponse, safeDecodeURIComponent } from './operator.js';

/**
 * gateway-rest-routes.ts
 *
 * The REST arm of the gateway verbs. A handler-backed verb (one whose handler
 * the method catalog holds) is reached at the path its descriptor advertises
 * in its `http` binding: `handlers.resolveGatewayRestVerb` asks the catalog
 * which verb binds this method and path and answers only for one with a
 * handler, and `handlers.invokeGatewayRestVerb` runs it through the same
 * `invokeGatewayMethodCall` the methodId-invoke endpoint
 * (`POST /api/control-plane/methods/{methodId}/invoke`) uses: one handler,
 * one access gate. Path parameters ({name}, {sessionId}, ...) are folded into
 * the invocation so the handler's `readInvocationParams` view sees them.
 *
 * The descriptor is the one statement of where a verb is served; nothing here
 * repeats it. A verb without a handler is not answered here, so its path falls
 * through to the route modules, and a synthesized request for it can never
 * come back to this arm.
 */

interface GatewayRestPathAlias {
  readonly method: string;
  readonly segments: readonly string[];
  readonly methodId: string;
}

/**
 * Paths kept for clients written against the retired pause/resume job verbs:
 * the same state change as disable/enable, through the same handler.
 */
const GATEWAY_REST_PATH_ALIASES: readonly GatewayRestPathAlias[] = [
  { method: 'POST', segments: pathSegments('/api/automation/jobs/{jobId}/pause'), methodId: 'automation.jobs.disable' },
  { method: 'POST', segments: pathSegments('/api/automation/jobs/{jobId}/resume'), methodId: 'automation.jobs.enable' },
];

/** Split as the method catalog splits a binding (a trailing slash is ignored), so both read a path the same way. */
function pathSegments(path: string): string[] {
  return (path.replace(/\/+$/, '') || '/').split('/');
}

function isParamSegment(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/** The raw (still encoded) values of `template`'s `{param}` segments in `pathname`, or null when it does not match. */
function matchTemplate(template: readonly string[], pathname: readonly string[]): Record<string, string> | null {
  if (template.length !== pathname.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < template.length; index += 1) {
    const want = template[index]!;
    const have = pathname[index]!;
    if (isParamSegment(want)) {
      if (have.length === 0) return null;
      params[want.slice(1, -1)] = have;
    } else if (want !== have) return null;
  }
  return params;
}

/**
 * Dispatch a request to the handler-backed gateway verb its method and path
 * name. Returns the verb's `Response`, or `null` when no handler-backed verb
 * binds the path (the caller falls through to the rest of the route chain).
 * A daemon that has not wired the gateway REST handlers (a minimal embed)
 * answers nothing here.
 */
export async function dispatchGatewayRestRoutes(
  req: Request,
  handlers: Partial<DaemonGatewayRestRouteHandlers>,
): Promise<Response | null> {
  if (typeof handlers.invokeGatewayRestVerb !== 'function') return null;
  const { pathname } = new URL(req.url);
  const method = req.method;
  const segments = pathSegments(pathname);
  let methodId: string | undefined;
  let raw: Record<string, string> | null = null;
  for (const alias of GATEWAY_REST_PATH_ALIASES) {
    if (alias.method !== method) continue;
    raw = matchTemplate(alias.segments, segments);
    if (raw) { methodId = alias.methodId; break; }
  }
  if (!raw) {
    const verb = handlers.resolveGatewayRestVerb?.(method, pathname);
    if (!verb) return null;
    raw = matchTemplate(pathSegments(verb.path), segments);
    if (!raw) return null;
    methodId = verb.methodId;
  }
  if (methodId === undefined) return null;
  const params: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(raw)) params[name] = safeDecodeURIComponent(value);
  } catch (error) {
    if (error instanceof InvalidPathEncodingError) return invalidPathEncodingResponse();
    throw error;
  }
  return handlers.invokeGatewayRestVerb({ methodId, req, params });
}
