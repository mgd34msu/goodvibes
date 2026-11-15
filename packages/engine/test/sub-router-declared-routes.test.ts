/**
 * Each sub-router that router.ts dispatches ahead of the shared route table
 * publishes the paths it serves, and the capability-route reconcile trusts that
 * list. This runs every declared path against the real dispatcher: a path the
 * dispatcher does not answer would make the reconcile call an unserved
 * advertisement live.
 */

import { describe, expect, test } from 'bun:test';
import { dispatchMcpRoutes, MCP_ROUTES } from '../platform/src/platform/daemon/http/mcp-routes.ts';
import { dispatchBatchRoutes, BATCH_ROUTES } from '../platform/src/platform/daemon/http/batch-routes.ts';
import { dispatchCloudflareRoutes, CLOUDFLARE_ROUTES } from '../platform/src/platform/daemon/http/cloudflare-routes.ts';
import { HomeAssistantConversationRoutes, HOME_ASSISTANT_CONVERSATION_ROUTES } from '../platform/src/platform/daemon/http/homeassistant-routes.ts';
import { HomeGraphRoutes, HOME_GRAPH_ROUTES } from '../platform/src/platform/daemon/http/home-graph-routes.ts';
import { ProjectPlanningRoutes, PROJECT_PLANNING_ROUTES } from '../platform/src/platform/daemon/http/project-planning-routes.ts';
import { dispatchCompanionChatRoutes, COMPANION_CHAT_ROUTES } from '../platform/src/platform/companion/companion-chat-routes.ts';

type Declared = readonly { readonly method: string; readonly path: string }[];
type Dispatch = (req: Request) => Promise<Response | null>;

/** A context whose every member fails when used, so no handler body can do real work. */
function untouchable<T>(): T {
  const fail = (): never => { throw new Error('context used'); };
  return new Proxy({}, { get: () => fail }) as T;
}

/**
 * True when the dispatcher took the request. A handler that fails on the inert
 * context still took it; a null, or the "Unknown ... route" 404 some of these
 * answer for their own prefix, did not.
 */
async function answers(dispatch: Dispatch, method: string, path: string): Promise<boolean> {
  try {
    const res = await dispatch(new Request(`http://daemon.invalid${path}`, { method, body: method === 'GET' ? null : '{}' }));
    if (res === null) return false;
    if (res.status !== 404) return true;
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    return !(typeof body?.error === 'string' && body.error.startsWith('Unknown '));
  } catch {
    return true;
  }
}

const concrete = (path: string) => path.replace(/\{[^/}]+\}/g, 'x');

function check(name: string, declared: Declared, dispatch: Dispatch, prefix: string): void {
  describe(`${name} declared routes`, () => {
    test('every declared path is answered by the dispatcher, and an undeclared one under the same prefix is not claimed', async () => {
      // An undeclared path must come back null, otherwise "answered" above proves nothing.
      expect(await answers(dispatch, 'GET', `${prefix}/not-a-route/at-all`), 'control path was claimed').toBe(false);
      for (const entry of declared) {
        expect(await answers(dispatch, entry.method, concrete(entry.path)), `${entry.method} ${entry.path} is declared but not served`).toBe(true);
      }
    });
  });
}

check('mcp', MCP_ROUTES, (req) => dispatchMcpRoutes(req, untouchable()), '/api/mcp');
check('batch', BATCH_ROUTES, (req) => dispatchBatchRoutes(req, untouchable()), '/api/batch');
check('cloudflare', CLOUDFLARE_ROUTES, (req) => dispatchCloudflareRoutes(req, untouchable()), '/api/cloudflare');
check('home assistant conversation', HOME_ASSISTANT_CONVERSATION_ROUTES, (req) => new HomeAssistantConversationRoutes(untouchable()).handle(req), '/api/homeassistant');
check('home graph', HOME_GRAPH_ROUTES, (req) => new HomeGraphRoutes(untouchable()).handle(req), '/api/homeassistant/home-graph');
check('project planning', PROJECT_PLANNING_ROUTES, (req) => new ProjectPlanningRoutes(untouchable()).handle(req), '/api/projects/planning');
check('companion chat', COMPANION_CHAT_ROUTES, (req) => dispatchCompanionChatRoutes(req, untouchable()), '/api/companion/chat/sessions/x');
