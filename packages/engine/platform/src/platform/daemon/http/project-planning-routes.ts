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
  /**
   * The one folder check of every call (control-plane/caller-paths.ts), for the project a planning call names: why
   * this caller may not name it, or undefined. Absent: only the owner in person names one (never "no rule, no check").
   */
  readonly refuseProject?: ((req: Request, folder: string) => string | undefined) | undefined;
  /** The plan identity of a project folder (knowledge/project-planning/configured-project.ts `projectIdentityOfFolder`). */
  readonly projectIdOf?: ((folder: string) => Promise<string>) | undefined;
}

/** The code of a planning call that names no project. */
export const PLANNING_NO_PROJECT = 'NO_PROJECT';

/**
 * The project a planning call names: `workingDirectory` in its query or body, else the call's project
 * (`x-goodvibes-project`, as every program and the web UI send theirs). Undefined: it names none.
 */
async function namedProject(req: Request, url: URL): Promise<string | undefined> {
  const fromQuery = url.searchParams.get('workingDirectory')?.trim();
  if (fromQuery) return fromQuery;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const body = await req.clone().json().catch(() => undefined) as Record<string, unknown> | undefined;
    const fromBody = typeof body?.['workingDirectory'] === 'string' ? body['workingDirectory'].trim() : '';
    if (fromBody) return fromBody;
  }
  try {
    const header = req.headers.get('x-goodvibes-project');
    return header ? decodeURIComponent(header).trim() || undefined : undefined;
  } catch {
    return undefined;
  }
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
      // Every planning call names its project, checked as every call's folder is (the one folder check): the plan it
      // reads or changes is that project's, and what it announces says so (events/about.ts). One naming none is refused.
      const folder = await namedProject(req, url);
      if (!folder) {
        throw new RefusalError(refusal({
          code: PLANNING_NO_PROJECT, state: 'nothing was read or changed',
          reason: 'A planning call works on one project\'s plan, and this call named no project',
          next: ['Send the project folder as workingDirectory (in the query, or in the body of a POST or PATCH), or as the x-goodvibes-project header'],
          status: 422,
        }));
      }
      const refused = this.context.refuseProject ? this.context.refuseProject(req, folder) : 'this daemon has no rule for which projects a caller may name, so only the owner in person names one';
      if (refused !== undefined) {
        throw new RefusalError(refusal({ code: 'PROJECT_NOT_ALLOWED', state: 'nothing was read or changed', reason: refused,
          next: ['Name a project the owner gave this caller (Devices and network, on its row)'], status: 403 }));
      }
      if (!this.context.projectIdOf) {
        throw new RefusalError(refusal({ code: PLANNING_NO_PROJECT, state: 'nothing was read or changed',
          reason: 'This daemon cannot tell which plan belongs to a project folder', next: ['Use the plan from a program working in that project'], status: 422 }));
      }
      const projectId = await this.context.projectIdOf(folder);
      // The plan named is the folder's own, whatever id or space the caller also sent; its events name this folder.
      url.searchParams.set('projectId', projectId);
      url.searchParams.delete('knowledgeSpaceId');
      this.context.projectPlanningService.noteProjectRoot(projectId, folder);
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
          await this.context.projectPlanningService.recordDecision({ ...readProjectSpaceFromUrl(url), ...(await this.readBody<ProjectPlanningDecisionRecordInput>(req)) }),
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

  /**
   * A change of a project's plan is a project act (effect-authority.ts `work.write`), admitted by its effects at the
   * router's binding gate; the one folder check above held the caller to a project the owner gave it. No admin is asked
   * for here. The plan is the project's one shared list: whoever was given the project changes it (its entries keep no
   * maker).
   */
  private async admin(_req: Request, fn: () => Promise<Response>): Promise<Response> {
    return fn();
  }

  private async readBody<T>(req: Request): Promise<T> {
    const body = await this.context.parseJsonBody(req);
    return withoutOtherPlan(requireParsedBody(body)) as T;
  }

  private async readOptionalBody<T>(req: Request): Promise<T> {
    const body = await this.context.parseOptionalJsonBody(req);
    return withoutOtherPlan(requireParsedBody(body) ?? {}) as T;
  }
}

/** A body without a plan of its own: the project the call named decides the plan (handle), never an id it also sends. */
function withoutOtherPlan(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const { projectId: _projectId, knowledgeSpaceId: _space, workingDirectory: _folder, ...rest } = body as JsonRecord;
  return rest;
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
