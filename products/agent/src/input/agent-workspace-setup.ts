import type { AgentBehaviorDiscoverySummary } from '../agent/behavior-discovery-summary.ts';
import { agentWorkspaceHostSetupReading, type AgentWorkspaceHostSetupReading } from './agent-workspace-setup-host-status.ts';

export type AgentWorkspaceSetupStatus = 'ready' | 'recommended' | 'optional' | 'blocked';

export interface AgentWorkspaceSetupChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly status: AgentWorkspaceSetupStatus;
  readonly detail: string;
  readonly breadcrumb?: string;
}

export interface AgentWorkspaceSetupChecklistInput {
  readonly provider: string;
  readonly model: string;
  readonly runtimeBaseUrl: string;
  readonly connectedHostTokenPresent: boolean;
  readonly connectedHostTokenReadable: boolean;
  readonly connectedHostTokenPath: string;
  /** The host reading to use; defaults to the session's held reading for `runtimeBaseUrl` and the credential path. */
  readonly hostReading?: AgentWorkspaceHostSetupReading;
  readonly connectedHostTokenError?: string | null;
  /** True when no Agent home directory is known, so no token file could be looked for at all. */
  readonly agentHomeUnavailable?: boolean;
  /** Checklist item ids whose local store could not be read; their counts are unknown, not zero. */
  readonly unreadableItemIds?: readonly string[];
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly availableSubscriptionProviderCount: number;
  readonly sessionMemoryCount: number;
  readonly localMemoryCount: number;
  readonly localMemoryReviewQueueCount: number;
  readonly localNoteCount: number;
  readonly localNoteReviewQueueCount: number;
  readonly routineCount: number;
  readonly enabledRoutineCount: number;
  readonly missingRoutineRequirementCount: number;
  readonly skillCount: number;
  readonly enabledSkillCount: number;
  readonly skillBundleCount: number;
  readonly enabledSkillBundleCount: number;
  readonly missingSkillRequirementCount: number;
  readonly activePersonaName: string;
  readonly discoveredPersonas: AgentBehaviorDiscoverySummary;
  readonly discoveredSkills: AgentBehaviorDiscoverySummary;
  readonly discoveredRoutines: AgentBehaviorDiscoverySummary;
  readonly readyChannelCount: number;
  readonly voiceProviderCount: number;
  readonly mediaProviderCount: number;
  readonly runtimeProfileCount: number;
  readonly runtimeStarterTemplateCount: number;
}

function setupStatusForCount(count: number, ready: AgentWorkspaceSetupStatus, empty: AgentWorkspaceSetupStatus): AgentWorkspaceSetupStatus {
  return count > 0 ? ready : empty;
}

function sampleNames(summary: AgentBehaviorDiscoverySummary): string {
  if (summary.names.length === 0) return '';
  const suffix = summary.count > summary.names.length ? `, +${summary.count - summary.names.length} more` : '';
  return ` Found: ${summary.names.join(', ')}${suffix}.`;
}

export function buildAgentWorkspaceSetupChecklist(input: AgentWorkspaceSetupChecklistInput): readonly AgentWorkspaceSetupChecklistItem[] {
  const unreadable = new Set(input.unreadableItemIds ?? []);
  return buildChecklistItems(input).map((item) => (unreadable.has(item.id)
    ? {
      ...item,
      status: 'recommended' as const,
      detail: `Could not read the local ${item.label.toLowerCase()} store, so what it holds is unknown. Check it before creating new records.`,
    }
    : item));
}

interface HostSetupItems {
  readonly runtime: Pick<AgentWorkspaceSetupChecklistItem, 'status' | 'detail'>;
  readonly auth: Pick<AgentWorkspaceSetupChecklistItem, 'status' | 'detail'>;
  readonly knowledge: Pick<AgentWorkspaceSetupChecklistItem, 'status' | 'detail'>;
}

/** The two host steps and Agent Knowledge, from the session's reading of the host. */
function hostSetupItems(input: AgentWorkspaceSetupChecklistInput, reading: AgentWorkspaceHostSetupReading): HostSetupItems {
  const checkAgain = 'Ctrl+R in this workspace checks again.';
  if (reading.state === 'checking') {
    const detail = `Checking the connected host at ${input.runtimeBaseUrl}...`;
    return {
      runtime: { status: 'recommended', detail },
      auth: { status: 'recommended', detail },
      knowledge: { status: 'optional', detail: 'Agent Knowledge lives on the connected host; its state follows the host check.' },
    };
  }
  const at = ` Checked ${new Date(reading.checkedAt).toLocaleTimeString()}. ${checkAgain}`;
  if (!reading.reachable && !reading.credentialPresent) {
    // The Agent used on its own: nothing to repair, host features are optional.
    return {
      runtime: { status: 'optional', detail: `${reading.detail} Start goodvibes-daemon when you want host features (schedules, channels, Agent Knowledge).${at}` },
      auth: { status: 'optional', detail: `Needed only with a connected host.${at}` },
      knowledge: { status: 'optional', detail: 'Agent Knowledge needs the connected host.' },
    };
  }
  if (!reading.reachable) {
    // A credential says a host was paired, but the Agent still works without
    // it, so a host that is down is a recommendation, not a blocker.
    return {
      runtime: { status: 'recommended', detail: `${reading.detail} Start goodvibes-daemon, or check daemon.connectedHost.url (for the daemon on this machine, controlPlane.host and controlPlane.port).${at}` },
      auth: { status: 'recommended', detail: `Not checked: the host did not answer.${at}` },
      knowledge: { status: 'optional', detail: 'Agent Knowledge needs the connected host.' },
    };
  }
  if (reading.credentialAccepted === null) {
    // The host answered but not with its status (another version, a server error):
    // the reading's own message names the next step, and re-pairing would not help.
    return {
      runtime: { status: 'recommended', detail: `${reading.detail}${at}` },
      auth: { status: 'recommended', detail: `Not checked: the host did not answer the status read.${at}` },
      knowledge: { status: 'optional', detail: 'Agent Knowledge needs the connected host.' },
    };
  }
  if (!reading.credentialAccepted) {
    return {
      runtime: { status: 'ready', detail: `A host answers at ${input.runtimeBaseUrl}.${at}` },
      auth: {
        status: 'blocked',
        detail: reading.credentialPresent
          ? `${reading.detail} Run goodvibes-agent setup pair --apply to get a fresh credential.${at}`
          : `${reading.detail} Run goodvibes-agent setup pair --apply to pair this Agent with the host (the credential goes to ${input.connectedHostTokenPath}).${at}`,
      },
      knowledge: { status: 'optional', detail: 'Agent Knowledge needs an accepted host credential.' },
    };
  }
  return {
    runtime: { status: 'ready', detail: `${reading.detail}${at}` },
    auth: { status: 'ready', detail: `The host accepted this Agent's credential.${at}` },
    knowledge: { status: 'optional', detail: 'Ingest source-backed material into the isolated Agent Knowledge segment when you want it (Knowledge).' },
  };
}

function buildChecklistItems(input: AgentWorkspaceSetupChecklistInput): readonly AgentWorkspaceSetupChecklistItem[] {
  const providerReady = input.provider !== 'unknown' && input.model !== 'unknown';
  const host = hostSetupItems(input, input.hostReading ?? agentWorkspaceHostSetupReading(input.runtimeBaseUrl, input.connectedHostTokenPath));
  const hasActivePersona = input.activePersonaName !== '(none)' && input.activePersonaName !== '(unavailable)';
  const discoveredBehaviorCount = input.discoveredPersonas.count + input.discoveredSkills.count + input.discoveredRoutines.count;
  return [
    {
      id: 'runtime',
      label: 'Connected host',
      ...host.runtime,
      breadcrumb: 'Connected Host',
    },
    {
      id: 'connected-host-auth',
      label: 'Connected-host auth',
      ...host.auth,
      breadcrumb: 'Connected Host',
    },
    {
      id: 'provider-model',
      label: 'Provider and model',
      status: providerReady ? 'ready' : 'blocked',
      detail: providerReady
        ? `Current chat route is ${input.provider} / ${input.model}.`
        : 'Choose a provider and model before relying on assistant turns.',
      breadcrumb: 'Start -> Choose main model',
    },
    {
      id: 'subscriptions',
      label: 'Provider subscriptions',
      status: input.activeSubscriptionCount > 0
        ? 'ready'
        : input.pendingSubscriptionCount > 0
          ? 'recommended'
          : input.availableSubscriptionProviderCount > 0 ? 'recommended' : 'optional',
      detail: input.activeSubscriptionCount > 0
        ? `${input.activeSubscriptionCount} provider subscription session(s) are active.`
        : input.pendingSubscriptionCount > 0
          ? `${input.pendingSubscriptionCount} provider subscription login(s) are pending completion.`
          : input.availableSubscriptionProviderCount > 0
            ? `${input.availableSubscriptionProviderCount} subscription-capable provider(s) are available. Start login if you want subscription routing.`
            : 'No subscription-capable providers are available yet. Use API keys or add an OAuth provider service.',
      breadcrumb: 'Start -> Sign in to a provider',
    },
    {
      id: 'agent-knowledge',
      label: 'Agent Knowledge',
      ...host.knowledge,
      breadcrumb: 'Knowledge',
    },
    {
      id: 'profile',
      label: 'Agent profile',
      status: input.runtimeProfileCount > 0 ? 'ready' : discoveredBehaviorCount > 0 ? 'recommended' : 'optional',
      detail: input.runtimeProfileCount > 0
        ? `${input.runtimeProfileCount} isolated Agent profile(s) are available.`
        : discoveredBehaviorCount > 0
          ? `${discoveredBehaviorCount} discovered behavior file(s) can seed an isolated Agent profile from Agent homes.`
        : `${input.runtimeStarterTemplateCount} starter template(s) are available if this machine needs separate operator identities.`,
      breadcrumb: 'Agent homes',
    },
    {
      id: 'persona',
      label: 'Persona',
      status: hasActivePersona ? 'ready' : 'recommended',
      detail: hasActivePersona
        ? `Active persona: ${input.activePersonaName}.${input.discoveredPersonas.count > 0 ? ` ${input.discoveredPersonas.count} discovered persona file(s) are still available to import.` : ''}`
        : input.discoveredPersonas.count > 0
          ? `${input.discoveredPersonas.count} discovered persona file(s) can be imported into the Agent-local registry.${sampleNames(input.discoveredPersonas)}`
          : 'Create or choose a persona to make the assistant voice and policy explicit.',
      breadcrumb: 'How it talks',
    },
    {
      id: 'skills',
      label: 'Skills',
      status: input.missingSkillRequirementCount > 0
        ? 'recommended'
        : input.enabledSkillCount > 0 || input.enabledSkillBundleCount > 0
          ? 'ready'
          : input.skillCount > 0 || input.skillBundleCount > 0 || input.discoveredSkills.count > 0
            ? 'recommended'
            : 'optional',
      detail: input.skillCount > 0 || input.skillBundleCount > 0
        ? `${input.enabledSkillCount}/${input.skillCount} local skill(s) enabled; ${input.enabledSkillBundleCount}/${input.skillBundleCount} bundle(s) enabled.${input.missingSkillRequirementCount > 0 ? ` ${input.missingSkillRequirementCount} missing setup requirement(s).` : ''}${input.discoveredSkills.count > 0 ? ` ${input.discoveredSkills.count} discovered skill file(s) are still available to import.` : ''}`
        : input.discoveredSkills.count > 0
          ? `${input.discoveredSkills.count} discovered skill file(s) can be imported as local reusable procedures.${sampleNames(input.discoveredSkills)}`
          : 'Create reusable local skills and bundles for repeated workflows.',
      breadcrumb: 'Procedures',
    },
    {
      id: 'routines',
      label: 'Routines',
      status: input.missingRoutineRequirementCount > 0
        ? 'recommended'
        : setupStatusForCount(input.enabledRoutineCount, 'ready', input.routineCount > 0 || input.discoveredRoutines.count > 0 ? 'recommended' : 'optional'),
      detail: input.routineCount > 0
        ? `${input.enabledRoutineCount}/${input.routineCount} local routine(s) enabled.${input.missingRoutineRequirementCount > 0 ? ` ${input.missingRoutineRequirementCount} missing setup requirement(s).` : ''}${input.discoveredRoutines.count > 0 ? ` ${input.discoveredRoutines.count} discovered routine file(s) are still available to import.` : ''}`
        : input.discoveredRoutines.count > 0
          ? `${input.discoveredRoutines.count} discovered routine file(s) can be imported as main-conversation workflows.${sampleNames(input.discoveredRoutines)}`
          : 'Create local routines first; promote schedules only with explicit confirmation.',
      breadcrumb: 'Saved workflows',
    },
    {
      id: 'memory',
      label: 'Local memory',
      status: setupStatusForCount(input.localMemoryCount, 'ready', 'optional'),
      detail: input.localMemoryCount > 0
        ? `${input.localMemoryCount} Agent memory record(s) are available; review queue holds ${input.localMemoryReviewQueueCount}.`
        : 'Memory starts empty; durable facts should be stored deliberately and never include secrets.',
      breadcrumb: 'Memory',
    },
    {
      id: 'notes',
      label: 'Scratchpad notes',
      status: setupStatusForCount(input.localNoteCount, 'ready', 'optional'),
      detail: input.localNoteCount > 0
        ? `${input.localNoteCount} Agent scratchpad note(s) are available; ${input.localNoteReviewQueueCount} need review.`
        : 'Notes start empty; use them for source triage, temporary decisions, and handoff before promoting anything durable.',
      breadcrumb: 'Notes',
    },
    {
      id: 'channels',
      label: 'Channels',
      status: setupStatusForCount(input.readyChannelCount, 'ready', 'optional'),
      detail: input.readyChannelCount > 0
        ? `${input.readyChannelCount} external channel(s) are ready.`
        : 'Pair or review channels only when you want the assistant reachable outside this terminal.',
      breadcrumb: 'Messaging',
    },
    {
      id: 'voice-media',
      label: 'Voice and media',
      status: input.voiceProviderCount > 0 || input.mediaProviderCount > 0 ? 'ready' : 'optional',
      detail: `${input.voiceProviderCount} voice provider(s), ${input.mediaProviderCount} media provider(s). Configure these only when useful.`,
      breadcrumb: 'Voice & Media',
    },
  ];
}
