import type {
  ServiceConfig,
  ServiceConnectionTestResult,
  ServiceInspection,
} from '../config/service-registry.js';
import type {
  PendingSubscriptionLogin,
  ProviderSubscription,
} from '../config/subscriptions.js';
import type { LocalAuthSnapshot } from '../security/user-auth.js';
import type { SessionInfo } from '../sessions/manager.js';
import type { Tool } from '../types/tools.js';
import type { ModelDefinition } from '../providers/registry.js';
import type {
  ProviderApi,
  ProviderRuntimeSnapshot,
} from '../providers/provider-api.js';
import type { ExecutionPlan } from '../core/execution-plan.js';
import type { PlannerDecision, ExecutionStrategy } from '../core/adaptive-planner.js';

export interface EnvironmentVariableQuery {
  hasEnvironmentVariable(name: string): boolean;
}

export interface ServiceInspectionQuery {
  getAll(): Record<string, ServiceConfig>;
  inspect(name: string): Promise<ServiceInspection | null>;
  /** Why the services file cannot be used, or null; an empty getAll() with a reason is not "no services". */
  unreadableReason?(): string | null;
  testConnection(name: string): Promise<ServiceConnectionTestResult>;
}

export interface SubscriptionAccessQuery {
  list(): ProviderSubscription[];
  listPending(): PendingSubscriptionLogin[];
  get(provider: string): ProviderSubscription | null;
  getPending(provider: string): PendingSubscriptionLogin | null;
  getAccessToken(provider: string): string | null;
  /** Resolves true when there was a sign-in or pending login to remove; rejects when its tokens could not leave the secret store. */
  logout(provider: string): Promise<boolean>;
}

export interface LocalAuthInspectionQuery {
  inspect(): LocalAuthSnapshot;
}

export interface SessionBrowserQuery {
  list(): SessionInfo[];
  search(query: string): Array<{ session: SessionInfo; matchCount: number; snippets: string[] }>;
  delete(name: string): void;
}

export interface SessionMemoryQuery {
  list(): readonly unknown[];
}

export interface ToolCatalogQuery {
  list(): Tool[];
}

export interface ProviderModelCatalogQuery {
  listModels(): ModelDefinition[];
}

export interface ProviderAccountInspectionQuery {
  readonly providerModels: ProviderModelCatalogQuery;
  readonly services: Pick<ServiceInspectionQuery, 'getAll' | 'inspect' | 'unreadableReason'>;
  readonly subscriptions: Pick<SubscriptionAccessQuery, 'list' | 'listPending' | 'get' | 'getPending'>;
  readonly environment: EnvironmentVariableQuery;
}

export interface ProviderRuntimeInspectionQuery {
  listProviderIds(): readonly string[];
  inspectAll(): Promise<readonly ProviderRuntimeSnapshot[]>;
  inspect(providerId: string): Promise<ProviderRuntimeSnapshot | null>;
}

export interface PlanDashboardQuery {
  getActive(): ExecutionPlan | null;
}

export interface OpsStrategyQuery {
  getLatest(): PlannerDecision | null;
  getMode(): ExecutionStrategy;
  getOverride(): ExecutionStrategy | null;
  getHistory(limit?: number): PlannerDecision[];
}

export function createEnvironmentVariableQuery(
  environment: Readonly<Record<string, string | undefined>>,
): EnvironmentVariableQuery {
  return {
    hasEnvironmentVariable(name: string): boolean {
      return Boolean(environment[name]);
    },
  };
}

/** A reply for another scope than the one asked is a broken contract, not "no providers". */
function scopeMismatch(asked: string, got: string): Error {
  return new Error(`Provider runtime metadata query for scope '${asked}' answered with scope '${got}'.`);
}

export function createProviderRuntimeInspectionQuery(
  providers: Pick<ProviderApi, 'listProviderIds' | 'queryRuntimeMetadata'>,
): ProviderRuntimeInspectionQuery {
  return {
    listProviderIds(): readonly string[] {
      return providers.listProviderIds();
    },

    async inspectAll(): Promise<readonly ProviderRuntimeSnapshot[]> {
      const result = await providers.queryRuntimeMetadata({ scope: 'all' });
      if (result.scope !== 'all') throw scopeMismatch('all', result.scope);
      return result.snapshots;
    },

    async inspect(providerId: string): Promise<ProviderRuntimeSnapshot | null> {
      const result = await providers.queryRuntimeMetadata({ scope: 'provider', providerId });
      if (result.scope !== 'provider') throw scopeMismatch('provider', result.scope);
      return result.snapshot;
    },
  };
}
