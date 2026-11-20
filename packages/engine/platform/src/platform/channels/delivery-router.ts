import { assertDeliveryCurrent } from '../utils/delivery-lifetime.js';
import { ArtifactStore } from '../artifacts/index.js';
import { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { ServiceRegistry } from '../config/service-registry.js';
import type { ControlPlaneGateway } from '../control-plane/gateway.js';
import {
  createDiscordDeliveryStrategy,
  createGoogleChatDeliveryStrategy,
  createHomeAssistantDeliveryStrategy,
  createNtfyDeliveryStrategy,
  createSlackDeliveryStrategy,
  createTelegramDeliveryStrategy,
  createLinkDeliveryStrategy,
  createWebControlPlaneDeliveryStrategy,
  createWebhookDeliveryStrategy,
} from './delivery/strategies-core.js';
import {
  createBlueBubblesDeliveryStrategy,
  createIMessageDeliveryStrategy,
  createSignalDeliveryStrategy,
  createTelephonyDeliveryStrategy,
  createWhatsAppDeliveryStrategy,
} from './delivery/strategies-bridge.js';
import {
  createMSTeamsDeliveryStrategy,
  createMattermostDeliveryStrategy,
  createMatrixDeliveryStrategy,
} from './delivery/strategies-enterprise.js';
import { resolveChannelDeliverySurfaceKind, resolveRouteBindingTarget, splitForSurface, SURFACE_TEXT_LIMITS } from './delivery/shared.js';
import { channelCredentials } from './credential-holder.js';
import { logger } from '../utils/logger.js';
import { PRIVATE_DELIVERY_HOSTS_SETTING, parseApprovedHosts } from '../runtime/network/destination.js';
import { describeStructuralDeliveryError } from '../integrations/delivery-diagnostics.js';
import { CHANNEL_DELIVERY_SURFACE_KINDS } from './delivery/types.js';
import type {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  ChannelDeliveryRouteLookup,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
} from './delivery/types.js';

export type {
  ChannelDeliveryReceipt,
  ChannelDeliveryResult,
  ChannelDeliveryRouteBinding,
  ChannelDeliveryRouteLookup,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
  ChannelDeliveryTargetKind,
} from './delivery/types.js';
export { CHANNEL_DELIVERY_SURFACE_KINDS };

/** The most messages one delivery is split into; past that the surface cuts the last part and says so. */
const MAX_DELIVERY_PARTS = 10;
/** Room left in each part for the attachment lines the first part carries. */
const PART_RESERVE_CHARS = 64;
const PART_RESERVE_PER_ATTACHMENT = 400;

const DIAGNOSTIC_STRATEGIES = new Set<string>(CHANNEL_DELIVERY_SURFACE_KINDS.map((surface) => `channel-delivery:${surface}`));
const DIAGNOSTIC_TARGET_KINDS = new Set(['none', 'webhook', 'surface', 'integration', 'link']);

function diagnosticSurface(value: unknown): string {
  return CHANNEL_DELIVERY_SURFACE_KINDS.some((surface) => surface === value) ? value as string : 'unknown';
}
function diagnosticStrategy(strategy: ChannelDeliveryStrategy): string {
  try { const id = strategy.id; return DIAGNOSTIC_STRATEGIES.has(id) ? id : 'custom'; }
  catch { return 'custom'; }
}
function diagnosticTarget(request: ChannelDeliveryRequest): string {
  try { const kind = request.target.kind; return DIAGNOSTIC_TARGET_KINDS.has(kind) ? kind : 'unknown'; }
  catch { return 'unknown'; }
}
function publishDiagnostic(message: string, fields: Record<string, unknown>): void {
  try { logger.error(message, fields); }
  catch { /* Preserve the delivery's original outcome and retry evidence. */ }
}

export { resolveChannelDeliverySurfaceKind } from './delivery/shared.js';

/**
 * `secretsManager` is REQUIRED, not optional, and that is the whole point.
 *
 * Half the surfaces here read their credential from a `goodvibes://secrets/...`
 * reference, which only resolves when a local secret resolver is supplied.
 * While this parameter was optional, a composition root that forgot it still
 * type-checked, still constructed, still delivered on every surface whose
 * credential happens to live in config or the environment, and failed ONLY on
 * the surfaces that use a secret reference, at send time, as
 * "Missing Telegram bot token". Two shipped composition roots (goodvibes-tui
 * and goodvibes-agent) drifted into exactly that state while the platform's own
 * composition passed it, so the defect was invisible from inside the platform and
 * its tests. Required here means a fork that forgets fails to compile instead
 * of failing to answer someone.
 */
export function createDefaultChannelDeliveryStrategies(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  getControlPlaneGateway: () => ControlPlaneGateway | null,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy[] {
  return [
    // The owner's own targets may name a host he approved on his network (`network.privateDeliveryHosts`).
    createWebhookDeliveryStrategy(configManager, artifactStore, secretsManager, {
      privateDeliveryHosts: () => parseApprovedHosts(configManager.get(PRIVATE_DELIVERY_HOSTS_SETTING)),
    }),
    createSlackDeliveryStrategy(serviceRegistry, configManager, artifactStore, secretsManager),
    createDiscordDeliveryStrategy(serviceRegistry, configManager, artifactStore, secretsManager),
    createNtfyDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createWebControlPlaneDeliveryStrategy(configManager, artifactStore, getControlPlaneGateway),
    createLinkDeliveryStrategy(configManager, artifactStore, getControlPlaneGateway),
    createHomeAssistantDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createTelegramDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createGoogleChatDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createSignalDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createWhatsAppDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createTelephonyDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createIMessageDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createMSTeamsDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createBlueBubblesDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createMattermostDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
    createMatrixDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager),
  ];
}

export class ChannelDeliveryRouter {
  private readonly strategies: ChannelDeliveryStrategy[];
  /** A removed registration cannot be revived by re-adding the same strategy object. */
  private readonly strategyRegistrations = new WeakMap<ChannelDeliveryStrategy, { readonly guarded: boolean; readonly publication: boolean }>();
  private controlPlaneGateway: ControlPlaneGateway | null;
  private readonly routeBindings: ChannelDeliveryRouteLookup | undefined;

  constructor(config: ChannelDeliveryRouterConfig = {}) {
    this.controlPlaneGateway = config.controlPlaneGateway ?? null;
    this.routeBindings = config.routeBindings;
    if (config.strategies) {
      this.strategies = [...config.strategies];
      for (const strategy of this.strategies) this.strategyRegistrations.set(strategy, this.captureRegistration(strategy));
      return;
    }
    if (!config.configManager || !config.serviceRegistry || !config.artifactStore || !config.secretsManager) {
      throw new Error(
        'ChannelDeliveryRouter requires configManager, serviceRegistry, artifactStore, and secretsManager '
        + 'when using builtin delivery strategies. Without secretsManager every surface whose credential is a '
        + 'goodvibes://secrets/... reference silently fails to send.',
      );
    }
    this.strategies = createDefaultChannelDeliveryStrategies(
      config.configManager,
      config.serviceRegistry,
      config.artifactStore,
      () => this.controlPlaneGateway,
      config.secretsManager,
    );
    for (const strategy of this.strategies) this.strategyRegistrations.set(strategy, this.captureRegistration(strategy));
  }

  setControlPlaneGateway(gateway: ControlPlaneGateway | null): void {
    this.controlPlaneGateway = gateway;
  }

  listStrategies(): readonly ChannelDeliveryStrategy[] {
    return [...this.strategies];
  }

  registerStrategy(strategy: ChannelDeliveryStrategy, options: { readonly replace?: boolean } = {}): void {
    const existingIndex = this.strategies.findIndex((entry) => entry.id === strategy.id);
    if (existingIndex >= 0) {
      if (!options.replace) {
        throw new Error(`Channel delivery strategy already registered: ${strategy.id}`);
      }
      this.strategyRegistrations.delete(this.strategies[existingIndex]!);
      this.strategies.splice(existingIndex, 1, strategy);
      this.strategyRegistrations.set(strategy, this.captureRegistration(strategy));
      return;
    }
    this.strategies.push(strategy);
    this.strategyRegistrations.set(strategy, this.captureRegistration(strategy));
  }

  unregisterStrategy(strategyId: string): boolean {
    const existingIndex = this.strategies.findIndex((entry) => entry.id === strategyId);
    if (existingIndex < 0) return false;
    this.strategyRegistrations.delete(this.strategies[existingIndex]!);
    this.strategies.splice(existingIndex, 1);
    return true;
  }

  private captureRegistration(strategy: ChannelDeliveryStrategy): { readonly guarded: boolean; readonly publication: boolean } {
    const descriptor = Object.getOwnPropertyDescriptor(strategy, 'supportsGuardedDelivery');
    const publication = Object.getOwnPropertyDescriptor(strategy, 'supportsPublication');
    return Object.freeze({ guarded: descriptor !== undefined && 'value' in descriptor && descriptor.value === true,
      publication: publication !== undefined && 'value' in publication && publication.value === true });
  }

  async deliver(request: ChannelDeliveryRequest): Promise<string | undefined> {
    return (await this.deliverWithReceipt(request)).responseId;
  }

  /**
   * The request as it is sent: a target that names a bound route, and carries
   * no binding yet, takes that route's surface, address and binding.
   */
  resolveRequest(request: ChannelDeliveryRequest): ChannelDeliveryRequest {
    const routeId = request.target.routeId;
    if (request.binding || !routeId || !this.routeBindings) return request;
    const binding = this.routeBindings.getBinding(routeId);
    if (!binding) return request;
    return { ...request, target: resolveRouteBindingTarget(request.target, binding), binding };
  }

  /** The strategy that would send this request, or undefined when none takes it. Reads no network. */
  strategyFor(request: ChannelDeliveryRequest): ChannelDeliveryStrategy | undefined {
    const resolved = this.resolveRequest(request);
    return this.strategies.find((entry) => entry.canHandle(resolved));
  }

  /** Same dispatch and lifetime checks as deliver(), retaining actual native
   * acknowledgement metadata for callers that need durable correlation. */
  async deliverWithReceipt(input: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    const request = this.resolveRequest(input);
    const surfaceKind = resolveChannelDeliverySurfaceKind(request.target);
    const strategy = this.strategies.find((entry) => entry.canHandle(request));
    if (!strategy) {
      // Silence is the worst failure mode a reply can have: the owner sends a
      // message, the agent answers, and nothing arrives with no trace anywhere.
      // Publish only closed routing facts; destination capabilities stay private.
      publishDiagnostic('Channel delivery could not resolve a strategy, the reply was dropped', {
        surface: diagnosticSurface(surfaceKind),
        targetKind: diagnosticTarget(request),
        reason: 'no-strategy-handles-this-target',
      });
      throw new Error('Unsupported channel delivery target');
    }
    try {
      const guarded = request.signal !== undefined || request.assertCurrent !== undefined || request.withPublication !== undefined;
      const registration = this.strategyRegistrations.get(strategy);
      if (guarded && registration?.guarded !== true) {
        throw new Error('Channel delivery strategy does not support guarded delivery');
      }
      if (request.withPublication !== undefined && registration?.publication !== true) {
        throw new Error('Channel delivery strategy does not support publication');
      }
      const deliveryRequest = guarded ? {
        ...request,
        assertCurrent: () => {
          assertDeliveryCurrent(request);
          if (registration === undefined || this.strategyRegistrations.get(strategy) !== registration) {
            throw new Error('Channel delivery strategy registration is no longer current');
          }
        },
      } : request;
      assertDeliveryCurrent(deliveryRequest);
      const parts = this.partsFor(deliveryRequest, surfaceKind);
      const result = await strategy.deliver(parts.length > 1 ? { ...deliveryRequest, body: parts[0]! } : deliveryRequest);
      const receipt = result.receipt;
      const following = parts.length > 1
        ? await this.deliverFollowingParts(strategy, deliveryRequest, parts, surfaceKind)
        : { truncated: false, omittedChars: 0, sent: 1 };
      const outcome = {
        truncated: result.truncated === true || following.truncated,
        omittedChars: (result.omittedChars ?? 0) + following.omittedChars,
        sent: following.sent,
      };
      return Object.freeze({
        ...(result.responseId === undefined ? {} : { responseId: result.responseId }),
        ...(receipt === undefined ? {} : { receipt: Object.freeze({ surfaceKind: receipt.surfaceKind,
          conversationId: receipt.conversationId, messageId: receipt.messageId,
          ...(receipt.accountId === undefined ? {} : { accountId: receipt.accountId }),
          ...(receipt.threadId === undefined ? {} : { threadId: receipt.threadId }) }) }),
        ...(outcome.sent > 1 ? { parts: outcome.sent } : {}),
        ...(outcome.truncated ? { truncated: true, ...(outcome.omittedChars > 0 ? { omittedChars: outcome.omittedChars } : {}) } : {}),
        ...(result.suppressed === true ? { suppressed: true } : {}),
      });
    } catch (error) {
      // A refused credential is not served again: the next send resolves it afresh.
      channelCredentials.releaseOnRefusal(error);
      // The original failure remains private retry evidence. Published diagnostics
      // contain only closed routing facts and a validated HTTP status, if present.
      publishDiagnostic('Channel delivery failed, the reply did not reach its conversation', {
        surface: diagnosticSurface(surfaceKind),
        strategy: diagnosticStrategy(strategy),
        reason: describeStructuralDeliveryError(error),
      });
      throw error;
    }
  }

  /**
   * The messages a body goes out as. A body longer than one message on a
   * surface with a known limit is split so the recipient gets all of it; a
   * publication-wrapped delivery stays one message, because its publication
   * runs once around one dispatch.
   */
  private partsFor(request: ChannelDeliveryRequest, surfaceKind: string | undefined): readonly string[] {
    const limit = surfaceKind !== undefined && Object.hasOwn(SURFACE_TEXT_LIMITS, surfaceKind)
      ? SURFACE_TEXT_LIMITS[surfaceKind as keyof typeof SURFACE_TEXT_LIMITS]
      : undefined;
    if (limit === undefined || request.withPublication !== undefined) return [request.body];
    const budget = limit - PART_RESERVE_CHARS - PART_RESERVE_PER_ATTACHMENT * (request.attachments?.length ?? 0);
    if (budget <= 0 || request.body.length <= budget) return [request.body];
    return splitForSurface(request.body, budget, MAX_DELIVERY_PARTS);
  }

  /**
   * Send parts after the first, which carried the attachments. A part that
   * fails after the first went out does not fail the delivery (the recipient
   * already has the start, and a retry would repeat it); the result says how
   * much did not arrive instead.
   */
  private async deliverFollowingParts(
    strategy: ChannelDeliveryStrategy,
    request: ChannelDeliveryRequest,
    parts: readonly string[],
    surfaceKind: string | undefined,
  ): Promise<{ readonly truncated: boolean; readonly omittedChars: number; readonly sent: number }> {
    let sent = 1;
    for (let index = 1; index < parts.length; index += 1) {
      try {
        // Each part is its own announcement, so a surface that suppresses
        // repeats by identity does not take part two for part one.
        const result = await strategy.deliver({
          ...request,
          body: parts[index]!,
          attachments: undefined,
          ...(request.announces ? { announces: `${request.announces}:part${index + 1}` } : {}),
        });
        sent += 1;
        if (result.truncated) return { truncated: true, omittedChars: result.omittedChars ?? 0, sent };
      } catch (error) {
        channelCredentials.releaseOnRefusal(error);
        publishDiagnostic('Channel delivery sent only part of a long message', {
          surface: diagnosticSurface(surfaceKind),
          strategy: diagnosticStrategy(strategy),
          reason: describeStructuralDeliveryError(error),
          partsSent: sent,
          partsTotal: parts.length,
        });
        const omittedChars = parts.slice(index).reduce((total, part) => total + part.length, 0);
        return { truncated: true, omittedChars, sent };
      }
    }
    return { truncated: false, omittedChars: 0, sent };
  }
}
