import type {
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorTypedMethodId,
} from '@goodvibes-jev/engine/contracts/generated/foundation-client-types';
import type { OmitNamed } from '@goodvibes-jev/engine/contracts';
import {
  createScopedBrowserPlatform,
  forScopedBrowserSession,
  SHARED_BROWSER_ROUTES,
  type BrowserScopedRouteDefinition,
  type ScopedBrowserPlatform,
  type ScopedEventStreamOptions,
  type ScopedBrowserPlatformOptions,
  type SharedBrowserMethodId,
} from './browser-scoped.js';
import type { ServerSentEventHandlers } from './transport-http.js';

/**
 * The input type of `TMethodId` minus the key this wrapper supplies from its own
 * positional argument (the id already in the URL path).
 *
 * `OmitNamed` rather than a plain `Omit`, see @goodvibes-jev/engine/contracts'
 * typed-io-keys.ts: an `additionalProperties: true` verb renders with a broad
 * index signature, and `Omit` collapses the whole named shape against it.
 */
type OperatorInputWithout<TMethodId extends OperatorTypedMethodId, TKey extends string> = OmitNamed<
  OperatorMethodInput<TMethodId>,
  TKey
>;

/**
 * The browser route table for the knowledge methods and the routes shared with
 * them. `prefix` is where the knowledge routes live: the base knowledge wiki,
 * or another product's own space (the agent's). Work-plan, artifact and
 * companion-chat routes do not move with it.
 */
export function createKnowledgeBrowserRoutes(prefix: string) {
  return {
    'knowledge.ask': { method: 'POST', path: `${prefix}/ask` },
    'knowledge.candidate.decide': { method: 'POST', path: `${prefix}/candidates/{id}/decide` },
    'knowledge.candidate.get': { method: 'GET', path: `${prefix}/candidates/{id}` },
    'knowledge.candidates.list': { method: 'GET', path: `${prefix}/candidates` },
    'knowledge.connector.doctor': { method: 'GET', path: `${prefix}/connectors/{id}/doctor` },
    'knowledge.connector.get': { method: 'GET', path: `${prefix}/connectors/{id}` },
    'knowledge.connectors.list': { method: 'GET', path: `${prefix}/connectors` },
    'knowledge.extraction.get': { method: 'GET', path: `${prefix}/extractions/{id}` },
    'knowledge.extractions.list': { method: 'GET', path: `${prefix}/extractions` },
    'knowledge.graphql.execute': { method: 'POST', path: `${prefix}/graphql` },
    'knowledge.graphql.schema': { method: 'GET', path: `${prefix}/graphql/schema` },
    'knowledge.ingest.artifact': { method: 'POST', path: `${prefix}/ingest/artifact` },
    'knowledge.ingest.bookmarks': { method: 'POST', path: `${prefix}/ingest/bookmarks` },
    'knowledge.ingest.browserHistory': { method: 'POST', path: `${prefix}/ingest/browser-history` },
    'knowledge.ingest.connector': { method: 'POST', path: `${prefix}/ingest/connector` },
    'knowledge.ingest.url': { method: 'POST', path: `${prefix}/ingest/url` },
    'knowledge.ingest.urls': { method: 'POST', path: `${prefix}/ingest/urls` },
    'knowledge.issue.review': { method: 'POST', path: `${prefix}/issues/{id}/review` },
    'knowledge.issues.list': { method: 'GET', path: `${prefix}/issues` },
    'knowledge.item.get': { method: 'GET', path: `${prefix}/items/{id}` },
    'knowledge.job-runs.list': { method: 'GET', path: `${prefix}/job-runs` },
    'knowledge.job.get': { method: 'GET', path: `${prefix}/jobs/{jobId}` },
    'knowledge.job.run': { method: 'POST', path: `${prefix}/jobs/{jobId}/run` },
    'knowledge.jobs.list': { method: 'GET', path: `${prefix}/jobs` },
    'knowledge.lint': { method: 'POST', path: `${prefix}/lint` },
    'knowledge.map': { method: 'GET', path: `${prefix}/map` },
    'knowledge.nodes.list': { method: 'GET', path: `${prefix}/nodes` },
    'knowledge.packet': { method: 'POST', path: `${prefix}/packet` },
    'knowledge.projection.materialize': { method: 'POST', path: `${prefix}/projections/materialize` },
    'knowledge.projection.render': { method: 'POST', path: `${prefix}/projections/render` },
    'knowledge.projections.list': { method: 'GET', path: `${prefix}/projections` },
    'knowledge.refinement.run': { method: 'POST', path: `${prefix}/refinement/run` },
    'knowledge.refinement.task.cancel': { method: 'POST', path: `${prefix}/refinement/tasks/{id}/cancel` },
    'knowledge.refinement.task.get': { method: 'GET', path: `${prefix}/refinement/tasks/{id}` },
    'knowledge.refinement.tasks.list': { method: 'GET', path: `${prefix}/refinement/tasks` },
    'knowledge.reindex': { method: 'POST', path: `${prefix}/reindex` },
    'knowledge.report.get': { method: 'GET', path: `${prefix}/reports/{id}` },
    'knowledge.reports.list': { method: 'GET', path: `${prefix}/reports` },
    'knowledge.schedule.delete': { method: 'DELETE', path: `${prefix}/schedules/{id}` },
    'knowledge.schedule.enable': { method: 'POST', path: `${prefix}/schedules/{id}/enabled` },
    'knowledge.schedule.get': { method: 'GET', path: `${prefix}/schedules/{id}` },
    'knowledge.schedule.save': { method: 'POST', path: `${prefix}/schedules` },
    'knowledge.schedules.list': { method: 'GET', path: `${prefix}/schedules` },
    'knowledge.search': { method: 'POST', path: `${prefix}/search` },
    'knowledge.source.extraction.get': { method: 'GET', path: `${prefix}/sources/{id}/extraction` },
    'knowledge.sources.list': { method: 'GET', path: `${prefix}/sources` },
    'knowledge.status': { method: 'GET', path: `${prefix}/status` },
    'knowledge.usage.list': { method: 'GET', path: `${prefix}/usage` },
    'projectPlanning.workPlan.clearCompleted': { method: 'POST', path: '/api/projects/planning/work-plan/clear-completed' },
    'projectPlanning.workPlan.snapshot': { method: 'GET', path: '/api/projects/planning/work-plan' },
    'projectPlanning.workPlan.task.create': { method: 'POST', path: '/api/projects/planning/work-plan/tasks' },
    'projectPlanning.workPlan.task.delete': { method: 'DELETE', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
    'projectPlanning.workPlan.task.get': { method: 'GET', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
    'projectPlanning.workPlan.task.status': { method: 'POST', path: '/api/projects/planning/work-plan/tasks/{taskId}/status' },
    'projectPlanning.workPlan.task.update': { method: 'PATCH', path: '/api/projects/planning/work-plan/tasks/{taskId}' },
    'projectPlanning.workPlan.tasks.list': { method: 'GET', path: '/api/projects/planning/work-plan/tasks' },
    'projectPlanning.workPlan.tasks.reorder': { method: 'POST', path: '/api/projects/planning/work-plan/tasks/reorder' },
    'artifacts.create': { method: 'POST', path: '/api/artifacts' },
    'artifacts.get': { method: 'GET', path: '/api/artifacts/{artifactId}' },
    'artifacts.list': { method: 'GET', path: '/api/artifacts' },
    'companion.chat.messages.create': { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages' },
    'companion.chat.messages.list': { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/messages' },
    'companion.chat.sessions.create': { method: 'POST', path: '/api/companion/chat/sessions' },
    'companion.chat.sessions.get': { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}' },
    'companion.chat.sessions.list': { method: 'GET', path: '/api/companion/chat/sessions' },
    'companion.chat.sessions.update': { method: 'PATCH', path: '/api/companion/chat/sessions/{sessionId}' },
    'companion.chat.messages.steer': { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages/steer' },
    'companion.chat.turns.cancel': { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/turns/cancel' },
  } as const satisfies Partial<Record<OperatorTypedMethodId, BrowserScopedRouteDefinition>>;
}

export const KNOWLEDGE_BROWSER_ROUTES = createKnowledgeBrowserRoutes('/api/knowledge');

export const KNOWLEDGE_BROWSER_DOMAINS = [
  'session',
  'turn',
  'tasks',
  'providers',
  'knowledge',
  'control-plane',
] as const;

export type BrowserKnowledgeMethodId =
  | SharedBrowserMethodId
  | Extract<keyof typeof KNOWLEDGE_BROWSER_ROUTES, OperatorTypedMethodId>;

export type BrowserKnowledgeDomain = typeof KNOWLEDGE_BROWSER_DOMAINS[number];

/**
 * The declared properties of `T`, with any index signature dropped.
 *
 * Body-envelope inputs are open (`additionalProperties: true`), which renders
 * as an intersection with `{ readonly [key: string]: unknown }`. That single
 * addition breaks `Omit`: `keyof` an intersection carrying an index signature
 * is `string | number`, so omitting a named key removes nothing and keeps
 * nothing, and the result is a bare record. Every helper below that took
 * `Omit<Input, 'sessionId'>` was therefore accepting anything at all, not
 * because of the requirement branches, which came later, but from the moment
 * the envelope was opened. Dropping the index signature first is what makes
 * the omit mean something.
 */
type DeclaredKeys<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * `Omit` that survives both the index signature and a union.
 *
 * Distributing matters as much as `DeclaredKeys`: the companion-chat verbs
 * whose required set is conditional are typed as a base intersected with a
 * union of requirement branches, and a non-distributive `Omit` collapses that
 * union to its members' common keys, discarding the requirement it exists to
 * state.
 */
type OmitDeclared<T, TKeys extends PropertyKey> = T extends unknown
  ? Omit<DeclaredKeys<T>, TKeys>
  : never;

export interface BrowserKnowledgePlatform extends ScopedBrowserPlatform<BrowserKnowledgeMethodId, BrowserKnowledgeDomain> {
  readonly knowledge: {
    ask(input: OperatorMethodInput<'knowledge.ask'>): Promise<OperatorMethodOutput<'knowledge.ask'>>;
    search(input: OperatorMethodInput<'knowledge.search'>): Promise<OperatorMethodOutput<'knowledge.search'>>;
    status(input?: OperatorMethodInput<'knowledge.status'>): Promise<OperatorMethodOutput<'knowledge.status'>>;
    map(input?: OperatorMethodInput<'knowledge.map'>): Promise<OperatorMethodOutput<'knowledge.map'>>;
  };
  readonly chat: {
    readonly sessions: {
      create(input?: OperatorMethodInput<'companion.chat.sessions.create'>): Promise<OperatorMethodOutput<'companion.chat.sessions.create'>>;
      get(sessionId: string): Promise<OperatorMethodOutput<'companion.chat.sessions.get'>>;
      list(input?: OperatorMethodInput<'companion.chat.sessions.list'>): Promise<OperatorMethodOutput<'companion.chat.sessions.list'>>;
      update(
        sessionId: string,
        input: OperatorInputWithout<'companion.chat.sessions.update', 'sessionId'>,
      ): Promise<OperatorMethodOutput<'companion.chat.sessions.update'>>;
    };
    readonly messages: {
      create(
        sessionId: string,
        input: OperatorInputWithout<'companion.chat.messages.create', 'sessionId'>,
      ): Promise<OperatorMethodOutput<'companion.chat.messages.create'>>;
      /** The whole transcript, or one page of it with `limit` and/or `before` (see `nextBefore`). */
      list(
        sessionId: string,
        page?: OperatorInputWithout<'companion.chat.messages.list', 'sessionId'>,
      ): Promise<OperatorMethodOutput<'companion.chat.messages.list'>>;
      /**
       * Interrupt-and-send: cancels the in-flight turn (honest partial +
       * terminal turn.cancelled to every subscriber) and runs this message
       * immediately. Feature-detect with isMethodUnavailableError and fall
       * back to an ordinary create on older daemons.
       */
      steer(
        sessionId: string,
        input: OperatorInputWithout<'companion.chat.messages.steer', 'sessionId'>,
      ): Promise<OperatorMethodOutput<'companion.chat.messages.steer'>>;
    };
    readonly turns: {
      /**
       * Server-side stop for the in-flight turn. The terminal `turn.cancelled`
       * event on the session stream is the authoritative convergence signal;
       * treat 404 NO_ACTIVE_TURN as benign (the turn finished first).
       */
      cancel(
        sessionId: string,
        input?: OperatorInputWithout<'companion.chat.turns.cancel', 'sessionId'>,
      ): Promise<OperatorMethodOutput<'companion.chat.turns.cancel'>>;
    };
    readonly events: {
      stream(
        sessionId: string,
        handlers: ServerSentEventHandlers,
        options?: ScopedEventStreamOptions,
      ): Promise<() => void>;
    };
  };
  readonly artifacts: {
    create(input: OperatorMethodInput<'artifacts.create'>): Promise<OperatorMethodOutput<'artifacts.create'>>;
    get(artifactId: string): Promise<OperatorMethodOutput<'artifacts.get'>>;
    list(): Promise<OperatorMethodOutput<'artifacts.list'>>;
  };
  readonly workPlan: {
    snapshot(input?: OperatorMethodInput<'projectPlanning.workPlan.snapshot'>): Promise<OperatorMethodOutput<'projectPlanning.workPlan.snapshot'>>;
    readonly tasks: {
      list(input?: OperatorMethodInput<'projectPlanning.workPlan.tasks.list'>): Promise<OperatorMethodOutput<'projectPlanning.workPlan.tasks.list'>>;
      get(taskId: string, input?: OperatorInputWithout<'projectPlanning.workPlan.task.get', 'taskId'>): Promise<OperatorMethodOutput<'projectPlanning.workPlan.task.get'>>;
      create(input: OperatorMethodInput<'projectPlanning.workPlan.task.create'>): Promise<OperatorMethodOutput<'projectPlanning.workPlan.task.create'>>;
      update(
        taskId: string,
        input: OperatorInputWithout<'projectPlanning.workPlan.task.update', 'taskId'>,
      ): Promise<OperatorMethodOutput<'projectPlanning.workPlan.task.update'>>;
      status(
        taskId: string,
        input: OperatorInputWithout<'projectPlanning.workPlan.task.status', 'taskId'>,
      ): Promise<OperatorMethodOutput<'projectPlanning.workPlan.task.status'>>;
      reorder(input: OperatorMethodInput<'projectPlanning.workPlan.tasks.reorder'>): Promise<OperatorMethodOutput<'projectPlanning.workPlan.tasks.reorder'>>;
      delete(taskId: string, input?: OperatorInputWithout<'projectPlanning.workPlan.task.delete', 'taskId'>): Promise<OperatorMethodOutput<'projectPlanning.workPlan.task.delete'>>;
      clearCompleted(input?: OperatorMethodInput<'projectPlanning.workPlan.clearCompleted'>): Promise<OperatorMethodOutput<'projectPlanning.workPlan.clearCompleted'>>;
    };
  };
}

export function createBrowserKnowledgePlatform(options: ScopedBrowserPlatformOptions = {}): BrowserKnowledgePlatform {
  return createBrowserKnowledgePlatformFromRoutes(KNOWLEDGE_BROWSER_ROUTES, options);
}

export function createBrowserKnowledgePlatformFromRoutes(
  knowledgeRoutes: Partial<Record<BrowserKnowledgeMethodId, BrowserScopedRouteDefinition>>,
  options: ScopedBrowserPlatformOptions = {},
): BrowserKnowledgePlatform {
  const platformClient = createScopedBrowserPlatform<BrowserKnowledgeMethodId, BrowserKnowledgeDomain>(
    {
      ...SHARED_BROWSER_ROUTES,
      ...knowledgeRoutes,
    } as Record<BrowserKnowledgeMethodId, BrowserScopedRouteDefinition>,
    KNOWLEDGE_BROWSER_DOMAINS,
    options,
  );
  const invoke = platformClient.operator.invoke;
  return {
    ...platformClient,
    knowledge: {
      ask: (input) => invoke('knowledge.ask', input),
      search: (input) => invoke('knowledge.search', input),
      status: (input) => invoke('knowledge.status', input),
      map: (input) => invoke('knowledge.map', input),
    },
    chat: {
      sessions: {
        create: (input) => invoke('companion.chat.sessions.create', input),
        get: (id) => invoke('companion.chat.sessions.get', { sessionId: id }),
        list: (input) => invoke('companion.chat.sessions.list', input),
        update: (id, input) => invoke('companion.chat.sessions.update', { sessionId: id, ...input }),
      },
      messages: {
        create: (id, input) => invoke('companion.chat.messages.create', { sessionId: id, ...input }),
        list: (id, page) => invoke('companion.chat.messages.list', { sessionId: id, ...(page ?? {}) }),
        steer: (id, input) => invoke('companion.chat.messages.steer', { sessionId: id, ...input }),
      },
      turns: {
        cancel: (id, input) => invoke('companion.chat.turns.cancel', { sessionId: id, ...(input ?? {}) }),
      },
      events: {
        stream: (id, handlers, options) =>
          platformClient.streams.open('/api/companion/chat/sessions/' + id + '/events', handlers, options),
      },
    },
    artifacts: {
      create: (input) => invoke('artifacts.create', input),
      get: (artifactId) => invoke('artifacts.get', { artifactId }),
      list: () => invoke('artifacts.list'),
    },
    workPlan: {
      snapshot: (input) => invoke('projectPlanning.workPlan.snapshot', input),
      tasks: {
        list: (input) => invoke('projectPlanning.workPlan.tasks.list', input),
        get: (taskId, input) => invoke('projectPlanning.workPlan.task.get', { taskId, ...(input ?? {}) }),
        create: (input) => invoke('projectPlanning.workPlan.task.create', input),
        update: (taskId, input) => invoke('projectPlanning.workPlan.task.update', { taskId, ...input }),
        status: (taskId, input) => invoke('projectPlanning.workPlan.task.status', { taskId, ...input }),
        reorder: (input) => invoke('projectPlanning.workPlan.tasks.reorder', input),
        delete: (taskId, input) => invoke('projectPlanning.workPlan.task.delete', { taskId, ...(input ?? {}) }),
        clearCompleted: (input) => invoke('projectPlanning.workPlan.clearCompleted', input),
      },
    },
  };
}

export { forScopedBrowserSession as forSession };
