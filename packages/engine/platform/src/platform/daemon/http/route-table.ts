/**
 * The daemon's route table, built from one narrow context per route family.
 *
 * Each family is handed only what its own routes read, so the table can be
 * built for a host that has those collaborators and nothing else. It is built
 * once and kept: a handler that remembers something between requests keeps
 * remembering it for as long as the daemon runs.
 */
import { createBrowserJudgmentHttpHandler } from '@goodvibes-jev/engine/daemon-api';
import { dispatchDaemonApiRoutes } from '../../control-plane/routes/index.js';
import { bindRequestContext, requestContextOf } from '../request-context.js';
import { createDaemonChannelRouteHandlers } from './channel-routes.js';
import { createDaemonControlRouteHandlers } from './control-routes.js';
import { createDaemonIntegrationRouteHandlers } from './integration-routes.js';
import { createDaemonKnowledgeRouteHandlers } from './knowledge-routes.js';
import { createDaemonMediaRouteHandlers } from './media-routes.js';
import { createDaemonRemoteRouteHandlers } from './remote-routes.js';
import { createDaemonRuntimeRouteHandlers } from './runtime-routes.js';
import { createDaemonSystemRouteHandlers } from './system-routes.js';
import { createDaemonTelemetryRouteHandlers } from './telemetry-routes.js';
import type { DaemonRouteTable } from './request-router.js';

type RouteExtension = NonNullable<DaemonRouteTable['extensions']>[number];

/** Where the Agent's own knowledge is served; the same routes as `/api/knowledge` over another store. */
const AGENT_KNOWLEDGE_PREFIX = '/api/goodvibes-agent/knowledge';

/** What each route family reads. A family's context is the one its own handler factory declares. */
export interface DaemonRouteFamilies {
  readonly control: Parameters<typeof createDaemonControlRouteHandlers>[0];
  readonly integration: Parameters<typeof createDaemonIntegrationRouteHandlers>[0];
  readonly telemetry: Parameters<typeof createDaemonTelemetryRouteHandlers>[0];
  readonly channel: Parameters<typeof createDaemonChannelRouteHandlers>[0];
  readonly system: Parameters<typeof createDaemonSystemRouteHandlers>[0];
  readonly runtime: Parameters<typeof createDaemonRuntimeRouteHandlers>[0];
  readonly remote: Parameters<typeof createDaemonRemoteRouteHandlers>[0];
  readonly knowledge: Parameters<typeof createDaemonKnowledgeRouteHandlers>[0];
  readonly media: Parameters<typeof createDaemonMediaRouteHandlers>[0];
  /** The Agent's knowledge store, served under its own prefix. Absent: that prefix is not served. */
  readonly agentKnowledge?: Parameters<typeof createDaemonKnowledgeRouteHandlers>[0] | undefined;
  /** Browser judgments. Absent: the route answers that judgments are unavailable. */
  readonly browserJudgment?: Parameters<typeof createBrowserJudgmentHttpHandler>[0] | undefined;
  /** Further dispatchers, tried after every family above. */
  readonly extensions?: readonly RouteExtension[] | undefined;
}

/** Calls every family's handler factory exactly once. */
export function buildDaemonRouteTable(families: DaemonRouteFamilies): DaemonRouteTable {
  const handlers = {
    ...createDaemonControlRouteHandlers(families.control),
    ...createDaemonIntegrationRouteHandlers(families.integration),
    ...createDaemonTelemetryRouteHandlers(families.telemetry),
    ...createDaemonChannelRouteHandlers(families.channel),
    ...createDaemonSystemRouteHandlers(families.system),
    ...createDaemonRuntimeRouteHandlers(families.runtime),
    ...createDaemonRemoteRouteHandlers(families.remote),
    ...createDaemonKnowledgeRouteHandlers(families.knowledge),
    ...createDaemonMediaRouteHandlers(families.media),
  };
  const extensions: RouteExtension[] = [];
  if (families.agentKnowledge) {
    const agentKnowledgeHandlers = { ...handlers, ...createDaemonKnowledgeRouteHandlers(families.agentKnowledge) };
    extensions.push((req) => dispatchAliasedKnowledgeRoutes(req, AGENT_KNOWLEDGE_PREFIX, agentKnowledgeHandlers));
  }
  if (families.extensions) extensions.push(...families.extensions);
  return {
    handlers: families.browserJudgment
      ? { ...handlers, postBrowserJudgment: createBrowserJudgmentHttpHandler(families.browserJudgment) }
      : handlers,
    extensions,
  };
}

function dispatchAliasedKnowledgeRoutes(
  req: Request,
  aliasPrefix: string,
  handlers: DaemonRouteTable['handlers'],
): Promise<Response | null> | Response | null {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(aliasPrefix)) return null;
  const suffix = url.pathname.slice(aliasPrefix.length);
  url.pathname = `/api/knowledge${suffix}`;
  const aliased = new Request(url.toString(), req);
  // The same caller: the derived request carries the principal already authenticated.
  const context = requestContextOf(req);
  if (context) bindRequestContext(aliased, context);
  return dispatchDaemonApiRoutes(aliased, handlers);
}
