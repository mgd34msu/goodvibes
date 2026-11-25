import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
import type { CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { browserDeviceCatalogMatches } from './agent-harness-browser-device-readings.ts';
import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { captureCatalogNativeFacts, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { buildAgentWorkspaceVoiceMediaReadiness } from '../input/agent-workspace-voice-media.ts';
import type { AgentWorkspaceVoiceMediaProviderStatus } from '../input/agent-workspace-voice-media.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from '@goodvibes/engine/terminal-shell/agent-turn/preview-text';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { resolveWakeRuntimeSettings } from '@goodvibes/engine/platform/platform/voice/wake/runtime';
import { agentWakeCapabilities } from '../core/wake-provision-status.ts';
import { clampReadLimit } from '@goodvibes/engine/terminal-shell/agent-turn/read-helpers';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';

export interface AgentHarnessMediaArgs {
  readonly mediaProviderId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type MediaProviderResolution =
  | { readonly status: 'found'; readonly provider: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type VoiceWorkflowStatus = 'ready' | 'attention' | 'setup-needed' | 'not-published';

interface RuntimeProviderStatus {
  readonly id: string;
  readonly state: string;
  readonly configured: boolean;
  readonly detail?: string;
}

interface VoiceInteractionWorkflow {
  readonly id: string;
  readonly label: string;
  readonly status: VoiceWorkflowStatus;
  readonly userOutcome: string;
  readonly summary: string;
  readonly nextStep: string;
  readonly capabilities: readonly string[];
  readonly modelRoute: string;
  readonly userRoute?: string;
  readonly setupRoutes: readonly string[];
  readonly evidence: Record<string, unknown>;
  readonly policy: string;
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function readConfigBoolean(context: CommandContext, key: string, fallback: boolean): boolean {
  try {
    const value = (context.platform.configManager as { get(settingKey: string): unknown }).get(key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return fallback;
  } catch (error) {
    logger.warn('Media posture setting could not be read; using its default', { key, error: summarizeError(error) });
    return fallback;
  }
}

function readConfigString(context: CommandContext, key: string): string {
  try {
    const value = (context.platform.configManager as { get(settingKey: string): unknown }).get(key);
    return typeof value === 'string' ? value.trim() : '';
  } catch (error) {
    logger.warn('Media posture setting could not be read', { key, error: summarizeError(error) });
    return '';
  }
}

function providerCatalogDescription(provider: AgentWorkspaceVoiceMediaProviderStatus): string {
  return [provider.label, provider.domain, provider.setupState, provider.nextStep, ...provider.features].join('\n');
}

function workflowCatalogDescription(workflow: VoiceInteractionWorkflow): string {
  return [workflow.label, workflow.userOutcome, workflow.summary, workflow.nextStep].join('\n');
}

function voiceWorkflowSummary(workflows: readonly VoiceInteractionWorkflow[]): Record<string, unknown> {
  return {
    total: workflows.length,
    ready: workflows.filter((workflow) => workflow.status === 'ready').length,
    attention: workflows.filter((workflow) => workflow.status === 'attention').length,
    setupNeeded: workflows.filter((workflow) => workflow.status === 'setup-needed').length,
    notPublished: workflows.filter((workflow) => workflow.status === 'not-published').length,
    primaryNextStep: workflows.find((workflow) => workflow.status !== 'ready')?.nextStep
      ?? 'Voice workflows are ready; keep effects on explicit user-visible routes.',
  };
}

function hasReadyVoiceFeature(readiness: ReturnType<typeof buildReadiness>, featureIds: readonly string[]): boolean {
  return readiness.voiceProviders.some((provider) => (
    provider.setupState === 'ready'
    && featureIds.some((feature) => provider.features.includes(feature))
  ));
}

function hasRegisteredVoiceFeature(readiness: ReturnType<typeof buildReadiness>, featureIds: readonly string[]): boolean {
  return readiness.voiceProviders.some((provider) => featureIds.some((feature) => provider.features.includes(feature)));
}

async function buildVoiceInteractionWorkflows(
  context: CommandContext,
  readiness: ReturnType<typeof buildReadiness>,
  options: CatalogRankingOptions,
): Promise<readonly VoiceInteractionWorkflow[]> {
  // The device capability catalog has no microphone, speaker or wake capability,
  // so a paired phone adds nothing to these rows; they read this host's voice runtime.
  options.signal?.throwIfAborted();
  // The one reader for every `voice.wake.*` row (platform settings.ts), so this posture
  // reports the same resolution the capture host itself consults, including which
  // rows refuse to start it, instead of re-deriving it from raw config reads.
  //
  // The speech gate's disk state comes from the same voiceSetup service /voice
  // wake-status reads. A context without that service (a fixture) resolves as gate-absent,
  // which is the truthful answer for it rather than an assumed capability.
  let vadReady = false;
  try {
    vadReady = context.platform.voiceSetup?.wakeStatus().vadReady ?? false;
  } catch {
    // A status read that fails is not evidence the gate is loaded.
  }
  const wake = resolveWakeRuntimeSettings(
    (key: string) => (context.platform.configManager as { get(settingKey: string): unknown }).get(key),
    'agent',
    agentWakeCapabilities({ vadReady }),
  );
  const voiceEnabled = readConfigBoolean(context, 'ui.voiceEnabled', false);
  const spokenTurnRuntime = typeof context.submitSpokenInput === 'function';
  const stopSpokenOutputRuntime = typeof context.stopSpokenOutput === 'function';
  const transcribeRuntime = typeof context.platform.voiceService?.transcribe === 'function';
  const speechInputReady = hasReadyVoiceFeature(readiness, ['stt', 'realtime']);
  const speechInputRegistered = hasRegisteredVoiceFeature(readiness, ['stt', 'realtime']);
  const selectedTtsReady = readiness.selectedTtsProviderStatus === 'ready';
  const spokenReady = spokenTurnRuntime && selectedTtsReady && readiness.ttsVoiceConfigured;
  // Two different gaps leave spoken output short of ready; each gets its own sentence and step.
  const ttsKeyInAgentOnly = readiness.selectedTtsProviderStatus === 'ready-agent-env';
  const ttsVoiceMissing = selectedTtsReady && !readiness.ttsVoiceConfigured;
  const spokenAttention = spokenTurnRuntime && (ttsKeyInAgentOnly || ttsVoiceMissing);
  const selectedTtsKeys = readiness.voiceProviders.find((provider) => provider.selected)?.configuredSecretKeys ?? [];
  const ttsKeyNames = selectedTtsKeys.length > 0 ? selectedTtsKeys.join(' or ') : 'its API key';
  const pushToTalkReady = voiceEnabled && spokenTurnRuntime && speechInputReady;
  const pushToTalkAttention = voiceEnabled && (spokenTurnRuntime || speechInputRegistered);
  const transcriptionReady = transcribeRuntime && speechInputReady;
  const transcriptionAttention = transcribeRuntime || speechInputRegistered;

  return [
    {
      id: 'push-to-talk',
      label: 'Push-to-talk input',
      status: pushToTalkReady ? 'ready' : pushToTalkAttention ? 'attention' : 'setup-needed',
      userOutcome: 'Speak a short prompt when the local voice surface and speech-input provider are ready.',
      summary: pushToTalkReady
        ? 'Voice surface, spoken-turn runtime, and a ready STT/realtime provider are available.'
        : pushToTalkAttention
          ? 'Some voice input pieces are present, but the full push-to-talk route is not ready.'
          : 'Voice input needs the voice surface plus a ready STT or realtime provider.',
      nextStep: pushToTalkReady
        ? 'Use the visible voice surface when the user asks to speak to the assistant.'
        : 'Review /voice and media provider posture before presenting push-to-talk as available.',
      capabilities: ['push-to-talk', 'speech input', 'stt', 'realtime voice'],
      modelRoute: 'agent_harness mode:"media_posture" query:"push to talk" includeParameters:true',
      userRoute: '/voice review',
      setupRoutes: [
        'settings action:"get" query:"ui.voiceEnabled" includeParameters:true',
        'agent_harness mode:"media_posture" query:"stt realtime" includeParameters:true',
      ],
      evidence: {
        voiceSurfaceEnabled: voiceEnabled,
        spokenTurnRuntime,
        speechInputReady,
        speechInputRegistered,
      },
      policy: 'Voice input stays a visible local operator surface; provider setup and transcript submission are separate explicit routes.',
    },
    {
      id: 'voice-memo-transcription',
      label: 'Voice memo transcription',
      status: transcriptionReady ? 'ready' : transcriptionAttention ? 'attention' : 'setup-needed',
      userOutcome: 'Transcribe an audio note only when a speech-to-text provider and runtime route are both present.',
      summary: transcriptionReady
        ? 'Speech-to-text provider and voiceService.transcribe are available.'
        : transcriptionAttention
          ? 'A speech-to-text provider or runtime route is present, but transcription is not fully ready.'
          : 'No ready speech-to-text transcription route is available.',
      nextStep: transcriptionReady
        ? 'Route audio transcription through reviewed media or connected-host voice routes when the user supplies audio.'
        : 'Configure a provider with STT capability and confirm the runtime exposes voiceService.transcribe.',
      capabilities: ['voice memo', 'speech-to-text', 'audio transcription'],
      modelRoute: 'agent_harness mode:"media_posture" query:"voice memo transcription" includeParameters:true',
      setupRoutes: [
        'agent_harness mode:"media_posture" query:"stt" includeParameters:true',
        'host action:"methods" query:"voice.stt"',
      ],
      evidence: {
        transcribeRuntime,
        speechInputReady,
        speechInputRegistered,
      },
      policy: 'Audio bytes are not printed into chat; transcription must use reviewed media or connected-host voice routes.',
    },
    {
      id: 'spoken-responses',
      label: 'Spoken responses',
      status: spokenReady ? 'ready' : spokenAttention ? 'attention' : 'setup-needed',
      userOutcome: 'Play an assistant answer aloud with a predictable TTS provider and voice.',
      summary: spokenReady
        ? 'Spoken-turn runtime, selected TTS provider, and voice setting are ready.'
        : spokenAttention && ttsKeyInAgentOnly
          ? `The selected TTS provider${readiness.selectedTtsProviderLabel ? ` (${readiness.selectedTtsProviderLabel})` : ''} has ${ttsKeyNames} only in this Agent's environment; the connected GoodVibes host reads its own environment and secret store, which are not visible from here, so spoken turns may not reach the provider.`
          : spokenAttention
            ? 'Spoken-turn runtime and provider are ready, but the exact voice is not configured.'
            : 'Spoken responses need a ready selected TTS provider and runtime spoken-turn route.',
      nextStep: spokenReady
        ? 'Use /voice speak only when the user asks for spoken output.'
        : spokenAttention && ttsKeyInAgentOnly
          ? `Tell the user the provider key must be stored where the host reads it: they type /secrets set ${selectedTtsKeys[0] ?? '<KEY>'} and enter the value (a credential is theirs to enter), which files it where the host reads it.`
          : spokenAttention
            ? 'When the user asks, open the tts-voice-picker surface (setupRoutes) so they can pick the voice.'
            : 'Choose a ready TTS provider and voice, then verify the runtime exposes submitSpokenInput.',
      capabilities: ['tts', 'spoken answer', 'stop spoken output'],
      modelRoute: 'agent_harness mode:"media_posture" query:"spoken responses" includeParameters:true',
      userRoute: '/voice speak <message>',
      setupRoutes: [
        'agent_harness mode:"open_ui_surface" surfaceId:"tts-provider-picker" explicitUserRequest:"<the user request, in their own words>"',
        'agent_harness mode:"open_ui_surface" surfaceId:"tts-voice-picker" explicitUserRequest:"<the user request, in their own words>"',
      ],
      evidence: {
        spokenTurnRuntime,
        stopSpokenOutputRuntime,
        selectedTtsProviderStatus: readiness.selectedTtsProviderStatus,
        ttsVoiceConfigured: readiness.ttsVoiceConfigured,
      },
      policy: 'Spoken turns submit normal assistant prompts and may call model/speech providers; playback stop is local runtime control.',
    },
    {
      id: 'wake-and-speak',
      label: 'Wake and speak',
      // Two different things wear this label, and only one of them is shipped.
      // HERE, on this host surface, wake capture is real: the two enablement rows
      // open a recorder subprocess and the utterance after a wake reaches the
      // conversation input. On a PAIRED PHONE it is still unpublished, and that
      // stays gated on certified permission-scoped records. So the status reports
      // the local capability the user can actually use, and the phone half keeps
      // its own evidence field rather than being folded into one number.
      status: wake.blockers.length > 0
        ? 'attention'
        : wake.active ? 'ready' : 'setup-needed',
      userOutcome: 'Speak a wake phrase on this host and have what follows reach the conversation input; on a paired phone, only after a permission-scoped runtime contract exists.',
      summary: wake.blockers.length > 0
        ? `Wake-word capture is wired on this surface but one row refuses to start it: ${wake.blockers.map((blocker) => blocker.key).join(', ')}.`
        : wake.active
          ? 'Wake-word capture is live on this surface: a recorder subprocess feeds the pinned classifier, a confirmed wake plays the activation sound and shows a listening row, and the utterance that follows goes to speech-to-text. Published recall figures for the model are measured on synthesised speech only.'
          : `Wake-word capture is wired on this surface and switched off: voice.wake.enabled is ${wake.enabled ? 'on' : 'off'} and voice.wake.surfaces.agent is ${wake.surfaceEnabled ? 'on' : 'off'}. Wake capture on a paired phone remains unpublished by the current Agent runtime contract.`,
      // These are instructions to YOU, and they describe work you perform. A
      // next step phrased as a command for the user to type is the defect: the
      // platform does the thing and reports what it did.
      nextStep: wake.blockers.length > 0
        ? `Tell the user which row refuses to start wake capture: ${wake.blockers[0]?.key ?? 'the blocking row'}. Its written reason is in blockedRowDetails; changing that setting is their decision.`
        : wake.active
          ? 'Wake capture is live; run agent_harness mode:"run_command" command:"/voice wake-status" to confirm the pinned models verify on disk, and report its result rather than asking anyone to check.'
          : 'Ask the user whether to turn wake capture on; it keeps the microphone listening. Only on their request set voice.wake.enabled (the first setupRoutes entry; the surface row moves with it). Turning it on runs the voice setup: missing wake models are fetched and verified, and the setup plan is shown, proposing speech-to-text when it is missing (agent_harness mode:"run_command" command:"/voice wake-setup --with-speech-to-text" installs it). agent_harness mode:"run_command" command:"/voice wake-status" then reports what is on disk.',
      capabilities: ['wake word', 'always listening', 'permission repair'],
      modelRoute: 'agent_harness mode:"media_posture" query:"wake word" includeParameters:true',
      setupRoutes: [
        'settings action:"set" key:"voice.wake.enabled" value:"true" explicitUserRequest:"<the user request, in their own words>"',
        'agent_harness mode:"run_command" command:"/voice wake-status"',
        'agent_harness mode:"media_posture" query:"push to talk" includeParameters:true',
        'agent_harness mode:"pairing_posture" query:"device" includeParameters:true',
      ],
      evidence: {
        localCaptureHost: true,
        wakeEnabled: wake.enabled,
        surfaceEnabled: wake.surfaceEnabled,
        listening: wake.active,
        indicator: wake.indicator,
        autoSubmit: wake.autoSubmit,
        recorder: wake.capture.backend,
        blockedRows: wake.blockers.map((blocker) => blocker.key),
        blockedRowDetails: wake.blockers.map((blocker) => ({ key: blocker.key, detail: previewHarnessText(blocker.detail, 200) })),
        rowsNotInForce: wake.limitations.map((limitation) => limitation.key),
        rowsNotInForceDetails: wake.limitations.map((limitation) => ({ key: limitation.key, detail: previewHarnessText(limitation.detail, 200) })),
        // Both filtering rows, reported as what they are rather than as refusals.
        noiseSuppression: wake.capture.noiseSuppression,
        speechGateThreshold: wake.vadThreshold,
        speechGateLoaded: vadReady,
        recallIsSyntheticOnly: true,
        // The PHONE half only. False here has never meant "nothing listens".
        companionWakePublishedByCurrentAgentContract: false,
      },
      policy: 'On this host, always-listening capture runs only while both voice.wake.enabled and voice.wake.surfaces.agent are on, and holds a visible listening row for as long as it does. The paired-device capability catalog has no microphone or wake capability, so always-listening on a paired device is not offered.',
    },
  ];
}

function describeVoiceWorkflow(workflow: VoiceInteractionWorkflow, includeParameters: boolean): Record<string, unknown> {
  if (includeParameters) return { ...workflow };
  return {
    workflowId: workflow.id,
    label: workflow.label,
    status: workflow.status,
    summary: previewHarnessText(workflow.summary),
    modelRoute: workflow.modelRoute,
  };
}

function mediaProviderModelRoute(): string {
  return 'agent_media_generate or agent_harness mode:"media_provider"';
}

function statusMap(statuses: readonly RuntimeProviderStatus[]): ReadonlyMap<string, RuntimeProviderStatus> {
  return new Map(statuses.map((status) => [status.id, status]));
}

function describeProvider(
  provider: AgentWorkspaceVoiceMediaProviderStatus,
  runtimeStatus: RuntimeProviderStatus | undefined,
  options: {
    readonly includeParameters?: boolean;
    readonly lookup?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    mediaProviderId: `${provider.domain}:${provider.id}`,
    id: provider.id,
    label: provider.label,
    domain: provider.domain,
    features: provider.features,
    setupState: provider.setupState,
    selected: provider.selected,
    configuredSecretKeyNames: provider.configuredSecretKeys,
    missingSecretKeyNames: provider.missingSecretKeyOptions,
    nextStep: provider.nextStep,
    modelRoute: mediaProviderModelRoute(),
    ...(runtimeStatus ? {
      runtimeStatus: {
        state: runtimeStatus.state,
        configured: runtimeStatus.configured,
        ...(options.includeParameters && runtimeStatus.detail ? { detail: runtimeStatus.detail } : {}),
      },
    } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters
      ? {
        modelRoutes: {
          inspectPosture: 'agent_harness mode:"media_posture"',
          inspectProvider: 'agent_harness mode:"media_provider"',
          generateMedia: 'agent_media_generate with the user request in explicitUserRequest',
          ttsSettings: 'settings action:"list|get|set" for tts.provider, tts.voice, tts.llmProvider, and tts.llmModel',
        },
        policy: {
          effect: 'read-only',
          values: 'Provider posture returns capability, setup, selected, health, and safe environment key names only; secret values and media payloads are never returned.',
          mutation: 'Media generation, voice enable/disable, TTS setting changes, and bundle export stay explicit confirmation-gated tool, setting, workspace, or slash-command flows.',
        },
      }
      : {
        summary: previewHarnessText(provider.nextStep || `${provider.domain} provider ${provider.setupState}`),
      }),
  };
}

async function readRuntimeStatuses(context: CommandContext, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const readErrors: string[] = [];
  const voice = await (async () => {
    try { return await context.platform.voiceProviderRegistry?.status() ?? []; }
    catch (error) { logger.warn('Voice provider status could not be read', { error: summarizeError(error) }); readErrors.push('voice provider status could not be read'); return []; }
  })();
  const voiceSource = captureAsyncHarnessInput(voice, options);
  voiceSource.retainSourceCurrent();
  voiceSource.assertCurrent();
  const media = await (async () => {
    try { return await context.platform.mediaProviderRegistry?.status() ?? []; }
    catch (error) { logger.warn('Media provider status could not be read', { error: summarizeError(error) }); readErrors.push('media provider status could not be read'); return []; }
  })();
  voiceSource.assertCurrent();
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  return { voice: voiceSource.args, media, readErrors };
}

function buildReadiness(context: CommandContext) {
  const voice = context.platform.voiceProviderRegistry?.list() ?? [];
  const media = context.platform.mediaProviderRegistry?.list() ?? [];
  return { ...buildAgentWorkspaceVoiceMediaReadiness({ context, voiceProviders: voice, mediaProviders: media }),
    originalProviders: { voice, media } };
}

function providersFrom(readiness: ReturnType<typeof buildReadiness>, runtimeStatuses: Awaited<ReturnType<typeof readRuntimeStatuses>>) {
  const voiceStatuses = statusMap(runtimeStatuses.voice), mediaStatuses = statusMap(runtimeStatuses.media);
  return [
    ...readiness.voiceProviders.map(provider => ({ provider, runtimeStatus: voiceStatuses.get(provider.id),
      registration: readiness.originalProviders.voice.find(entry => entry.id === provider.id) })),
    ...readiness.mediaProviders.map(provider => ({ provider, runtimeStatus: mediaStatuses.get(provider.id),
      registration: readiness.originalProviders.media.find(entry => entry.id === provider.id) })),
  ];
}

/** Counts only: the provider readiness and the four workflow rows are local facts, so no reading is made. */
export async function mediaPostureCatalogStatus(context: CommandContext, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const readiness = buildReadiness(context);
  const voiceWorkflows = await buildVoiceInteractionWorkflows(context, readiness, options);
  return {
    modes: ['media_posture', 'media_provider'], voiceProviders: readiness.voiceProviders.length,
    mediaProviders: readiness.mediaProviders.length, readyVoiceProviders: readiness.readyVoiceProviderCount,
    readyMediaProviders: readiness.readyMediaProviderCount, voiceWorkflowSummary: voiceWorkflowSummary(voiceWorkflows), readOnly: true,
  };
}

export async function mediaPostureSummary(context: CommandContext, rawArgs: AgentHarnessMediaArgs,
  options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const native = captureCatalogNativeFacts(context, 'media');
  const caller = captureAsyncHarnessInput(rawArgs, options, true);
  const childOptions = { ...caller.options, assertCurrent: caller.assertCallerCurrent };
  const args = caller.args;
  const readinessInput = buildReadiness(context);
  const readinessSource = captureAsyncHarnessInput(readinessInput, childOptions, true);
  const runtimeInput = await readRuntimeStatuses(context, childOptions);
  readinessSource.assertCurrent(); caller.assertCurrent();
  const voiceWorkflowsInput = await buildVoiceInteractionWorkflows(context, readinessInput, childOptions);
  readinessSource.assertCurrent(); caller.assertCurrent();
  readinessSource.retainSourceCurrent('agent.media.readiness');
  const result = await withModelReadingSource({ args, readiness: readinessInput, runtimeStatuses: runtimeInput,
    voiceWorkflows: voiceWorkflowsInput, nativeProviderEvidence: native.providerEvidence }, childOptions,
    async ({ readiness, runtimeStatuses, voiceWorkflows }, current) => {
      const providers = providersFrom(readiness, runtimeStatuses);
      const query = readString(args.query), limit = readLimit(args.limit, 100);
      const matchingProviders = await browserDeviceCatalogMatches(providers, query, entry => ({
        id: `${entry.provider.domain}:${entry.provider.id}`, description: providerCatalogDescription(entry.provider), evidence: entry,
      }), current, 'agent.media.providers.query');
      current.assertCurrent?.();
      const matchingWorkflows = await browserDeviceCatalogMatches(voiceWorkflows, query, workflow => ({
        id: workflow.id, description: workflowCatalogDescription(workflow), evidence: workflow,
      }), current, 'agent.media.workflows.query');
      current.assertCurrent?.();
      const filtered = matchingProviders.slice(0, limit), filteredVoiceWorkflows = matchingWorkflows.slice(0, limit);
      const result = {
        status: 'available',
        summary: {
          voiceProviders: readiness.voiceProviders.length,
          mediaProviders: readiness.mediaProviders.length,
          readyVoiceProviders: readiness.readyVoiceProviderCount,
          readyMediaProviders: readiness.readyMediaProviderCount,
          selectedTtsProviderStatus: readiness.selectedTtsProviderStatus,
          selectedTtsProviderLabel: readiness.selectedTtsProviderLabel,
          ttsVoiceConfigured: readiness.ttsVoiceConfigured,
          ttsResponseRouteConfigured: readiness.ttsResponseRouteConfigured,
          voiceSurfaceEnabled: readConfigBoolean(context, 'ui.voiceEnabled', false),
          browserToolState: readiness.browserToolState,
          voiceWorkflows: voiceWorkflowSummary(voiceWorkflows),
          returnedVoiceWorkflows: filteredVoiceWorkflows.length,
          artifactStoreAvailable: Boolean(context.platform.artifactStore),
          ttsProviderSetting: readConfigString(context, 'tts.provider') || null,
          ttsVoiceSettingConfigured: readConfigString(context, 'tts.voice').length > 0,
          nextSteps: readiness.nextSteps,
        },
        providers: filtered.map(({ provider, runtimeStatus }) => describeProvider(provider, runtimeStatus, {
          includeParameters: args.includeParameters === true,
        })),
        voiceWorkflows: filteredVoiceWorkflows.map((workflow) => describeVoiceWorkflow(workflow, args.includeParameters === true)),
        returned: filtered.length,
        total: providers.length,
        ...(runtimeStatuses.readErrors.length > 0 ? { readErrors: runtimeStatuses.readErrors, readErrorNote: 'Runtime status was not available for some providers; absent status here is not evidence they are unconfigured.' } : {}),
        policy: 'Read-only voice/media posture. Media generation, voice enable/disable, TTS setting changes, and bundle export stay confirmation-gated through first-class tools, settings modes, workspace actions, or slash-command mirrors.',
        ...(args.includeParameters === true ? { modelAccess: {
          mediaGenerateTool: 'agent_media_generate',
          providerCatalogMode: 'media_posture',
          singleProviderMode: 'media_provider',
          ttsProviderPicker: 'agent_harness mode:"open_ui_surface" surfaceId:"tts-provider-picker" explicitUserRequest:"<the user request, in their own words>"',
          ttsVoicePicker: 'agent_harness mode:"open_ui_surface" surfaceId:"tts-voice-picker" explicitUserRequest:"<the user request, in their own words>"',
          voiceWorkflowPosture: 'agent_harness mode:"media_posture" query:"push to talk" includeParameters:true',
          commands: ['/media providers', '/voice review', '/voice speak <message>'],
          // Sending an image file with a message is the conversation's own control: the capability conversation.image.
          imageCapability: 'conversation.image',
        } } : {}),
      };
      current.assertCurrent?.();
      return result;
  });
  caller.retainSourceCurrent('agent.media.sources');
  return result;
}

export async function describeHarnessMediaProvider(context: CommandContext, rawArgs: AgentHarnessMediaArgs,
  options: CatalogRankingOptions = {}): Promise<MediaProviderResolution> {
  const native = captureCatalogNativeFacts(context, 'media');
  const caller = captureAsyncHarnessInput(rawArgs, options, true);
  const childOptions = { ...caller.options, assertCurrent: caller.assertCallerCurrent };
  const result = await withModelReadingSource(caller.args, childOptions, async (args, inputOptions): Promise<MediaProviderResolution> => {
    const mediaProviderId = readString(args.mediaProviderId), target = readString(args.target), query = readString(args.query);
    const input = mediaProviderId || target || query;
    if (!input) return { status: 'missing_lookup', usage: 'media_provider requires mediaProviderId, target, or query. Use mode:"media_posture" to inspect provider ids.' };
    const readiness = buildReadiness(context);
    const readinessSource = captureAsyncHarnessInput(readiness, inputOptions);
    readinessSource.retainSourceCurrent();
    const runtimeStatuses = await readRuntimeStatuses(context, readinessSource.options);
    readinessSource.assertCurrent();
    inputOptions.assertCurrent?.();
    const source = captureAsyncHarnessInput({ readiness, runtimeStatuses, nativeProviderEvidence: native.providerEvidence }, inputOptions);
    source.retainSourceCurrent();
    return withModelReadingSource(source.args, source.options, async (captured, current): Promise<MediaProviderResolution> => {
      const providers = providersFrom(captured.readiness, captured.runtimeStatuses);
      const lookup = { input, source: mediaProviderId ? 'mediaProviderId' : target ? 'target' : 'query' };
      const exact = providers.find(({ provider }) => `${provider.domain}:${provider.id}` === input || provider.id === input);
      if (exact) return { status: 'found', provider: describeProvider(exact.provider, exact.runtimeStatus, {
        includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' },
      }) };
      const normalized = input.toLowerCase();
      const insensitive = providers.find(({ provider }) => `${provider.domain}:${provider.id}`.toLowerCase() === normalized || provider.id.toLowerCase() === normalized);
      if (insensitive) return { status: 'found', provider: describeProvider(insensitive.provider, insensitive.runtimeStatus, {
        includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' },
      }) };
      const selected = await selectHarnessCatalog(providers, input, entry => ({
        id: `${entry.provider.domain}:${entry.provider.id}`, description: providerCatalogDescription(entry.provider), evidence: entry,
      }), current, 'agent.media.provider.select');
      current.assertCurrent?.();
      return selected ? { status: 'found', provider: describeProvider(selected.provider, selected.runtimeStatus, {
        includeParameters: true, lookup: { ...lookup, resolvedBy: 'selection' },
      }) } : { status: 'missing_lookup', usage: `Unknown media provider ${input}. Use mode:"media_posture" to inspect provider ids.` };
    });
  });
  caller.retainSourceCurrent('agent.media.sources');
  return result;
}
