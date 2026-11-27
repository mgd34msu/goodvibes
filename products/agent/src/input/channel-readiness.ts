import type { CommandContext } from './command-registry.ts';

export type AgentChannelRisk = 'dm' | 'group' | 'public' | 'webhook' | 'bridge';

export interface AgentChannelStatus {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly requiredKeys: readonly string[];
  readonly missingRequiredKeys: readonly string[];
  readonly missingConfigCount: number;
  readonly defaultTargetKeys: readonly string[];
  readonly configuredDefaultTargetKeys: readonly string[];
  readonly defaultTarget: 'configured' | 'missing' | 'not-required';
  readonly delivery: 'disabled' | 'blocked' | 'explicit-target' | 'default-ready';
  readonly risk: AgentChannelRisk;
  readonly riskLabel: string;
  /** 'unknown' means the configuration could not be read, which is not the same as the channel being off. */
  readonly setupState: 'disabled' | 'needs-config' | 'needs-target' | 'ready' | 'unknown';
  readonly nextStep: string;
  /** Present only when setupState is 'unknown': why the configuration could not be read. */
  readonly readError?: string;
}

export type AgentChannelSetupGuideStatus = 'ready' | 'attention' | 'setup-needed';
/** `then` marks a step that follows a configured channel and is not counted as progress. */
export type AgentChannelSetupGuideStepStatus = 'complete' | 'current' | 'pending' | 'then';
export type AgentChannelSetupGuideStepSafety = 'read-only' | 'settings' | 'confirmed';

export interface AgentChannelSetupGuideStep {
  readonly id: string;
  readonly label: string;
  readonly status: AgentChannelSetupGuideStepStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly safety: AgentChannelSetupGuideStepSafety;
}

export interface AgentChannelSetupGuideChannel {
  readonly channelId: string;
  readonly label: string;
  readonly setupState: AgentChannelStatus['setupState'];
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly delivery: AgentChannelStatus['delivery'];
  readonly riskLabel: string;
  readonly summary: string;
  readonly guideRoute: string;
  readonly modelRoute: string;
}

export interface AgentChannelSetupGuide {
  readonly status: AgentChannelSetupGuideStatus;
  readonly summary: string;
  readonly progressLabel: string;
  readonly totalChannels: number;
  readonly enabledChannels: number;
  readonly readyChannels: number;
  readonly attentionChannels: number;
  readonly configuredTargets: number;
  readonly currentChannelId: string | null;
  readonly currentChannelLabel: string | null;
  readonly currentStepId: string | null;
  readonly currentStepLabel: string | null;
  readonly channels: readonly AgentChannelSetupGuideChannel[];
  readonly steps: readonly AgentChannelSetupGuideStep[];
  readonly routes: {
    readonly readiness: string;
    readonly attention: string;
    readonly accounts: string;
    readonly policies: string;
    readonly status: string;
  };
  readonly policy: string;
}

interface AgentConfigReader {
  get(key: string): unknown;
}

interface AgentChannelSpec {
  readonly id: string;
  readonly label: string;
  readonly enabledKey: string;
  readonly requiredKeys: readonly string[];
  readonly requiredKeyGroups?: readonly (readonly string[])[];
  readonly defaultTargetKeys: readonly string[];
  readonly risk: AgentChannelRisk;
  readonly riskLabel: string;
}

const AGENT_CHANNEL_SPECS: readonly AgentChannelSpec[] = [
  {
    id: 'slack',
    label: 'Slack',
    enabledKey: 'surfaces.slack.enabled',
    requiredKeys: ['surfaces.slack.botToken', 'surfaces.slack.signingSecret'],
    defaultTargetKeys: ['surfaces.slack.defaultChannel'],
    risk: 'group',
    riskLabel: 'workspace/group channel',
  },
  {
    id: 'discord',
    label: 'Discord',
    enabledKey: 'surfaces.discord.enabled',
    requiredKeys: ['surfaces.discord.botToken', 'surfaces.discord.publicKey', 'surfaces.discord.applicationId'],
    defaultTargetKeys: ['surfaces.discord.defaultChannelId'],
    risk: 'group',
    riskLabel: 'server/channel delivery',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    enabledKey: 'surfaces.telegram.enabled',
    requiredKeys: ['surfaces.telegram.botToken'],
    defaultTargetKeys: ['surfaces.telegram.defaultChatId'],
    risk: 'dm',
    riskLabel: 'bot DM/group delivery',
  },
  {
    id: 'ntfy',
    label: 'ntfy',
    enabledKey: 'surfaces.ntfy.enabled',
    requiredKeys: ['surfaces.ntfy.baseUrl', 'surfaces.ntfy.chatTopic', 'surfaces.ntfy.agentTopic'],
    defaultTargetKeys: ['surfaces.ntfy.topic'],
    risk: 'public',
    riskLabel: 'topic-based public/private feed',
  },
  {
    id: 'googleChat',
    label: 'Google Chat',
    enabledKey: 'surfaces.googleChat.enabled',
    requiredKeys: ['surfaces.googleChat.webhookUrl', 'surfaces.googleChat.verificationToken'],
    defaultTargetKeys: ['surfaces.googleChat.spaceId'],
    risk: 'group',
    riskLabel: 'space delivery',
  },
  {
    id: 'signal',
    label: 'Signal',
    enabledKey: 'surfaces.signal.enabled',
    requiredKeys: ['surfaces.signal.bridgeUrl', 'surfaces.signal.account'],
    defaultTargetKeys: ['surfaces.signal.defaultRecipient'],
    risk: 'bridge',
    riskLabel: 'private routed delivery',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    enabledKey: 'surfaces.whatsapp.enabled',
    requiredKeys: ['surfaces.whatsapp.accessToken', 'surfaces.whatsapp.verifyToken', 'surfaces.whatsapp.phoneNumberId'],
    defaultTargetKeys: ['surfaces.whatsapp.defaultRecipient'],
    risk: 'dm',
    riskLabel: 'phone-number delivery',
  },
  {
    id: 'telephony',
    label: 'Telephony',
    enabledKey: 'surfaces.telephony.enabled',
    requiredKeys: [],
    requiredKeyGroups: [
      ['surfaces.telephony.bridgeUrl'],
      ['surfaces.telephony.accountSid', 'surfaces.telephony.authToken', 'surfaces.telephony.fromNumber'],
    ],
    defaultTargetKeys: ['surfaces.telephony.defaultRecipient'],
    risk: 'dm',
    riskLabel: 'SMS/voice phone-number delivery',
  },
  {
    id: 'imessage',
    label: 'iMessage',
    enabledKey: 'surfaces.imessage.enabled',
    requiredKeys: ['surfaces.imessage.bridgeUrl', 'surfaces.imessage.account'],
    defaultTargetKeys: ['surfaces.imessage.defaultChatId'],
    risk: 'bridge',
    riskLabel: 'Apple routed delivery',
  },
  {
    id: 'bluebubbles',
    label: 'BlueBubbles',
    enabledKey: 'surfaces.bluebubbles.enabled',
    requiredKeys: ['surfaces.bluebubbles.serverUrl', 'surfaces.bluebubbles.password'],
    defaultTargetKeys: ['surfaces.bluebubbles.defaultChatGuid'],
    risk: 'bridge',
    riskLabel: 'iMessage routed delivery',
  },
  {
    id: 'msteams',
    label: 'Microsoft Teams',
    enabledKey: 'surfaces.msteams.enabled',
    requiredKeys: ['surfaces.msteams.appId', 'surfaces.msteams.appPassword'],
    defaultTargetKeys: ['surfaces.msteams.defaultConversationId', 'surfaces.msteams.defaultChannelId'],
    risk: 'group',
    riskLabel: 'tenant/channel delivery',
  },
  {
    id: 'mattermost',
    label: 'Mattermost',
    enabledKey: 'surfaces.mattermost.enabled',
    requiredKeys: ['surfaces.mattermost.baseUrl', 'surfaces.mattermost.botToken'],
    defaultTargetKeys: ['surfaces.mattermost.defaultChannelId'],
    risk: 'group',
    riskLabel: 'team/channel delivery',
  },
  {
    id: 'matrix',
    label: 'Matrix',
    enabledKey: 'surfaces.matrix.enabled',
    requiredKeys: ['surfaces.matrix.homeserverUrl', 'surfaces.matrix.accessToken'],
    defaultTargetKeys: ['surfaces.matrix.defaultRoomId'],
    risk: 'group',
    riskLabel: 'room delivery',
  },
  {
    id: 'webhook',
    label: 'Webhook',
    enabledKey: 'surfaces.webhook.enabled',
    requiredKeys: ['surfaces.webhook.defaultTarget'],
    defaultTargetKeys: ['surfaces.webhook.defaultTarget'],
    risk: 'webhook',
    riskLabel: 'external HTTP delivery',
  },
];

function configValue(context: CommandContext, key: string): unknown {
  const configManager = context.platform?.configManager as AgentConfigReader | undefined;
  return configManager?.get(key);
}

// A throwing config read is not caught here: buildAgentChannels reports it as an
// 'unknown' status, because defaulting to false would show a working channel as switched off.
function readConfigBoolean(context: CommandContext, key: string, fallback: boolean): boolean {
  const value = configValue(context, key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function hasConfigValue(context: CommandContext, key: string): boolean {
  const value = configValue(context, key);
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value;
  return value !== null && value !== undefined;
}

function unreadableChannelStatus(spec: AgentChannelSpec, error: unknown): AgentChannelStatus {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    id: spec.id,
    label: spec.label,
    enabled: false,
    ready: false,
    requiredKeys: uniqueStrings([...spec.requiredKeys, ...(spec.requiredKeyGroups ?? []).flat()]),
    missingRequiredKeys: [],
    missingConfigCount: 0,
    defaultTargetKeys: spec.defaultTargetKeys,
    configuredDefaultTargetKeys: [],
    defaultTarget: spec.defaultTargetKeys.length === 0 ? 'not-required' : 'missing',
    delivery: 'blocked',
    risk: spec.risk,
    riskLabel: spec.riskLabel,
    setupState: 'unknown',
    nextStep: `The ${spec.label} configuration could not be read (${reason}). Fix the configuration store, then check again; this does not mean the channel is disabled.`,
    readError: reason,
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function missingKeysForBestRequiredGroup(context: CommandContext, groups: readonly (readonly string[])[]): readonly string[] {
  if (groups.length === 0) return [];
  const missingByGroup = groups.map((group) => group.filter((key) => !hasConfigValue(context, key)));
  if (missingByGroup.some((missing) => missing.length === 0)) return [];
  return missingByGroup.reduce((best, missing) => missing.length < best.length ? missing : best, missingByGroup[0] ?? []);
}

function buildChannelStatus(context: CommandContext, spec: AgentChannelSpec): AgentChannelStatus {
  const enabled = readConfigBoolean(context, spec.enabledKey, false);
  const requiredKeyGroups = spec.requiredKeyGroups ?? [];
  const requiredKeys = uniqueStrings([
    ...spec.requiredKeys,
    ...requiredKeyGroups.flat(),
  ]);
  const missingRequiredKeys = [
    ...spec.requiredKeys.filter((key) => !hasConfigValue(context, key)),
    ...missingKeysForBestRequiredGroup(context, requiredKeyGroups),
  ];
  const configuredDefaultTargetKeys = spec.defaultTargetKeys.filter((key) => hasConfigValue(context, key));
  const missingConfigCount = missingRequiredKeys.length;
  const defaultTarget = spec.defaultTargetKeys.length === 0
    ? 'not-required'
    : configuredDefaultTargetKeys.length > 0
      ? 'configured'
      : 'missing';
  const ready = enabled && missingConfigCount === 0;
  const delivery = !enabled
    ? 'disabled'
    : !ready
      ? 'blocked'
      : defaultTarget === 'configured'
        ? 'default-ready'
        : 'explicit-target';
  const setupState = !enabled
    ? 'disabled'
    : missingConfigCount > 0
      ? 'needs-config'
      : defaultTarget === 'missing'
        ? 'needs-target'
        : 'ready';
  const nextStep = setupState === 'disabled'
    ? `Enable ${spec.label} in the owning GoodVibes host before Agent can use it.`
    : setupState === 'needs-config'
      ? `Configure ${missingRequiredKeys.join(', ')} in the owning GoodVibes host or secret manager.`
      : setupState === 'needs-target'
        ? `Provide an explicit delivery target per send, or configure one of ${spec.defaultTargetKeys.join(', ')}.`
        : `Use explicit user action or Agent policy to send through ${spec.label}.`;
  return {
    id: spec.id,
    label: spec.label,
    enabled,
    ready,
    requiredKeys,
    missingRequiredKeys,
    missingConfigCount,
    defaultTargetKeys: spec.defaultTargetKeys,
    configuredDefaultTargetKeys,
    defaultTarget,
    delivery,
    risk: spec.risk,
    riskLabel: spec.riskLabel,
    setupState,
    nextStep,
  };
}

export function buildAgentChannels(context: CommandContext): readonly AgentChannelStatus[] {
  return AGENT_CHANNEL_SPECS.map((spec) => {
    try {
      return buildChannelStatus(context, spec);
    } catch (error) {
      return unreadableChannelStatus(spec, error);
    }
  });
}

function channelGuideModelRoute(channelId?: string): string {
  return channelId
    ? `channels action:"setup" channelId:"${channelId}"`
    : 'channels action:"setup"';
}

function summarizeGuideChannel(channel: AgentChannelStatus): string {
  if (!channel.enabled) return `Enable ${channel.label} only if the user wants this surface.`;
  if (channel.setupState === 'needs-config') return `Missing ${channel.missingRequiredKeys.length} required config key(s).`;
  if (channel.setupState === 'needs-target') return 'Ready for explicit targets; default target is not configured.';
  return `${channel.label} is ready; delivery still requires explicit user action.`;
}

function rankedChannelGuideChannels(channels: readonly AgentChannelStatus[]): readonly AgentChannelStatus[] {
  // A channel whose configuration could not be read needs attention most.
  const rank = (channel: AgentChannelStatus): number => {
    if (channel.setupState === 'unknown') return 0;
    if (channel.setupState === 'needs-config') return 1;
    if (channel.setupState === 'needs-target') return 2;
    if (channel.setupState === 'ready') return 3;
    return 4;
  };
  return [...channels].sort((left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label));
}

/**
 * The channel the guide is about: one the owner named, else the first channel
 * he enabled (or whose configuration could not be read). Nothing enabled means
 * no channel has been chosen yet, so the guide starts at "Choose channel".
 */
function currentGuideChannel(channels: readonly AgentChannelStatus[]): AgentChannelStatus | null {
  return rankedChannelGuideChannels(channels).find((channel) => channel.enabled || channel.setupState === 'unknown') ?? null;
}

/** Steps whose completion follows from the channel's configuration. */
const GUIDE_PROGRESS_STEPS = [
  'choose-channel',
  'enable-channel',
  'inspect-setup-schema',
  'configure-secrets',
  'choose-delivery-target',
] as const;

/** Steps that follow a configured channel; nothing records them, so they are not counted as progress. */
const GUIDE_THEN_STEPS = ['review-policy', 'run-live-checks', 'send-explicit-test'] as const;

type GuideStepId = typeof GUIDE_PROGRESS_STEPS[number] | typeof GUIDE_THEN_STEPS[number];

function currentGuideStepId(channel: AgentChannelStatus | null): typeof GUIDE_PROGRESS_STEPS[number] | null {
  if (!channel) return 'choose-channel';
  if (!channel.enabled) return 'enable-channel';
  if (channel.setupState === 'needs-config' || channel.setupState === 'unknown') return 'inspect-setup-schema';
  if (channel.setupState === 'needs-target') return 'choose-delivery-target';
  return null;
}

function guideStepStatus(stepId: GuideStepId, currentStepId: typeof GUIDE_PROGRESS_STEPS[number] | null): AgentChannelSetupGuideStepStatus {
  if ((GUIDE_THEN_STEPS as readonly string[]).includes(stepId)) return 'then';
  if (currentStepId === null) return 'complete';
  const stepIndex = GUIDE_PROGRESS_STEPS.indexOf(stepId as typeof GUIDE_PROGRESS_STEPS[number]);
  const currentIndex = GUIDE_PROGRESS_STEPS.indexOf(currentStepId);
  if (stepIndex < currentIndex) return 'complete';
  if (stepIndex === currentIndex) return 'current';
  return 'pending';
}

function buildGuideSteps(channel: AgentChannelStatus | null): readonly AgentChannelSetupGuideStep[] {
  const channelId = channel?.id ?? '<channel-id>';
  const channelLabel = channel?.label ?? 'a channel';
  const currentStepId = currentGuideStepId(channel);
  const missingConfig = channel && channel.missingRequiredKeys.length > 0
    ? channel.missingRequiredKeys.join(', ')
    : 'the required secret refs or host-owned settings';
  const targetKeys = channel && channel.defaultTargetKeys.length > 0
    ? channel.defaultTargetKeys.join(', ')
    : 'an explicit delivery target';
  const makeStep = (
    id: GuideStepId,
    label: string,
    detail: string,
    userRoute: string,
    modelRoute: string,
    safety: AgentChannelSetupGuideStepSafety,
  ): AgentChannelSetupGuideStep => ({
    id,
    label,
    status: guideStepStatus(id, currentStepId),
    detail,
    userRoute,
    modelRoute,
    safety,
  });
  return [
    makeStep(
      'choose-channel',
      'Choose channel',
      'Pick the channel the user actually wants before collecting credentials or exposing delivery routes.',
      'Mail, calendar and channels, Channels: "which are set up"',
      'channels action:"status"',
      'read-only',
    ),
    makeStep(
      'enable-channel',
      'Enable surface',
      `Enable ${channelLabel} in the owning GoodVibes host or Agent settings only after the user chooses it.`,
      `/settings open surfaces.${channelId}.enabled`,
      `settings action:"get" query:"surfaces.${channelId}.enabled" includeParameters:true`,
      'settings',
    ),
    makeStep(
      'inspect-setup-schema',
      'Inspect setup schema',
      `Open the read-only ${channelLabel} setup schema before asking for credentials.`,
      `Mail, calendar and channels, Channels: select ${channelLabel}, "what it needs"`,
      `channels action:"channel" channelId:"${channelId}" includeParameters:true`,
      'read-only',
    ),
    makeStep(
      'configure-secrets',
      'Configure secrets',
      `Configure ${missingConfig}; secret values must stay in the secret manager or owning host.`,
      `/settings list surfaces.${channelId}`,
      `settings action:"list" query:"surfaces.${channelId}" includeParameters:true`,
      'settings',
    ),
    makeStep(
      'choose-delivery-target',
      'Choose target',
      `Configure ${targetKeys}, or require the user to provide an explicit target on every send.`,
      `Mail, calendar and channels, Channels: select ${channelLabel}, "how it is configured"`,
      `channels action:"channel" channelId:"${channelId}" includeParameters:true`,
      'read-only',
    ),
    makeStep(
      'review-policy',
      'Review allowlist',
      `Review ${channelLabel} account and allowlist policy before any delivery test.`,
      `Mail, calendar and channels, Channels: select ${channelLabel}, "who may write"`,
      'channels action:"status" includeParameters:true',
      'read-only',
    ),
    makeStep(
      'run-live-checks',
      'Run live checks',
      `Inspect connected-host status and doctor output for ${channelLabel}; do not run repair actions from the guide.`,
      `Mail, calendar and channels, Channels: select ${channelLabel}, "check it"`,
      `channels action:"channel" channelId:"${channelId}" includeParameters:true`,
      'read-only',
    ),
    channel?.defaultTarget === 'configured'
      ? makeStep(
        'send-explicit-test',
        'Send explicit test',
        `Send one test message to the configured ${channelLabel} default target, only after the user asks for it and confirms the send.`,
        `Mail, calendar and channels, Channels: select ${channelLabel}, "send a test"`,
        `agent_channel_send channel:"${channelId}"`,
        'confirmed',
      )
      : makeStep(
        'send-explicit-test',
        'Send explicit test',
        `A test send needs a target: configure ${targetKeys} for ${channelLabel}, or name the route the user gives on the send itself.`,
        `Mail, calendar and channels, Channels: select ${channelLabel}, "how it is configured"`,
        `channels action:"channel" channelId:"${channelId}" includeParameters:true`,
        'confirmed',
      ),
  ];
}

export function buildAgentChannelSetupGuide(
  channels: readonly AgentChannelStatus[],
  options: { readonly channelId?: string } = {},
): AgentChannelSetupGuide {
  const lookup = options.channelId?.trim().toLowerCase();
  const requested = lookup
    ? channels.find((channel) => channel.id.toLowerCase() === lookup || channel.label.toLowerCase() === lookup) ?? null
    : null;
  const ranked = rankedChannelGuideChannels(channels);
  const current = requested ?? currentGuideChannel(channels);
  const enabledChannels = channels.filter((channel) => channel.enabled).length;
  const readyChannels = channels.filter((channel) => channel.ready).length;
  const attentionChannels = channels.filter((channel) => channel.setupState === 'unknown' || (channel.enabled && channel.setupState !== 'ready')).length;
  const configuredTargets = channels.filter((channel) => channel.defaultTarget === 'configured').length;
  const status: AgentChannelSetupGuideStatus = attentionChannels > 0
    ? 'attention'
    : readyChannels > 0
      ? 'ready'
      : 'setup-needed';
  const steps = buildGuideSteps(current);
  const currentStep = steps.find((step) => step.status === 'current') ?? null;
  const progressSteps = steps.filter((step) => step.status !== 'then');
  const completedSteps = progressSteps.filter((step) => step.status === 'complete').length;
  const summary = status === 'attention'
    ? `${attentionChannels} enabled channel(s) need setup. Start with ${current?.label ?? 'the first attention channel'}.`
    : status === 'ready'
      ? `${readyChannels}/${channels.length} channel(s) ready. Review allowlists and use explicit delivery tests only on request.`
      : current
      ? `${current.label} is enabled and not ready yet. Finish its setup, then configure only the surfaces you want.`
      : 'No channel is enabled yet. Choose one channel, enable it intentionally, then configure only that surface.';
  return {
    status,
    summary,
    progressLabel: currentStep
      ? `${completedSteps + 1}/${progressSteps.length} ${currentStep.label}`
      : `${completedSteps}/${progressSteps.length} set up; then review the allowlist, run live checks and send a test`,
    totalChannels: channels.length,
    enabledChannels,
    readyChannels,
    attentionChannels,
    configuredTargets,
    currentChannelId: current?.id ?? null,
    currentChannelLabel: current?.label ?? null,
    currentStepId: currentStep?.id ?? null,
    currentStepLabel: currentStep?.label ?? null,
    channels: ranked.map((channel) => ({
      channelId: channel.id,
      label: channel.label,
      setupState: channel.setupState,
      enabled: channel.enabled,
      ready: channel.ready,
      delivery: channel.delivery,
      riskLabel: channel.riskLabel,
      summary: summarizeGuideChannel(channel),
      guideRoute: `Mail, calendar and channels, Channels: select ${channel.label}, "what it needs"`,
      modelRoute: channelGuideModelRoute(channel.id),
    })),
    steps,
    routes: {
      readiness: 'Mail, calendar and channels, Channels: "which are set up"',
      attention: 'Mail, calendar and channels, Channels: "which are set up"',
      accounts: 'Mail, calendar and channels, Channels: "accounts"',
      policies: 'Mail, calendar and channels, Channels: "who may write"',
      status: 'Mail, calendar and channels, Channels',
    },
    policy: 'Read-only channel setup guide. Credentials stay in secret-backed settings or the owning GoodVibes host, and delivery tests require explicit confirmed user action.',
  };
}
