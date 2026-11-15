import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ProjectPlanningRoutes } from '../platform/src/platform/daemon/http/project-planning-routes.js';
import { ProjectPlanningService } from '../platform/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project planning routes', () => {
  test('saved planning state is read-only: the retired write routes refuse and point at the work plan', async () => {
    const routes = createRoutes({ admin: true });
    for (const path of ['/api/projects/planning/state', '/api/projects/planning/evaluate', '/api/projects/planning/language']) {
      const response = await routes.handle(jsonRequest(path, { projectId: 'alpha', state: { goal: 'Add feature' } }));
      expect(response?.status).toBe(410);
      expect(await response!.json()).toMatchObject({ code: 'PLANNING_STATE_READ_ONLY' });
    }
    const loaded = await routes.handle(new Request('http://daemon.local/api/projects/planning/state?projectId=alpha'));
    expect(loaded?.status).toBe(200);
    expect(await loaded!.json()).toMatchObject({ state: null });
  });

  test('exposes shared work-plan task routes with admin write protection', async () => {
    const blockedRoutes = createRoutes({ admin: false });
    const blocked = await blockedRoutes.handle(jsonRequest('/api/projects/planning/work-plan/tasks', {
      projectId: 'alpha',
      task: { title: 'Blocked write' },
    }));
    expect(blocked?.status).toBe(403);

    const routes = createRoutes({ admin: true });
    const created = await routes.handle(jsonRequest('/api/projects/planning/work-plan/tasks?projectId=alpha', {
      task: {
        title: 'Ship shared task model',
        owner: 'platform',
        status: 'pending',
        contractId: 'ctr-1',
        originSurface: 'tui',
      },
    }));
    expect(created?.status).toBe(200);
    const createdBody = await created!.json() as { readonly task: { readonly taskId: string; readonly status: string } };
    expect(createdBody.task.status).toBe('pending');

    const status = await routes.handle(jsonRequest(
      `/api/projects/planning/work-plan/tasks/${encodeURIComponent(createdBody.task.taskId)}/status?projectId=alpha`,
      { status: 'done', reason: 'Verified' },
    ));
    expect(status?.status).toBe(200);

    const list = await routes.handle(new Request('http://daemon.local/api/projects/planning/work-plan/tasks?projectId=alpha'));
    expect(list?.status).toBe(200);
    const listBody = await list!.json() as {
      readonly counts: { readonly done: number };
      readonly tasks: readonly { readonly title: string; readonly status: string; readonly completedAt?: number }[];
    };
    expect(listBody.counts.done).toBe(1);
    expect(listBody.tasks[0]?.title).toBe('Ship shared task model');
    expect(typeof listBody.tasks[0]?.completedAt).toBe('number');
  });
});

function createRoutes(input: { readonly admin: boolean }): ProjectPlanningRoutes {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-project-planning-routes-'));
  tmpRoots.push(root);
  const service = new ProjectPlanningService(
    new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }),
    { defaultProjectId: 'default-project' },
  );
  return new ProjectPlanningRoutes({
    projectPlanningService: service,
    parseJsonBody: async (req) => await req.json() as Record<string, unknown>,
    parseOptionalJsonBody: async (req) => req.body ? await req.json() as Record<string, unknown> : null,
    requireAdmin: () => input.admin ? null : Response.json({ error: 'admin required' }, { status: 403 }),
  });
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://daemon.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
