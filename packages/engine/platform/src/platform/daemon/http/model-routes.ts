import { requestedEffortOverride } from '../../providers/reasoning-effort-surface.js';
/**
 * model-routes.ts
 *
 * HTTP route handlers for model catalog discovery and global model selection.
 *
 * Routes:
 *   GET    /api/models         , list all providers + models with configured flags
 *   GET    /api/models/current , return current model + configured status
 *   PATCH  /api/models/current , switch current model live
 *
 * All routes require the existing daemon bearer-token auth (enforced by the
 * caller, DaemonHttpRouter.handleRequest validates auth before dispatching).
 */

import type { ProviderRegistry } from '../../providers/registry.js';
import type { ConfigManager } from '../../config/manager.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { ProviderAuthRouteDescriptor } from '../../providers/interface.js';
import type { ConfiguredVia, ProviderConfiguredStatus } from '../../providers/configured-status.js';
import { findModelDefinition } from '../../providers/registry-models.js';
import { resolveModelReference } from '../../providers/model-id-resolution.js';
import { providerDisplayLabel } from '../../providers/provider-labels.js';
import {
  REASONING_EFFORT_SEVERITY,
  readReasoningEffortLevel,
  resolveEffortForModel,
  type ReasoningEffortSource,
} from '../../providers/reasoning-effort.js';
import { resolveReasoningEffortSpec } from '../../providers/reasoning-effort-families.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Response shape types
// ---------------------------------------------------------------------------

export interface ProviderModelRef {
  readonly registryKey: string;
  readonly provider: string;
  readonly id: string;
}

/** The reasoning levels one model actually offers, and which source resolved them. */
export interface ModelReasoningOptions {
  readonly levels: string[];
  readonly source: ReasoningEffortSource;
  /** Exact platform resolution for a remembered request on this model; null omits the wire field. */
  readonly effectiveByRequested?: Readonly<Record<string, string | null>> | undefined;
}

export interface ProviderModelEntry {
  readonly id: string;
  readonly registryKey: string;
  readonly provider: string;
  readonly label?: string | undefined;
  readonly contextWindow?: number | undefined;
  /** Absent when the model does not reason at all. */
  readonly reasoningOptions?: ModelReasoningOptions | undefined;
}

export type { ConfiguredVia } from '../../providers/configured-status.js';

export interface ModelRouteProviderRecord {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia | undefined;
  readonly envVars: string[];
  readonly routes?: readonly ProviderAuthRouteDescriptor[] | undefined;
  readonly models: ProviderModelEntry[];
}

export interface ListProviderModelsResponse {
  readonly providers: ModelRouteProviderRecord[];
  readonly currentModel: ProviderModelRef | null;
  /** Always false: the provider registry reads the secret stores for every listing. */
  readonly secretsResolutionSkipped: boolean;
}

export interface CurrentModelResponse {
  readonly model: ProviderModelRef | null;
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia | undefined;
  readonly routes?: readonly ProviderAuthRouteDescriptor[] | undefined;
  /** The persisted reasoning level, null when none has been set explicitly. */
  readonly effort: string | null;
}

export interface PatchCurrentModelResponse extends CurrentModelResponse {
  readonly persisted: boolean;
}

// ---------------------------------------------------------------------------
// Route context
// ---------------------------------------------------------------------------

export interface ModelRouteContext {
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The registry's answer for one provider, or not configured when it has none. */
async function configuredStatusOf(providerRegistry: ProviderRegistry, providerId: string): Promise<ProviderConfiguredStatus> {
  return (await providerRegistry.describeConfiguredProviders([providerId])).get(providerId) ?? { configured: false, envVars: [] };
}

async function buildCurrentModelResponse(
  providerRegistry: ProviderRegistry,
  configManager: ConfigManager,
  statuses?: ReadonlyMap<string, ProviderConfiguredStatus>,
): Promise<CurrentModelResponse> {
  let model: ProviderModelRef | null = null;
  let status: ProviderConfiguredStatus | undefined;
  try {
    const current = providerRegistry.getCurrentModel();
    model = { registryKey: current.registryKey, provider: current.provider, id: current.id };
    status = statuses?.get(current.provider) ?? await configuredStatusOf(providerRegistry, current.provider);
  } catch {
    // No model configured
  }
  return {
    model,
    configured: status?.configured ?? false,
    configuredVia: status?.configuredVia,
    ...(status?.routes ? { routes: status.routes } : {}),
    effort: requestedEffortOverride(configManager),
  };
}

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

/**
 * The paths this sub-router serves, and the method-catalog verb each one is.
 *
 * Exported because it is READ by the capability-route reconcile
 * (control-plane/method-catalog-route-reconcile.ts): router.ts dispatches this
 * sub-router before the shared route table, so the reconcile's probe cannot see
 * these paths and used to skip them by prefix, which is how three verbs stayed
 * outside the catalog with nothing noticing. The dispatch below is driven off
 * this same table, so the two cannot drift.
 */
export const MODEL_ROUTES: readonly { readonly method: string; readonly path: string; readonly methodId: string }[] = [
  { method: 'GET', path: '/api/models', methodId: 'models.list' },
  { method: 'GET', path: '/api/models/current', methodId: 'models.current.get' },
  { method: 'PATCH', path: '/api/models/current', methodId: 'models.current.set' },
];

export async function dispatchModelRoutes(
  req: Request,
  context: ModelRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const matched = MODEL_ROUTES.find((entry) => entry.path === pathname && entry.method === req.method);
  if (!matched) return null;

  switch (matched.methodId) {
    case 'models.list':
      return handleListProviderModels(context);
    case 'models.current.get':
      return handleGetCurrentModel(context);
    default:
      return handlePatchCurrentModel(req, context);
  }
}

// ---------------------------------------------------------------------------
// GET /api/models
// ---------------------------------------------------------------------------

async function handleListProviderModels(context: ModelRouteContext): Promise<Response> {
  const { providerRegistry } = context;

  // Remote pickers get the same freshness as the TUI's picker-open hook: a
  // GET triggers the TTL-respecting live-discovery re-check. Fire-and-forget
  //, the response serves the current list immediately (fresher on the next
  // read) so a slow provider can never block it, and the TTL keeps repeat
  // GETs cheap (no forced refetch storms).
  void providerRegistry.refreshLiveModelDiscovery?.().catch((error) => {
    logger.warn('[models] live-discovery refresh on list failed', { error: error instanceof Error ? error.message : String(error) });
  });

  const allModels = providerRegistry.listModels();
  // Group models by provider
  const byProvider = new Map<string, ProviderModelEntry[]>();
  for (const model of allModels) {
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
    // Resolved the same way the turn path resolves it (resolveTurnReasoning in
    // core/orchestrator-turn-loop.ts): a model that does not reason gets no
    // reasoningOptions at all, everything else reports the levels its resolved
    // spec actually offers and which source said so.
    const reasoningSpec = model.capabilities.reasoning
      ? resolveReasoningEffortSpec({
          provider: model.provider, modelId: model.id,
          ...(model.reasoningEffort ? { spec: model.reasoningEffort } : {}),
        })
      : undefined;
    byProvider.get(model.provider)?.push({
      id: model.id,
      registryKey: model.registryKey,
      provider: model.provider,
      label: model.displayName ?? model.id,
      contextWindow: model.contextWindow > 0 ? model.contextWindow : undefined,
      ...(reasoningSpec
        ? { reasoningOptions: {
          levels: [...reasoningSpec.values], source: reasoningSpec.source,
          effectiveByRequested: Object.fromEntries(REASONING_EFFORT_SEVERITY.map(requested => [
            requested, resolveEffortForModel(requested, { ...model, reasoningEffort: reasoningSpec }).value ?? null,
          ])),
        } }
        : {}),
    });
  }

  // One reading of the stores answers every provider, the current one included.
  let currentProvider: string | undefined;
  try { currentProvider = providerRegistry.getCurrentModel().provider; } catch { currentProvider = undefined; }
  const statuses = await providerRegistry.describeConfiguredProviders(
    currentProvider === undefined ? [...byProvider.keys()] : [...byProvider.keys(), currentProvider]);
  const providers: ModelRouteProviderRecord[] = [];
  for (const [providerId, models] of byProvider) {
    const status = statuses.get(providerId) ?? { configured: false, envVars: [] };
    providers.push({
      id: providerId,
      label: providerDisplayLabel(providerId),
      configured: status.configured,
      configuredVia: status.configuredVia,
      envVars: [...status.envVars],
      ...(status.routes ? { routes: status.routes } : {}),
      models,
    });
  }

  // Sort: configured first, then alphabetical
  providers.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const currentModel = (await buildCurrentModelResponse(providerRegistry, context.configManager, statuses)).model;

  const body: ListProviderModelsResponse = {
    providers,
    currentModel,
    secretsResolutionSkipped: false,
  };
  return Response.json(body);
}

// ---------------------------------------------------------------------------
// GET /api/models/current
// ---------------------------------------------------------------------------

async function handleGetCurrentModel(context: ModelRouteContext): Promise<Response> {
  return Response.json(await buildCurrentModelResponse(context.providerRegistry, context.configManager));
}

// ---------------------------------------------------------------------------
// PATCH /api/models/current
// ---------------------------------------------------------------------------

async function handlePatchCurrentModel(
  req: Request,
  context: ModelRouteContext,
): Promise<Response> {
  // Admin only: `models.current.set` is an admin method in the catalog, which the gateway binding enforces before this runs.
  const { providerRegistry, configManager } = context;

  const bodyOrErr = await context.parseJsonBody(req);
  if (bodyOrErr instanceof Response) return bodyOrErr;

  const body = bodyOrErr as Record<string, unknown>;
  const rawModelReference = typeof body['registryKey'] === 'string' ? body['registryKey'] : null;

  if (!rawModelReference) {
    return Response.json(
      { error: 'Missing required field: registryKey', code: 'INVALID_ARGUMENT' },
      { status: 400 },
    );
  }

  // Optional reasoning level, persisted with the selection. Validated against
  // the known severity ladder here; which levels the chosen model actually
  // accepts is settled per turn by resolveEffortForModel, which only ever
  // snaps down. An explicit null CLEARS the persisted level back to the
  // provider default; omission leaves it untouched. Without the null arm a
  // level, once set, could never be undone.
  const rawEffort = body['effort'];
  let effort: string | null | undefined;
  if (rawEffort === null) {
    effort = null;
  } else if (rawEffort !== undefined) {
    effort = readReasoningEffortLevel(rawEffort);
    if (effort === undefined) {
      return Response.json(
        {
          error: `Invalid effort '${String(rawEffort)}': expected one of [${REASONING_EFFORT_SEVERITY.join(', ')}], or null to restore the provider default`,
          code: 'INVALID_ARGUMENT',
        },
        { status: 400 },
      );
    }
  }

  // Accepts either a provider-qualified registryKey or a bare model id, bare
  // ids resolve via the shared resolver (unique -> auto-qualify; ambiguous or
  // unknown -> a rich error naming real candidates from the live registry).
  const allModels = providerRegistry.listModels();
  let registryKey: string;
  try {
    registryKey = resolveModelReference(rawModelReference, allModels);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message, code: 'INVALID_ARGUMENT' }, { status: 400 });
  }

  const modelDef = findModelDefinition(registryKey, allModels);
  if (!modelDef) {
    return Response.json(
      { error: `Model '${registryKey}' not in registry`, code: 'MODEL_NOT_FOUND' },
      { status: 400 },
    );
  }

  // Check provider is configured. Runtime auth routes cover subscription-backed
  // providers like OpenAI, where the public model remains `openai:*` but the
  // actual turn path aliases to the subscription-backed provider at runtime.
  const configuredStatus = await configuredStatusOf(providerRegistry, modelDef.provider);
  const envVars = [...configuredStatus.envVars];
  if (!configuredStatus.configured) {
    const errorMessage = envVars.length > 0
      ? `Provider '${modelDef.provider}' not configured: set one of [${envVars.join(', ')}]`
      : `Provider '${modelDef.provider}' is not configured. Check the provider's configuration (env var, subscription, or network discovery).`;
    return Response.json(
      {
        error: errorMessage,
        code: 'PROVIDER_NOT_CONFIGURED',
        missingEnvVars: envVars,
      },
      { status: 409 },
    );
  }

  try {
    providerRegistry.setCurrentModel(registryKey);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message, code: 'SET_MODEL_FAILED' }, { status: 400 });
  }

  // Persist to config
  let persisted = false;
  try {
    configManager.set('provider.model', modelDef.registryKey);
    persisted = true;
  } catch (persistErr: unknown) {
    const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    logger.warn(`[model-routes] Failed to persist model selection to config: ${msg}`);
  }
  if (effort !== undefined) {
    try {
      if (effort === null) configManager.reset('provider.reasoningEffort');
      else configManager.set('provider.reasoningEffort', effort);
    } catch (persistErr: unknown) {
      persisted = false;
      const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      logger.warn(`[model-routes] Failed to persist reasoning effort to config: ${msg}`);
    }
  }

  // setCurrentModel emits MODEL_CHANGED synchronously on the same runtimeBus,
  // no second emission needed here.
  return Response.json({ ...(await buildCurrentModelResponse(providerRegistry, configManager, new Map([[modelDef.provider, configuredStatus]]))), persisted });
}
