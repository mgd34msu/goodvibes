import type { DaemonTaskRouteHandlers } from './context.js';
import type { AgentRecordLike, TrySpawnAgentInput } from './runtime-route-types.js';
import { InvalidPathEncodingError, invalidPathEncodingResponse, safeDecodeURIComponent } from './operator.js';
import { readBoundedPositiveInteger } from './route-helpers.js';

export async function dispatchTaskRoutes(
  req: Request,
  handlers: DaemonTaskRouteHandlers,
): Promise<Response | null> {
  try {
    return await dispatchTaskRoutesInner(req, handlers);
  } catch (error) {
    if (error instanceof InvalidPathEncodingError) return invalidPathEncodingResponse();
    throw error;
  }
}

/** Ids are matched on the raw path and decoded here, the way the gateway REST table decodes them. */
async function dispatchTaskRoutesInner(
  req: Request,
  handlers: DaemonTaskRouteHandlers,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/task' && method === 'POST') return handlers.postTask(req);
  // GET /task is intentionally left to extension routers that expose
  // surface-specific task status pages.
  if (pathname === '/task' && method === 'GET') return null;

  if (pathname === '/api/tasks' && method === 'GET') {
    const limit = url.searchParams.get('limit');
    return handlers.getIntegrationTasks(limit === null ? undefined : readBoundedPositiveInteger(limit, 500, 5_000), req);
  }
  const taskDetailMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskDetailMatch && method === 'GET') return handlers.getRuntimeTask(safeDecodeURIComponent(taskDetailMatch[1]!));

  const taskActionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|retry)$/);
  if (taskActionMatch && method === 'POST') {
    return handlers.runtimeTaskAction(safeDecodeURIComponent(taskActionMatch[1]!), taskActionMatch[2]! as 'cancel' | 'retry', req);
  }

  const taskStatusMatch = pathname.match(/^\/task\/([^/]+)$/);
  if (taskStatusMatch && method === 'GET') return handlers.getTaskStatus(safeDecodeURIComponent(taskStatusMatch[1]!));

  return null;
}

/**
 * What a retry of an agent starts: the same task on the same model, provider,
 * tools, routing, execution limits and contract settings the agent was started
 * with, in the session that started it. The record's tool list is the one the
 * agent ran with, so it is given exactly (`restrictTools`), not added to the
 * template's defaults a second time.
 */
export function agentRetrySpawnInput(record: AgentRecordLike): TrySpawnAgentInput {
  return {
    mode: 'spawn',
    task: record.task,
    ...(record.template !== undefined ? { template: record.template } : {}),
    ...(typeof record.model === 'string' && record.model ? { model: record.model } : {}),
    ...(record.provider !== undefined ? { provider: record.provider } : {}),
    tools: [...record.tools],
    restrictTools: true,
    ...(record.fallbackModels !== undefined ? { fallbackModels: [...record.fallbackModels] } : {}),
    ...(record.routing !== undefined ? { routing: record.routing } : {}),
    ...(record.executionIntent !== undefined ? { executionIntent: record.executionIntent } : {}),
    ...(record.reasoningEffort !== undefined ? { reasoningEffort: record.reasoningEffort } : {}),
    ...(record.context !== undefined ? { context: record.context } : {}),
    ...(record.outsideContract !== undefined ? { outsideContract: record.outsideContract } : {}),
    ...(record.executionProtocol !== undefined ? { executionProtocol: record.executionProtocol } : {}),
    ...(record.reviewMode !== undefined ? { reviewMode: record.reviewMode } : {}),
    ...(record.communicationLane !== undefined ? { communicationLane: record.communicationLane } : {}),
    ...(record.successCriteria !== undefined ? { successCriteria: [...record.successCriteria] } : {}),
    ...(record.requiredEvidence !== undefined ? { requiredEvidence: [...record.requiredEvidence] } : {}),
    ...(record.writeScope !== undefined ? { writeScope: [...record.writeScope] } : {}),
  };
}
