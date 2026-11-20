import type {
  ProjectPlanningDecisionRecordInput,
  ProjectPlanningService,
  ProjectWorkPlanClearCompletedInput,
  ProjectWorkPlanTaskCreateInput,
  ProjectWorkPlanTaskDeleteInput,
  ProjectWorkPlanTaskGetInput,
  ProjectWorkPlanTaskListInput,
  ProjectWorkPlanTaskReorderInput,
  ProjectWorkPlanTaskStatusInput,
  ProjectWorkPlanTaskUpdateInput,
} from '../../knowledge/index.js';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { requireParsedBody, routeFailureResponse } from './route-helpers.js';

type JsonRecord = Record<string, unknown>;

interface ProjectPlanningRouteContext {
  readonly projectPlanningService: ProjectPlanningService;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
}

/**
 * The paths the project planning routes serve.
 * Read by the capability-route reconcile, which cannot see a sub-router that is
 * dispatched ahead of the shared route table. `{param}` is one path segment.
 */
export const PROJECT_PLANNING_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'GET', path: '/api/projects/planning/status' },
  { method: 'GET', path: '/api/projects/planning/state' },
  { method: 'GET', path: '/api/projects/planning/decisions' },
  { method: 'POST', path: '/api/projects/planning/decisions' },
  { method: 'GET', path: '/api/projects/planning/language' },
  { method: 'GET', path: '/api/projects/planning/work-plan' },
  { method: 'GET', path: '/api/projects/planning/work-plan/tasks' },
  { method: 'POST', path: '/api/projects/planning/work-plan/tasks' },
  { method: 'POST', path: '/api/projects/planning/work-plan/tasks/reorder' },
  { method: 'POST', path: '/api/projects/planning/work-plan/clear-completed' },
  { method: 'GET', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
  { method: 'PATCH', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
  { method: 'DELETE', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
  { method: 'POST', path: '/api/projects/planning/work-plan/tasks/{taskId}/status' },
];

export class ProjectPlanningRoutes {
  constructor(private readonly context: ProjectPlanningRouteContext) {}

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/projects/planning')) return null;
    try {
      if (url.pathname === '/api/projects/planning/status' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.status(readProjectSpaceFromUrl(url)));
      }
      if (url.pathname === '/api/projects/planning/state' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.getState({
          ...readProjectSpaceFromUrl(url),
          planningId: url.searchParams.get('planningId') ?? undefined,
        }));
      }
      if (req.method === 'POST' && (url.pathname === '/api/projects/planning/state'
        || url.pathname === '/api/projects/planning/evaluate' || url.pathname === '/api/projects/planning/language')) {
        throw new RefusalError(refusal({
          code: 'PLANNING_STATE_READ_ONLY',
          state: 'saved planning state and project language are read-only history',
          reason: 'The planning interview is retired. It was the only writer of planning state, readiness and project language, and nothing reads any of them to start or shape work; saved records stay readable as history',
          next: ['Add or change tasks in the work plan: POST /api/projects/planning/work-plan/tasks'],
          status: 410,
        }));
      }
      if (url.pathname === '/api/projects/planning/decisions' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.listDecisions(readProjectSpaceFromUrl(url)));
      }
      if (url.pathname === '/api/projects/planning/decisions' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(
          await this.context.projectPlanningService.recordDecision(await this.readBody<ProjectPlanningDecisionRecordInput>(req)),
        ));
      }
      if (url.pathname === '/api/projects/planning/language' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.getLanguage(readProjectSpaceFromUrl(url)));
      }
      if (url.pathname === '/api/projects/planning/work-plan' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.getWorkPlanSnapshot(readWorkPlanQuery(url)));
      }
      if (url.pathname === '/api/projects/planning/work-plan/tasks' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.getWorkPlanSnapshot(readWorkPlanQuery(url)));
      }
      if (url.pathname === '/api/projects/planning/work-plan/tasks' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(
          await this.context.projectPlanningService.createWorkPlanTask({
            ...readWorkPlanQuery(url),
            ...(await this.readBody<ProjectWorkPlanTaskCreateInput>(req)),
          }),
        ));
      }
      if (url.pathname === '/api/projects/planning/work-plan/tasks/reorder' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(
          await this.context.projectPlanningService.reorderWorkPlanTasks({
            ...readWorkPlanQuery(url),
            ...(await this.readBody<ProjectWorkPlanTaskReorderInput>(req)),
          }),
        ));
      }
      if (url.pathname === '/api/projects/planning/work-plan/clear-completed' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(
          await this.context.projectPlanningService.clearCompletedWorkPlanTasks({
            ...readWorkPlanQuery(url),
            ...(await this.readOptionalBody<ProjectWorkPlanClearCompletedInput>(req)),
          }),
        ));
      }
      const taskMatch = url.pathname.match(/^\/api\/projects\/planning\/work-plan\/tasks\/([^/]+)(?:\/status)?$/);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]!);
        const isStatusRoute = url.pathname.endsWith('/status');
        if (!isStatusRoute && req.method === 'GET') {
          return Response.json(await this.context.projectPlanningService.getWorkPlanTask({
            ...readWorkPlanQuery(url),
            taskId,
          } satisfies ProjectWorkPlanTaskGetInput));
        }
        if (!isStatusRoute && req.method === 'PATCH') {
          return await this.admin(req, async () => Response.json(
            await this.context.projectPlanningService.updateWorkPlanTask({
              ...readWorkPlanQuery(url),
              ...(await this.readBody<Omit<ProjectWorkPlanTaskUpdateInput, 'taskId'>>(req)),
              taskId,
            }),
          ));
        }
        if (!isStatusRoute && req.method === 'DELETE') {
          return await this.admin(req, async () => Response.json(
            await this.context.projectPlanningService.deleteWorkPlanTask({
              ...readWorkPlanQuery(url),
              taskId,
            } satisfies ProjectWorkPlanTaskDeleteInput),
          ));
        }
        if (isStatusRoute && req.method === 'POST') {
          return await this.admin(req, async () => Response.json(
            await this.context.projectPlanningService.setWorkPlanTaskStatus({
              ...readWorkPlanQuery(url),
              ...(await this.readBody<Omit<ProjectWorkPlanTaskStatusInput, 'taskId'>>(req)),
              taskId,
            }),
          ));
        }
      }
      return Response.json({ error: 'Unknown project planning route' }, { status: 404 });
    } catch (error) {
      return routeFailureResponse(error);
    }
  }

  private async admin(req: Request, fn: () => Promise<Response>): Promise<Response> {
    const adminError = this.context.requireAdmin(req);
    if (adminError) return adminError;
    return fn();
  }

  private async readBody<T>(req: Request): Promise<T> {
    const body = await this.context.parseJsonBody(req);
    return requireParsedBody(body) as T;
  }

  private async readOptionalBody<T>(req: Request): Promise<T> {
    const body = await this.context.parseOptionalJsonBody(req);
    return (requireParsedBody(body) ?? {}) as T;
  }
}

function readProjectSpaceFromUrl(url: URL): JsonRecord {
  return {
    ...(url.searchParams.get('projectId') ? { projectId: url.searchParams.get('projectId')! } : {}),
    ...(url.searchParams.get('knowledgeSpaceId') ? { knowledgeSpaceId: url.searchParams.get('knowledgeSpaceId')! } : {}),
  };
}

function readWorkPlanQuery(url: URL): ProjectWorkPlanTaskListInput {
  const limit = url.searchParams.get('limit');
  return {
    ...readProjectSpaceFromUrl(url),
    ...(url.searchParams.get('workPlanId') ? { workPlanId: url.searchParams.get('workPlanId')! } : {}),
    ...(url.searchParams.get('status') ? { status: url.searchParams.get('status')! as ProjectWorkPlanTaskListInput['status'] } : {}),
    ...(url.searchParams.get('parentTaskId') ? { parentTaskId: url.searchParams.get('parentTaskId')! } : {}),
    ...(url.searchParams.get('contractId') ? { contractId: url.searchParams.get('contractId')! } : {}),
    ...(url.searchParams.get('owner') ? { owner: url.searchParams.get('owner')! } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  };
}
