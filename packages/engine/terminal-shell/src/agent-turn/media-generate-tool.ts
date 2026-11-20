import type { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { MediaProviderRegistry } from '@goodvibes-jev/engine/platform/platform/media';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolEffect, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { snapshotJudgmentInput, captureStrictJudgmentJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { evaluateOutwardEffect, getProcessUntrustedContentLedger as getSessionUntrustedContentLedger } from '@goodvibes-jev/engine/platform/platform/security';
import { CardMaterialRefusedError, screenOutboundForCardMaterial } from './payments-channel-guard.js';
import { collectMedia, generateMedia, type MediaGenerationRun, type MediaOrigin } from '../media-generation.js';
import type { MediaProviderTask } from '@goodvibes-jev/engine/platform/platform/media';
import { confirmParameter, requestParameter } from './effect-admission.js';
import { toolErrorText } from './tool-error-text.js';
import { readFlag, readString } from './tool-args.js';

/** The model's media tool runs in the Agent. */
const TOOL_ORIGIN: MediaOrigin = { product: 'goodvibes-agent', source: 'agent-media-generation' };

/** The `agent_media_generate` call that collects a pending job. */
function mediaCollectToolCall(task: MediaProviderTask): string {
  const resume = task.resume && Object.keys(task.resume).length > 0 ? { resume: task.resume } : {};
  return `agent_media_generate ${JSON.stringify({ providerId: task.providerId, taskId: task.taskId, ...resume })}`;
}

/**
 * The result as text. A pending job names the step that collects it on the
 * surface printing it: the tool call by default, the slash command for `/media`.
 */
function formatAgentMediaGenerationResult(
  result: MediaGenerationRun,
  collectStep: (task: MediaProviderTask) => string = mediaCollectToolCall,
): string {
  if (result.pending) {
    return [
      'Agent media still generating',
      `  provider ${result.pending.providerId}`,
      `  task ${result.pending.taskId}`,
      '  the provider accepted (and charged for) the job; it had not finished when the wait ended',
      `  collect it later with ${collectStep(result.pending)}`,
    ].join('\n');
  }
  return [
    'Agent media generated',
    `  provider ${result.providerId}`,
    `  artifacts ${result.artifacts.length}`,
    ...result.artifacts.map((artifact, index) => [
      `  ${index + 1}. ${artifact.artifactId}`,
      `     type ${artifact.mimeType}`,
      `     size ${artifact.sizeBytes} bytes`,
      ...(artifact.filename ? [`     filename ${artifact.filename}`] : []),
      ...(artifact.sourceUri ? [`     source ${artifact.sourceUri}`] : []),
    ].join('\n')),
  ].join('\n');
}

export interface AgentMediaGenerateToolArgs {
  readonly prompt?: unknown | undefined;
  readonly providerId?: unknown | undefined;
  readonly modelId?: unknown | undefined;
  readonly outputMimeType?: unknown | undefined;
  readonly taskId?: unknown | undefined;
  readonly resume?: unknown | undefined;
  readonly waitSeconds?: unknown | undefined;
  readonly confirm?: unknown | undefined;
  readonly explicitUserRequest?: unknown | undefined;
  readonly preview?: unknown | undefined;
}

/** The provider's own handles for a pending job, as strings; null when the value is not that shape. */
function readResume(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entry]) => typeof entry !== 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function preview(args: AgentMediaGenerateToolArgs, providerCount: number): string {
  const prompt = readString(args.prompt);
  return [
    'Agent media generation preview',
    `  prompt ${prompt || '(missing)'}`,
    `  provider ${readString(args.providerId) || '(auto)'}`,
    `  model ${readString(args.modelId) || '(provider default)'}`,
    `  output mime ${readString(args.outputMimeType) || '(provider default)'}`,
    `  generation providers ${providerCount}`,
    '  policy media generation requires current recorded effect admission',
  ].join('\n');
}

export function createAgentMediaGenerateTool(
  mediaProviderRegistry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
): Tool {
  return {
    definition: {
      name: 'agent_media_generate',
      activity: { doing: 'Generating', did: 'generated', object: 'media' },
      description: 'Preview or generate one image or video artifact through current recorded effect admission, or collect a job an earlier call left pending (taskId with its providerId and resume).',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Media generation prompt.',
          },
          providerId: {
            type: 'string',
            description: 'Optional media provider id.',
          },
          modelId: {
            type: 'string',
            description: 'Optional provider-specific media model id.',
          },
          outputMimeType: {
            type: 'string',
            description: 'Optional requested output MIME type, such as image/png or video/mp4.',
          },
          taskId: {
            type: 'string',
            description: 'Collect instead of generating: the task id a pending result named (with its providerId and resume). Nothing new is paid for.',
          },
          resume: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'With taskId: the resume values the pending result named, exactly as given.',
          },
          waitSeconds: {
            type: 'number',
            description: 'With taskId: how long to wait for the job before answering pending again; 0 checks once.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
          preview: { type: 'boolean', description: 'Return a read-only preview without generation.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, executionOptions) => {
      const args = captureStrictJudgmentJson(rawArgs); snapshotJudgmentInput(args);
      const prompt = readString(args.prompt);
      const generationProviderCount = mediaProviderRegistry.list()
        .filter((provider) => provider.capabilities.includes('generate')).length;
      const taskId = readString(args.taskId);
      if (taskId) {
        const providerId = readString(args.providerId);
        if (!providerId) return failure('providerId is required with taskId: the provider the pending result named.');
        const resume = readResume(args.resume);
        if (!resume) return failure('resume must be an object of strings, exactly as the pending result gave it.');
        if (args.waitSeconds !== undefined && (typeof args.waitSeconds !== 'number' || !Number.isFinite(args.waitSeconds) || args.waitSeconds < 0)) {
          return failure('waitSeconds must be a number of seconds, 0 or more.');
        }
        if (readFlag(args.preview, 'preview', false)) return output(`Agent media collection preview\n  provider ${providerId}\n  task ${taskId}\n  nothing new is paid for`);
        try {
          const assertCurrent = () => {
            executionOptions?.signal?.throwIfAborted();
            if (!assertCurrentToolEffect(rawArgs, executionOptions, 'send') || !assertCurrentToolEffect(rawArgs, executionOptions, 'write')) throw new ToolInputProjectionError('held');
          };
          assertCurrent();
          const result = await collectMedia(mediaProviderRegistry, artifactStore,
            { providerId, taskId, ...(Object.keys(resume).length > 0 ? { resume } : {}) }, TOOL_ORIGIN,
            typeof args.waitSeconds === 'number' ? { waitSeconds: args.waitSeconds } : {},
            { signal: executionOptions?.signal, assertCurrent });
          return output(formatAgentMediaGenerationResult(result));
        } catch (error) {
          return failure(toolErrorText(error, executionOptions?.signal));
        }
      }
      if (!prompt) return failure('prompt is required (or taskId to collect a pending job).');
      if (readFlag(args.preview, 'preview', false)) return output(preview(args, generationProviderCount));
      try {
        const ledger = getSessionUntrustedContentLedger();
        const ledgerCurrent = () => JSON.stringify([ledger.getPublicationRevision(), ledger.taintOriginsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]);
        const sources = ledgerCurrent();
        const assertCurrent = () => {
          executionOptions?.signal?.throwIfAborted();
          if (!assertCurrentToolEffect(rawArgs, executionOptions, 'send') || !assertCurrentToolEffect(rawArgs, executionOptions, 'write')) throw new ToolInputProjectionError('held');
          if (getSessionUntrustedContentLedger() !== ledger || ledgerCurrent() !== sources) throw new ToolInputProjectionError('stale');
        };
        assertCurrent();
        const outward = await evaluateOutwardEffect({ request: { toolName: 'agent_media_generate', action: 'media.generate', description: 'sending the media generation prompt' },
          ledger, content: { prompt }, taintOptions: { signal: executionOptions?.signal } });
        assertCurrent(); if (!outward.allowed) return failure([outward.reason ?? 'Media prompt content was refused.', outward.fix].filter(Boolean).join(' '));
        const card = await screenOutboundForCardMaterial({ surface: 'media-provider', message: prompt }, { signal: executionOptions?.signal, assertCurrent });
        assertCurrent(); if (card) throw new CardMaterialRefusedError(card);
        const result = await generateMedia(mediaProviderRegistry, artifactStore, {
          prompt,
          ...(readString(args.providerId) ? { providerId: readString(args.providerId) } : {}),
          ...(readString(args.modelId) ? { modelId: readString(args.modelId) } : {}),
          ...(readString(args.outputMimeType) ? { outputMimeType: readString(args.outputMimeType) } : {}),
        }, TOOL_ORIGIN, { signal: executionOptions?.signal, assertCurrent });
        return output(formatAgentMediaGenerationResult(result));
      } catch (error) {
        return failure(toolErrorText(error, executionOptions?.signal));
      }
    },
  };
}

export function registerAgentMediaGenerateTool(
  registry: ToolRegistry,
  mediaProviderRegistry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
): void {
  registry.register(createAgentMediaGenerateTool(mediaProviderRegistry, artifactStore));
}
