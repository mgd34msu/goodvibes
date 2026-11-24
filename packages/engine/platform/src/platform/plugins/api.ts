import type { CommandRegistryLike, HostCommandOutput, HostSlashCommand } from '../runtime/host-ui.js';
import type { ModelDefinition, ProviderRegistry, RuntimeProviderRegistration, TokenLimits, ModelTier } from '../providers/registry.js';
import type { LLMProvider } from '../providers/interface.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Tool, ToolDefinition } from '../types/tools.js';
import type { RuntimeEventBus, AnyRuntimeEvent, RuntimeEventPayload } from '../runtime/events/index.js';
import type { GatewayMethodCatalog, GatewayMethodDescriptor, GatewayMethodHandler } from '../control-plane/index.js';
import {
  type ChannelDeliveryStrategy,
  type ChannelPlugin,
} from '../channels/index.js';
import type { ChannelDeliveryRouter, ChannelPluginRegistry } from '../channels/index.js';
import type { MemoryEmbeddingProvider, MemoryEmbeddingProviderRegistry } from '../state/index.js';
import type { VoiceProvider, VoiceProviderRegistry } from '../voice/index.js';
import type { MediaProvider, MediaProviderRegistry } from '../media/index.js';
import type { WebSearchProvider, WebSearchProviderRegistry } from '../web-search/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { reasoningEffortSpecFromLevels } from '../providers/reasoning-effort.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { EngineErrorCodes, formatRefusal, refusal, type Refusal } from '@goodvibes/engine/errors';
import { createOwnedPluginCapabilities } from './owned-capabilities.js';
import { PluginClosedError, PluginQuiescingError, type PluginInFlightTracker } from './in-flight.js';
import { enforceBundleCapability, type BundleCapabilityGuard } from '../runtime/ecosystem/bundle-manifest.js';
import type { PluginGrant } from '../runtime/plugins/manifest.js';
import { describeUnappliedTier, type PluginUnappliedTier } from '../runtime/plugins/trust.js';

/**
 * PluginProviderConfig, minimal config for registering a custom LLM provider
 * via an OpenAI-compatible endpoint.
 */
export interface PluginProviderConfig {
  /** Base URL for an OpenAI-compatible endpoint (e.g. "http://localhost:8080/v1"). */
  baseURL: string;
  /** API key. May be empty string for local/unauthenticated servers. */
  apiKey?: string | undefined;
  /** Model IDs this provider exposes. */
  models: string[];
  /** Optional display label shown in the model picker. */
  displayName?: string | undefined;
  /** Optional embedding model exposed by the endpoint. */
  embeddingModel?: string | undefined;
  /** Optional reasoning-format override for compatible endpoints. */
  reasoningFormat?: 'mercury' | 'openrouter' | 'llamacpp' | 'none' | undefined;
  /** Optional context-window metadata for runtime-registered model picker entries. */
  contextWindow?: number | undefined;
  /** Optional runtime capability hints for the registered model entries. */
  capabilities?: Partial<ModelDefinition['capabilities']> | undefined;
  /** Optional reasoning effort options surfaced in the picker. */
  reasoningEffort?: string[] | undefined;
  /** Optional provider tier surfaced in the picker. */
  tier?: ModelTier | undefined;
  /** Optional token limits surfaced in the picker. */
  tokenLimits?: TokenLimits | undefined;
  /** Optional auth env vars for provider posture. */
  authEnvVars?: readonly string[] | undefined;
  /** Optional service names that expose service-owned OAuth. */
  serviceNames?: readonly string[] | undefined;
  /** Optional subscription-provider identity used for stored OAuth posture. */
  subscriptionProviderId?: string | undefined;
  /** Optional provider-qualified catalog registry keys hidden by this runtime provider. */
  suppressCatalogModelRegistryKeys?: readonly string[] | undefined;
}

export interface PluginRuntimeProviderModel {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly selectable?: boolean | undefined;
  readonly capabilities?: Partial<ModelDefinition['capabilities']> | undefined;
  readonly reasoningEffort?: string[] | undefined;
  readonly tier?: ModelTier | undefined;
  readonly tokenLimits?: TokenLimits | undefined;
}

export interface PluginProviderRegistration {
  readonly provider: LLMProvider;
  readonly models?: readonly PluginRuntimeProviderModel[] | undefined;
  readonly suppressCatalogModelRegistryKeys?: readonly string[] | undefined;
  readonly replace?: boolean | undefined;
}

/**
 * PluginToolSchema, JSON Schema for a tool parameter object.
 */
export type PluginToolSchema = Record<string, unknown>;

/**
 * PluginToolHandler, Called when the LLM invokes a plugin-registered tool.
 */
export type PluginToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ success: boolean; output?: string; error?: string }>;

/** What a plugin's slash command can do in the session of the person who typed it. */
export interface PluginCommandContext {
  /** Show text in the session the command was typed in. */
  print(text: string): void;
}

/**
 * PluginCommandHandler, Called when a user runs a plugin-registered slash command.
 * A handler that throws has its error shown to the person who typed the command.
 */
export type PluginCommandHandler = (args: string[], context: PluginCommandContext) => void | Promise<void>;

/**
 * PluginAPI, The constrained API surface exposed to plugins.
 * Plugins receive an instance of this interface during init; they cannot
 * access the wider application implementation details directly.
 */
export interface PluginAPI {
  /** Register a custom slash command. */
  registerCommand(
    name: string,
    description: string,
    handler: PluginCommandHandler,
  ): void;

  /** Register a custom LLM provider (OpenAI-compatible endpoint). */
  registerProvider(name: string, config: PluginProviderConfig): Promise<void>;

  /** Register a fully custom runtime provider instance with optional model entries. */
  registerProviderInstance(registration: PluginProviderRegistration): void;

  /**
   * Register a custom tool available to the LLM. Throws when the plugin already
   * registered a tool with this name, which fails the plugin's start.
   */
  registerTool(
    name: string,
    schema: PluginToolSchema,
    handler: PluginToolHandler,
  ): void;

  /** Register a callable control-plane gateway method. */
  registerGatewayMethod(
    descriptor: Omit<GatewayMethodDescriptor, 'source' | 'pluginId'> & Partial<Pick<GatewayMethodDescriptor, 'source' | 'pluginId'>>,
    handler: GatewayMethodHandler,
  ): void;

  /** Register a channel plugin for a surface such as Slack, Discord, ntfy, or webhooks. */
  registerChannelPlugin(plugin: ChannelPlugin): void;

  /** Register an outbound channel delivery strategy. */
  registerDeliveryStrategy(strategy: ChannelDeliveryStrategy, options?: { readonly replace?: boolean }): void;

  /** Register a memory embedding provider. Sync providers can power sqlite-vec indexing immediately. */
  registerMemoryEmbeddingProvider(provider: MemoryEmbeddingProvider, options?: { readonly replace?: boolean; readonly makeDefault?: boolean }): void;

  /** Register a TS-only voice provider for TTS, STT, or realtime session negotiation. */
  registerVoiceProvider(provider: VoiceProvider, options?: { readonly replace?: boolean }): void;

  /** Register a TS-only media provider for analysis, transform, or generation. */
  registerMediaProvider(provider: MediaProvider, options?: { readonly replace?: boolean }): void;

  /** Register a provider-backed web search adapter. */
  registerWebSearchProvider(provider: WebSearchProvider, options?: { readonly replace?: boolean }): void;

  /** Subscribe to a typed runtime event. Returns an unsubscribe function. */
  onEvent<K extends AnyRuntimeEvent['type']>(
    eventName: K,
    handler: (payload: RuntimeEventPayload<K>) => void,
  ): () => void;

  /** Read a plugin-specific config value from the plugin's stored settings. */
  getConfig(key: string): unknown;

  /** Emit structured log output to the application logger. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}

/** Dependencies passed when creating a PluginAPI instance. */
export interface PluginAPIContext {
  pluginName: string;
  runtimeBus: RuntimeEventBus;
  commandRegistry: CommandRegistryLike;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  gatewayMethods: GatewayMethodCatalog;
  channelRegistry: ChannelPluginRegistry;
  channelDeliveryRouter: ChannelDeliveryRouter;
  memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  voiceProviderRegistry: VoiceProviderRegistry;
  mediaProviderRegistry: MediaProviderRegistry;
  webSearchProviderRegistry: WebSearchProviderRegistry;
  /** Plugin-specific config key-value pairs from plugins.json state. */
  pluginConfig: Record<string, unknown>;
  /** Collect cleanup callbacks so the manager can teardown on disable/reload. */
  cleanup: Array<() => void>;
  /**
   * In-flight accounting for calls into this plugin. When present, every
   * command, tool, gateway method and event hook the plugin registers is
   * counted while it runs and refused while the plugin quiesces for a reload.
   */
  inFlight?: PluginInFlightTracker | undefined;
  /** Per-instance registration lifetime, closed before unloading this instance. */
  registrations?: PluginInFlightTracker | undefined;
  /**
   * Present when the plugin was installed from a pinned bundle: every
   * registration is checked against the grant in its install receipt, and one
   * the bundle did not declare (or its trust tier withheld) fails the start.
   */
  bundleGuard?: BundleCapabilityGuard | undefined;
  /**
   * What this plugin's trust tier grants of what its manifest declares. A tool,
   * provider or event-hook registration needs its capability in `granted`, and
   * a gateway method, channel or delivery strategy needs a tier above
   * `untrusted`; one outside it fails the start with the reason and the
   * command that changes it.
   * Absent only for an embedding that loads a plugin without a trust owner.
   */
  grant?: PluginGrant | undefined;
  /**
   * A tier the owner set that is not applied to this copy (its files changed,
   * or it was given to another folder), read when a refusal is worded so the
   * refusal says so instead of reading as never trusted.
   */
  unappliedTier?: (() => PluginUnappliedTier | undefined) | undefined;
}

const REGISTRATION_NOUN: Readonly<Record<'register.tool' | 'register.provider' | 'register.hook', string>> = {
  'register.tool': 'a tool',
  'register.provider': 'a provider',
  'register.hook': 'an event hook',
};

/**
 * A registration refused because of the plugin's trust tier: setting a higher tier is what lets
 * it start, so a switch-on it refused stays recorded as wanted.
 */
export class PluginTierRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginTierRefusalError';
  }
}

/** Why a registration outside the plugin's grant is refused, and what changes it. */
function grantRefusal(pluginName: string, grant: PluginGrant, capability: 'register.tool' | 'register.provider' | 'register.hook', unapplied: PluginUnappliedTier | undefined): Error {
  const what = REGISTRATION_NOUN[capability];
  if (!grant.declared.has(capability)) {
    return new Error(`plugin '${pluginName}' registered ${what} without declaring '${capability}' in its manifest; `
      + `add "${capability}" to "capabilities" in its manifest.json`);
  }
  return new PluginTierRefusalError(unapplied !== undefined
    ? `plugin '${pluginName}' may not register ${what}: ${describeUnappliedTier(pluginName, unapplied)}; that starts it again at the tier`
    : `plugin '${pluginName}' may not register ${what}: its trust tier is '${grant.tier}', and '${capability}' needs 'limited'. `
      + `Run /plugin trust ${pluginName} limited; that starts it again at that tier`);
}

/**
 * Registrations that need no manifest declaration but reach past this app:
 * an untrusted plugin may not make them, since each would put its code on a
 * path other people or devices use.
 */
const OUTWARD_REGISTRATION: Readonly<Record<'gateway' | 'channel' | 'delivery', string>> = {
  gateway: 'a gateway method: it would answer operator calls from the web UI and other devices',
  channel: 'a channel: it would receive messages from outside',
  delivery: 'a delivery strategy: it would carry replies out to their recipients',
};

/** The refusal shown when a plugin command was refused or threw. */
function commandFailure(pluginName: string, cmdName: string, err: unknown): Refusal {
  if (err instanceof PluginClosedError) {
    return refusal({
      code: 'PLUGIN_STOPPED',
      state: `plugin '${pluginName}' is stopped`,
      reason: `/${cmdName} was not run because the plugin '${pluginName}' is stopped`,
      next: [`Enable the plugin '${pluginName}' again, then run /${cmdName}`],
      retryable: false,
    });
  }
  if (err instanceof PluginQuiescingError) {
    return refusal({
      code: 'PLUGIN_RELOADING',
      state: `plugin '${pluginName}' is reloading`,
      reason: `/${cmdName} was not run because the plugin '${pluginName}' is reloading`,
      next: [`Run /${cmdName} again when the reload finishes`],
      retryable: true,
    });
  }
  return refusal({
    code: 'PLUGIN_COMMAND_FAILED',
    state: 'the command stopped with an error',
    reason: `/${cmdName} failed: ${summarizeError(err)}`,
    next: [`The error comes from the plugin '${pluginName}'; check its settings or report it to its author`],
    retryable: false,
  });
}

/**
 * createPluginAPI, Factory that creates a sandboxed PluginAPI for a single plugin.
 * All registrations are tracked in `ctx.cleanup` so they can be undone on deactivation.
 */
export function createPluginAPI(ctx: PluginAPIContext): PluginAPI {
  const tracker = ctx.inFlight;
  /** Run one call into plugin code through the in-flight tracker, when there is one. */
  const track = <T>(call: () => T): T => {
    if (ctx.registrations?.isClosed(ctx.pluginName)) throw new PluginClosedError(ctx.pluginName);
    const invoke = () => tracker ? tracker.track(ctx.pluginName, call) : call();
    return ctx.registrations ? ctx.registrations.track(ctx.pluginName, invoke) : invoke();
  };
  const assertRegistrationOpen = (): void => {
    if (tracker?.isClosed(ctx.pluginName) || ctx.registrations?.isClosed(ctx.pluginName)) {
      throw new PluginClosedError(ctx.pluginName);
    }
  };
  const register = <T>(action: () => T): T => {
    assertRegistrationOpen();
    return ctx.registrations ? ctx.registrations.track(ctx.pluginName, action) : action();
  };
  const owned = createOwnedPluginCapabilities(track);
  const guard = ctx.bundleGuard;
  const grant = ctx.grant;
  /**
   * Refuse a registration the plugin's trust tier does not grant, then one the
   * bundle's grant does not cover (BundleCapabilityViolation); either throw
   * fails the plugin's start with its reason. A plugin not installed from a
   * bundle has no guard. `names` lists every spelling the declaration may use,
   * the first being the one reported.
   */
  const permit = (runtime: 'register.tool' | 'register.provider' | 'register.hook', surface?: { kind: 'tool' | 'hook'; names: readonly [string, ...string[]] }): void => {
    if (grant && !grant.granted.has(runtime)) throw grantRefusal(ctx.pluginName, grant, runtime, ctx.unappliedTier?.());
    if (!guard) return;
    enforceBundleCapability(guard, 'runtime', runtime);
    if (!surface) return;
    const declared = surface.kind === 'tool' ? guard.mayRegisterTool : guard.maySubscribeHook;
    if (!surface.names.some((name) => declared(name))) enforceBundleCapability(guard, surface.kind, surface.names[0]);
  };
  const permitOutward = (kind: keyof typeof OUTWARD_REGISTRATION): void => {
    if (grant?.tier !== 'untrusted') return;
    const unapplied = ctx.unappliedTier?.();
    throw new PluginTierRefusalError(unapplied !== undefined
      ? `plugin '${ctx.pluginName}' may not register ${OUTWARD_REGISTRATION[kind]}, and ${describeUnappliedTier(ctx.pluginName, unapplied)}; that starts it again at the tier`
      : `plugin '${ctx.pluginName}' may not register ${OUTWARD_REGISTRATION[kind]}, and its trust tier is 'untrusted'. `
        + `Run /plugin trust ${ctx.pluginName} limited; that starts it again at that tier`);
  };
  return {
    registerCommand(name, description, handler) {
      return register(() => {
        // Namespace commands to avoid collisions: "plugin-<pluginName>-<name>"
        const cmdName = `plugin-${ctx.pluginName}-${name}`;
        const cmd: HostSlashCommand = {
          name: cmdName,
          description: `[${ctx.pluginName}] ${description}`,
          handler: async (args: string[], output?: HostCommandOutput) => {
            // A host without a session to print to (the daemon) gets the text in its log.
            const print = (text: string): void => {
              if (typeof output?.print === 'function') output.print(text);
              else logger.info(`[plugin:${ctx.pluginName}] /${cmdName}: ${text}`);
            };
            try {
              await track(() => handler(args, { print }));
            } catch (err) {
              const failure = commandFailure(ctx.pluginName, cmdName, err);
              logger.warn(`[plugin:${ctx.pluginName}] Command '${name}' ${failure.state}: ${failure.reason}`);
              print(formatRefusal(failure));
            }
          },
        };
        ctx.commandRegistry.register(cmd);
        ctx.cleanup.push(() => ctx.commandRegistry.unregister(cmdName));
      });
    },

    registerProvider(name, config) {
      try { return register(async () => {
        permit('register.provider');
        // Dynamically import to avoid circular dependency at module load time.
        const { OpenAICompatProvider } = await import('../providers/openai-compat.js');
        assertRegistrationOpen();
        try {
          const provider = new OpenAICompatProvider({
            name,
            baseURL: config.baseURL,
            apiKey: config.apiKey ?? '',
            defaultModel: config.models[0] ?? '',
            models: config.models,
            ...(config.embeddingModel ? { embeddingModel: config.embeddingModel } : {}),
            ...(config.reasoningFormat ? { reasoningFormat: config.reasoningFormat } : {}),
            ...(config.authEnvVars ? { authEnvVars: config.authEnvVars } : {}),
            ...(config.serviceNames ? { serviceNames: config.serviceNames } : {}),
            ...(config.subscriptionProviderId ? { subscriptionProviderId: config.subscriptionProviderId } : {}),
          });
          const registered = owned.provider(provider);
          const unregister = ctx.providerRegistry.registerRuntimeProvider({
            provider: registered,
            models: config.models.map((modelId) => ({
              id: modelId,
              provider: name,
              registryKey: `${name}:${modelId}`,
              displayName: config.displayName ?? modelId,
              description: `Plugin provider ${name}`,
              contextWindow: config.contextWindow ?? 8192,
              selectable: true,
              capabilities: {
                toolCalling: config.capabilities?.toolCalling ?? true,
                codeEditing: config.capabilities?.codeEditing ?? true,
                reasoning: config.capabilities?.reasoning ?? false,
                multimodal: config.capabilities?.multimodal ?? false,
              },
              ...(config.reasoningEffort
                ? { reasoningEffort: reasoningEffortSpecFromLevels(config.reasoningEffort) }
                : {}),
              ...(config.tier ? { tier: config.tier } : {}),
              ...(config.tokenLimits ? { tokenLimits: config.tokenLimits } : {}),
            })),
            suppressCatalogModelRegistryKeys: config.suppressCatalogModelRegistryKeys,
          });
          ctx.cleanup.push(() => { if (ctx.providerRegistry.has(name) && ctx.providerRegistry.getRegistered(name) === registered) unregister(); });
          logger.info(`[plugin:${ctx.pluginName}] Registered provider '${name}' with ${config.models.length} model(s)`);
        } catch (err) {
          logger.error(`[plugin:${ctx.pluginName}] registerProvider '${name}' failed: ${summarizeError(err)}`);
          throw err;
        }
      }); } catch (error) {
        const refused = Promise.reject(error);
        void refused.catch(() => {});
        return refused;
      }
    },

    registerProviderInstance(registration) {
      return register(() => {
        permit('register.provider');
        const registered = owned.provider(registration.provider);
        const unregister = ctx.providerRegistry.registerRuntimeProvider({
          provider: registered,
          models: (registration.models ?? []).map((model) => ({
            id: model.id,
            provider: registration.provider.name,
            registryKey: `${registration.provider.name}:${model.id}`,
            displayName: model.displayName ?? model.id,
            description: model.description ?? `Plugin provider ${registration.provider.name}`,
            contextWindow: model.contextWindow ?? 8192,
            selectable: model.selectable ?? true,
            capabilities: {
              toolCalling: model.capabilities?.toolCalling ?? true,
              codeEditing: model.capabilities?.codeEditing ?? true,
              reasoning: model.capabilities?.reasoning ?? false,
              multimodal: model.capabilities?.multimodal ?? false,
            },
            ...(model.reasoningEffort
              ? { reasoningEffort: reasoningEffortSpecFromLevels(model.reasoningEffort) }
              : {}),
            ...(model.tier ? { tier: model.tier } : {}),
            ...(model.tokenLimits ? { tokenLimits: model.tokenLimits } : {}),
          })),
          suppressCatalogModelRegistryKeys: registration.suppressCatalogModelRegistryKeys,
          replace: registration.replace,
        } satisfies RuntimeProviderRegistration);
        ctx.cleanup.push(() => { if (ctx.providerRegistry.has(registered.name) && ctx.providerRegistry.getRegistered(registered.name) === registered) unregister(); });
        logger.info(`[plugin:${ctx.pluginName}] Registered provider instance '${registration.provider.name}'`);
      });
    },

    registerTool(name, schema, handler) {
      return register(() => {
        const toolName = `plugin_${ctx.pluginName}_${name}`;
        permit('register.tool', { kind: 'tool', names: [name, toolName] });
        const definition: ToolDefinition = {
          name: toolName,
          description: (schema.description as string) ?? `Plugin tool: ${name}`,
          parameters: schema,
        };
        const tool: Tool = {
          definition,
          execute: async (args: Record<string, unknown>) => {
            try {
              return await track(() => handler(args));
            } catch (err) {
              if (err instanceof PluginQuiescingError) return { success: false, error: err.message };
              return { success: false, error: summarizeError(err) };
            }
          },
        };
        // The registry refuses a name that is taken; the throw fails this
        // plugin's start, so the person sees the reason instead of a missing tool.
        ctx.toolRegistry.register(tool);
        // Removed on deactivate so a reloaded instance registers its own handler.
        ctx.cleanup.push(() => {
          ctx.toolRegistry.unregister(toolName, tool);
        });
      });
    },

    registerGatewayMethod(descriptor, handler) {
      return register(() => {
        permitOutward('gateway');
        const methodId = descriptor.id.startsWith(`plugin.${ctx.pluginName}.`)
          ? descriptor.id
          : `plugin.${ctx.pluginName}.${descriptor.id}`;
        const unregister = ctx.gatewayMethods.register({
          ...descriptor,
          id: methodId,
          source: 'plugin',
          pluginId: ctx.pluginName,
        }, (input) => {
          try {
            return track(() => handler(input));
          } catch (err) {
            if (err instanceof PluginQuiescingError) {
              throw new GatewayVerbError(err.message, EngineErrorCodes.SERVICE_UNAVAILABLE, 503);
            }
            throw err;
          }
        });
        ctx.cleanup.push(unregister);
        logger.info(`[plugin:${ctx.pluginName}] Registered gateway method '${methodId}'`);
      });
    },

    registerChannelPlugin(plugin) {
      return register(() => {
        permitOutward('channel');
        if (guard) enforceBundleCapability(guard, 'channel', plugin.id);
        const registry = ctx.channelRegistry;
        const registered = owned.channel(plugin);
        registry.register(registered);
        ctx.cleanup.push(() => {
          registry.unregister(plugin.id, registered);
        });
        logger.info(`[plugin:${ctx.pluginName}] Registered channel plugin '${plugin.id}'`);
      });
    },

    registerDeliveryStrategy(strategy, options = {}) {
      return register(() => {
        permitOutward('delivery');
        if (guard) enforceBundleCapability(guard, 'channel', strategy.id);
        const router = ctx.channelDeliveryRouter;
        const registered = owned.delivery(strategy);
        router.registerStrategy(registered, options);
        ctx.cleanup.push(() => {
          if (router.listStrategies().includes(registered)) router.unregisterStrategy(strategy.id);
        });
        logger.info(`[plugin:${ctx.pluginName}] Registered delivery strategy '${strategy.id}'`);
      });
    },

    registerMemoryEmbeddingProvider(provider, options = {}) {
      return register(() => {
        permit('register.provider');
        const unregister = ctx.memoryEmbeddingRegistry.register(owned.memory(provider), options);
        ctx.cleanup.push(unregister);
        logger.info(`[plugin:${ctx.pluginName}] Registered memory embedding provider '${provider.id}'`);
      });
    },

    registerVoiceProvider(provider, options = {}) {
      return register(() => {
        permit('register.provider');
        const unregister = ctx.voiceProviderRegistry.register(owned.voice(provider), options);
        ctx.cleanup.push(unregister);
        logger.info(`[plugin:${ctx.pluginName}] Registered voice provider '${provider.id}'`);
      });
    },

    registerMediaProvider(provider, options = {}) {
      return register(() => {
        permit('register.provider');
        const unregister = ctx.mediaProviderRegistry.register(owned.media(provider), options);
        ctx.cleanup.push(unregister);
        logger.info(`[plugin:${ctx.pluginName}] Registered media provider '${provider.id}'`);
      });
    },

    registerWebSearchProvider(provider, options = {}) {
      return register(() => {
        permit('register.provider');
        const unregister = ctx.webSearchProviderRegistry.register(owned.search(provider), options);
        ctx.cleanup.push(unregister);
        logger.info(`[plugin:${ctx.pluginName}] Registered web search provider '${provider.id}'`);
      });
    },

    onEvent(eventName, handler) {
      return register(() => {
        permit('register.hook', { kind: 'hook', names: [eventName] });
        const unsub = ctx.runtimeBus.on(
          eventName,
          (envelope) => {
            // An event reaching a quiescing plugin is not delivered: the instance
            // it would run on is about to be unloaded.
            if (tracker?.isQuiescing(ctx.pluginName) || ctx.registrations?.isClosed(ctx.pluginName)) return;
            // A failing hook is logged, never thrown into the bus: other subscribers still run.
            const failed = (error: unknown): void => {
              logger.warn(`[plugin:${ctx.pluginName}] event hook ${String(eventName)} failed: ${summarizeError(error)}`);
            };
            let result: unknown;
            try {
              result = track(() => handler(envelope.payload as RuntimeEventPayload<typeof eventName>));
            } catch (error) {
              failed(error);
              return;
            }
            if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
              (result as PromiseLike<unknown>).then(undefined, failed);
            }
          },
        );
        ctx.cleanup.push(unsub);
        return unsub;
      });
    },

    getConfig(key) {
      return ctx.pluginConfig[key];
    },

    log(level, message) {
      logger[level](`[plugin:${ctx.pluginName}] ${message}`);
    },
  };
}
