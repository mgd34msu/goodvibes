import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { ChannelDeliveryRequest, ChannelDeliveryRouter } from '@goodvibes-jev/engine/platform/platform/channels';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools/input-projection';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { agentArtifactEffectGuard, captureAgentArtifactSource } from './artifact-effect.js';
import { evaluateOutwardEffect, getProcessUntrustedContentLedger as getSessionUntrustedContentLedger } from '@goodvibes-jev/engine/platform/platform/security';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryResult,
  requireOneDeliveryTarget,
  type AgentChannelDeliveryInput,
} from './channel-delivery.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import { toolErrorText } from './tool-error-text.js';

export interface AgentReviewPacketShareToolArgs {
  readonly archiveArtifactId?: unknown | undefined;
  readonly message?: unknown | undefined;
  readonly title?: unknown | undefined;
  readonly channel?: unknown | undefined;
  readonly route?: unknown | undefined;
  readonly webhook?: unknown | undefined;
  readonly link?: unknown | undefined;
  readonly confirm?: unknown | undefined;
  readonly explicitUserRequest?: unknown | undefined;
}

type AgentReviewPacketShareArtifactStore = Pick<ArtifactStore, 'get' | 'list' | 'readContent'>;
type AgentReviewPacketShareChannelRouter = Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies' | 'strategyFor'>;
type AgentReviewPacketShareArtifact = ArtifactDescriptor | ArtifactRecord;

interface ReviewPacketArchiveSummary {
  readonly artifactId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly comparisonId: string;
  readonly handoffArtifactId: string;
  readonly handoffId: string;
  readonly sourceArtifactId: string;
  readonly sourceKind: string;
  readonly relatedArtifactIds: readonly string[];
  readonly routeDecisionArtifactIds: readonly string[];
  readonly includedArtifactIds: readonly string[];
  readonly artifactCount: number;
  readonly archiveBytes: number;
  readonly revealIncludedInHandoff: boolean;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}


function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
  }
  const scalar = readString(value);
  if (!scalar) return [];
  return scalar.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

async function loadArchiveArtifact(
  artifactStore: AgentReviewPacketShareArtifactStore | undefined,
  artifactId: string,
): Promise<AgentReviewPacketShareArtifact> {
  if (!artifactStore?.get && !artifactStore?.list && !artifactStore?.readContent) {
    throw new Error('Review packet share is unavailable because this runtime cannot inspect artifacts.');
  }
  const direct = artifactStore.get?.(artifactId);
  if (direct) return direct;
  const listed = artifactStore.list?.(200).find((artifact) => artifact.id === artifactId);
  if (listed) return listed;
  if (artifactStore.readContent) return (await artifactStore.readContent(artifactId)).record;
  throw new Error(`Unknown review packet archive artifact: ${artifactId}`);
}

function summarizeArchiveArtifact(artifact: AgentReviewPacketShareArtifact): ReviewPacketArchiveSummary {
  const metadata = artifact.metadata ?? {};
  const purpose = readString(metadata.purpose);
  if (purpose !== 'agent-model-compare-handoff-archive') {
    throw new Error('Review packet share requires a saved reviewer handoff archive artifact.');
  }
  const comparisonId = readString(metadata.comparisonId);
  const handoffArtifactId = readString(metadata.handoffArtifactId);
  const sourceArtifactId = readString(metadata.sourceArtifactId);
  if (!comparisonId || !handoffArtifactId || !sourceArtifactId) {
    throw new Error('Review packet archive metadata is missing comparison, handoff, or source ids.');
  }
  return {
    artifactId: artifact.id,
    filename: artifact.filename ?? `${artifact.id}.zip`,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    comparisonId,
    handoffArtifactId,
    handoffId: readString(metadata.handoffId) ?? '(unknown)',
    sourceArtifactId,
    sourceKind: readString(metadata.sourceKind) ?? 'unknown',
    relatedArtifactIds: readStringArray(metadata.relatedArtifactIds),
    routeDecisionArtifactIds: readStringArray(metadata.routeDecisionArtifactIds),
    includedArtifactIds: readStringArray(metadata.includedArtifactIds),
    artifactCount: readNumber(metadata.artifactCount) ?? readStringArray(metadata.includedArtifactIds).length,
    archiveBytes: readNumber(metadata.archiveBytes) ?? artifact.sizeBytes,
    revealIncludedInHandoff: metadata.revealIncludedInHandoff === true,
  };
}

function formatIdList(ids: readonly string[], max = 6): string {
  if (ids.length === 0) return '(none)';
  const visible = ids.slice(0, max).join(', ');
  return ids.length > max ? `${visible}, +${ids.length - max} more` : visible;
}

function archiveExportRoute(summary: ReviewPacketArchiveSummary): string {
  return `agent_artifacts mode:"export" artifactId:"${summary.artifactId}" destinationPath:"exports/${summary.filename}"`;
}

function buildPacketEvidenceLines(summary: ReviewPacketArchiveSummary): readonly string[] {
  return [
    `Archive: ${summary.artifactId} (${summary.filename}, ${summary.archiveBytes} bytes)`,
    `Comparison: ${summary.comparisonId}`,
    `Handoff: ${summary.handoffArtifactId} (${summary.handoffId})`,
    `Source: ${summary.sourceArtifactId} (${summary.sourceKind})`,
    `Included artifacts: ${summary.artifactCount} (${formatIdList(summary.includedArtifactIds)})`,
    `Related artifacts: ${formatIdList(summary.relatedArtifactIds)}`,
    `Route-decision receipts: ${formatIdList(summary.routeDecisionArtifactIds)}`,
    `Reveal: ${summary.revealIncludedInHandoff ? 'included in handoff when available' : 'not included in handoff'}`,
  ];
}

function buildShareMessage(summary: ReviewPacketArchiveSummary, customMessage: string | undefined, attached: boolean): string {
  return [
    customMessage ?? 'GoodVibes Agent reviewer packet is ready.',
    '',
    'Reviewer packet evidence:',
    ...buildPacketEvidenceLines(summary),
    attached ? `Archive file: ${summary.filename} is attached.` : `Archive file: ${summary.filename} follows separately.`,
  ].join('\n');
}

function formatShareResult(input: {
  readonly summary: ReviewPacketArchiveSummary;
  readonly delivery: Awaited<ReturnType<typeof deliverAgentChannelMessage>>;
  readonly attached: boolean;
}): string {
  return [
    input.attached ? 'Agent review packet shared, archive attached' : 'Agent review packet shared as a message; the archive file was not attached',
    `archive ${input.summary.artifactId} ${input.summary.filename}`,
    `comparison ${input.summary.comparisonId}`,
    `included artifacts ${input.summary.artifactCount}`,
    '',
    formatAgentChannelDeliveryResult(input.delivery),
    input.attached
      ? 'archive attached: the surface sent the ZIP with the message, as the file or, where it carries text only, as a named download link'
      : `archive not attached: the surface that took this target does not carry attachments. The message names the archive; export it with ${archiveExportRoute(input.summary)} and send exports/${input.summary.filename} to the reviewer yourself.`,
  ].join('\n');
}

/**
 * Which surface takes the target, as the router will send it (a bound route
 * resolved to its surface): none, one that carries attachments, or one that
 * does not. The strategy declares supportsAttachments; nothing is read from the network.
 */
function targetSurface(router: AgentReviewPacketShareChannelRouter, input: AgentChannelDeliveryInput): 'none' | 'files' | 'text' {
  const request = buildAgentChannelDeliveryPreview(input).request as unknown as ChannelDeliveryRequest;
  const strategy = router.strategyFor(request);
  if (!strategy) return 'none';
  return strategy.supportsAttachments === true ? 'files' : 'text';
}

export function createAgentReviewPacketShareTool(
  artifactStore: AgentReviewPacketShareArtifactStore | undefined,
  channelDeliveryRouter: AgentReviewPacketShareChannelRouter,
): Tool {
  return {
    definition: {
      name: 'agent_review_packet_share',
      activity: { doing: 'Sharing', did: 'shared', object: 'a review packet', objects: 'review packets' },
      description: 'Share one reviewer archive after recorded effect admission: attached where the surface carries attachments, otherwise named in the message. Exactly one of channel, route or webhook is required.',
      parameters: {
        type: 'object',
        properties: {
          archiveArtifactId: {
            type: 'string',
            description: 'Saved handoff archive artifact id.',
          },
          message: {
            type: 'string',
            description: 'Optional note prepended to packet evidence.',
          },
          title: {
            type: 'string',
            description: 'Optional delivery title.',
          },
          channel: {
            type: 'string',
            description: 'Delivery target: a configured surface kind, or kind:<conversation id>. Give exactly one of channel, route or webhook.',
          },
          route: {
            type: 'string',
            description: 'Delivery target: the id of a bound route (optionally "<route id> | <label>"); it is sent on that route\'s surface. Give exactly one of channel, route or webhook.',
          },
          webhook: {
            type: 'string',
            description: 'Delivery target: http(s) webhook URL. Give exactly one of channel, route or webhook.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        required: ['archiveArtifactId'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
      // A webhook URL is chosen in the call: one the owner has not configured or allowed is his to decide.
      subjects: { recipients: ['webhook'] },
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions) => {
      const args = rawArgs;
      const effect = agentArtifactEffectGuard(rawArgs, executionOptions, 'send');
      try { effect(); } catch (error) { return failure(toolErrorText(error)); }
      const artifactId = readString(args.archiveArtifactId);
      if (!artifactId) return failure('archiveArtifactId is required.');
      // Checked before the outward-effect decision, which would otherwise rule on an empty target and mask this cause.
      try {
        requireOneDeliveryTarget({ channel: readString(args.channel), route: readString(args.route), webhook: readString(args.webhook), link: readString(args.link) });
      } catch (error) { return failure(toolErrorText(error)); }
      let summary: ReviewPacketArchiveSummary;
      let assertSource: () => void;
      try {
        const archive = await loadArchiveArtifact(artifactStore, artifactId);
        effect();
        assertSource = captureAgentArtifactSource(artifactStore ?? {}, archive);
        assertSource();
        summary = summarizeArchiveArtifact(archive);
      } catch (error) {
        return failure(toolErrorText(error));
      }
      const title = readString(args.title) ?? 'GoodVibes Agent review packet';
      // The target alone, to ask which strategy takes it; the message is filled in below.
      const target: AgentChannelDeliveryInput = {
        message: 'review packet',
        ...(readString(args.channel) ? { channel: readString(args.channel) } : {}),
        ...(readString(args.route) ? { route: readString(args.route) } : {}),
        ...(readString(args.webhook) ? { webhook: readString(args.webhook) } : {}),
        // Refused by the delivery parse with the targets that work.
        ...(readString(args.link) ? { link: readString(args.link) } : {}),
      };
      let surface: 'none' | 'files' | 'text';
      try { surface = targetSurface(channelDeliveryRouter, target); }
      catch (error) { return failure(`${error instanceof Error ? error.message : String(error)} Nothing was sent.`); }
      // Found here, before the outward-effect decision, rather than as a delivery error after it.
      if (surface === 'none') {
        const route = readString(args.route);
        return failure(route
          ? `Route "${route}" is not a route bound here, so nothing was sent. Use the id of a bound route, a configured channel (kind or kind:<conversation id>) or an http(s) webhook URL.`
          : 'No delivery surface in this Agent takes that target, so nothing was sent. Use a configured channel (kind or kind:<conversation id>), the id of a bound route or an http(s) webhook URL.');
      }
      const attached = surface === 'files';
      const message = buildShareMessage(summary, readString(args.message), attached);
      // Set just before the delivery call: a throw after that point cannot say the message was not sent.
      let deliveryStarted = false;
      try {
        const ledger = getSessionUntrustedContentLedger();
        const ledgerSnapshot = () => JSON.stringify([ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]);
        const sources = ledgerSnapshot();
        const deliver = channelDeliveryRouter.deliver, listStrategies = channelDeliveryRouter.listStrategies;
        const strategies = listStrategies.call(channelDeliveryRouter).map(strategy => ({ strategy, canHandle: strategy.canHandle, deliver: strategy.deliver }));
        const assertCurrent = () => {
          effect(); assertSource();
          const current = listStrategies.call(channelDeliveryRouter);
          if (channelDeliveryRouter.deliver !== deliver || channelDeliveryRouter.listStrategies !== listStrategies
            || getSessionUntrustedContentLedger() !== ledger || ledgerSnapshot() !== sources
            || current.length !== strategies.length || strategies.some((source, index) => current[index] !== source.strategy
              || source.strategy.canHandle !== source.canHandle || source.strategy.deliver !== source.deliver)) throw new ToolInputProjectionError('stale');
        };
        assertCurrent();
        const decision = await evaluateOutwardEffect({
          request: { toolName: 'agent_review_packet_share', action: 'review-packet.share', description: 'sharing the saved reviewer archive reference' },
          ledger,
          content: { message, title, channel: readString(args.channel), route: readString(args.route), webhook: readString(args.webhook) },
          taintOptions: { signal: executionOptions?.signal, exactMatchFields: ['channel', 'route', 'webhook'] },
        });
        assertCurrent();
        if (!decision.allowed) return failure([decision.reason ?? 'Outward effect held.', decision.fix].filter(Boolean).join(' '));
        deliveryStarted = true;
        // The archive goes as an attachment only where the surface carries files; the same decision above covers it.
        const input: AgentChannelDeliveryInput = {
          ...target, message, title,
          ...(attached ? { attachments: [{ artifactId: summary.artifactId, label: summary.filename }] } : {}),
        };
        const delivery = await deliverAgentChannelMessage(channelDeliveryRouter, input, {
          ...(executionOptions?.signal ? { signal: executionOptions.signal } : {}),
          assertCurrent,
        });
        // Once the delivery has returned, the result is the delivery.
        return output(formatShareResult({ summary, delivery, attached }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (deliveryStarted) {
          return failure(`Review packet share outcome unknown: the delivery was started and then failed (${message}). The message may have been delivered; check the destination before sharing again.`);
        }
        return failure(message);
      }
    },
  };
}

export function registerAgentReviewPacketShareTool(
  registry: ToolRegistry,
  artifactStore: AgentReviewPacketShareArtifactStore | undefined,
  channelDeliveryRouter: AgentReviewPacketShareChannelRouter,
): void {
  registry.register(createAgentReviewPacketShareTool(artifactStore, channelDeliveryRouter));
}
