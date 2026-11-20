import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import type { CommandContext } from './command-registry.ts';
import { listSetupSmokeEvidence } from '../agent/setup-smoke-evidence.ts';
import { isOnboardingComplete } from '../runtime/onboarding/completion.ts';
import { DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE, buildAgentSetupWizard, emptyAgentSetupSmokeHistory, type AgentSetupWizard, type AgentSetupWizardBlockedCheckFrequency, type AgentSetupWizardSmokeHistory, type AgentSetupWizardSourceItem } from '../agent/setup-wizard.ts';
import type { AgentWorkspaceSetupChecklistItem } from './agent-workspace-setup.ts';
import { readArtifactMetadataString, readArtifactMetadataStringList } from './agent-workspace-artifact-metadata.ts';

function setupSmokeEvidenceScore(artifact: ArtifactDescriptor): number {
  const result = readArtifactMetadataString(artifact.metadata, 'result');
  if (result === 'passed') return 3;
  if (result === 'ready-for-user-run') return 2;
  if (result === 'blocked') return 0;
  return 1;
}

function setupSmokeEvidenceTrend(artifacts: readonly ArtifactDescriptor[]): string {
  if (artifacts.length === 0) return 'none';
  if (artifacts.length === 1) return 'first-run';
  const latest = setupSmokeEvidenceScore(artifacts[0]!);
  const previous = setupSmokeEvidenceScore(artifacts[1]!);
  if (latest > previous) return 'improving';
  if (latest < previous) return 'regressing';
  const result = readArtifactMetadataString(artifacts[0]!.metadata, 'result');
  if (result === 'passed') return 'unchanged-passed';
  if (result === 'ready-for-user-run') return 'unchanged-ready';
  if (result === 'blocked') return 'unchanged-blocked';
  return 'unchanged';
}

function artifactCreatedAtIso(artifact: ArtifactDescriptor): string | null {
  const createdAt = artifact.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  return new Date(createdAt).toISOString();
}

function setupSmokeBlockedCheckFrequency(artifacts: readonly ArtifactDescriptor[]): readonly AgentSetupWizardBlockedCheckFrequency[] {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    for (const checkId of readArtifactMetadataStringList(artifact.metadata, 'blockedChecks')) {
      counts.set(checkId, (counts.get(checkId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([checkId, count]) => ({ checkId, count }));
}

/** Only the runs the setup smoke tool recorded count; an artifact's own metadata never makes it smoke evidence. */
export function buildSetupSmokeHistory(context: CommandContext): AgentSetupWizardSmokeHistory {
  const listed = listSetupSmokeEvidence(context.workspace?.shellPaths, context.platform?.artifactStore);
  if (listed.status === 'unavailable') {
    return {
      ...emptyAgentSetupSmokeHistory(listed.reason),
      status: 'unavailable',
    };
  }
  const setupSmokeArtifacts = listed.artifacts;
  if (setupSmokeArtifacts.length === 0) return emptyAgentSetupSmokeHistory();
  const resultCounts = setupSmokeArtifacts.reduce<Record<string, number>>((counts, artifact) => {
    const result = readArtifactMetadataString(artifact.metadata, 'result') || 'unknown';
    counts[result] = (counts[result] ?? 0) + 1;
    return counts;
  }, {});
  const latest = setupSmokeArtifacts[0]!;
  const previous = setupSmokeArtifacts[1] ?? null;
  return {
    status: 'available',
    total: setupSmokeArtifacts.length,
    trend: setupSmokeEvidenceTrend(setupSmokeArtifacts),
    latestResult: readArtifactMetadataString(latest.metadata, 'result') || 'unknown',
    previousResult: previous ? readArtifactMetadataString(previous.metadata, 'result') || 'unknown' : null,
    latestEvidenceId: latest.id,
    latestEvidenceAt: artifactCreatedAtIso(latest),
    resultCounts,
    blockedCheckFrequency: setupSmokeBlockedCheckFrequency(setupSmokeArtifacts),
    inspectLatestRoute: `agent_artifacts mode:"show" artifactId:"${latest.id}" includeContent:false`,
    rerunRoute: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
    saveRoute: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
  };
}

function setupChecklistUserRoute(item: AgentWorkspaceSetupChecklistItem): string {
  return item.breadcrumb ?? 'Start';
}

function setupChecklistModelRoute(item: AgentWorkspaceSetupChecklistItem): string {
  if (item.id === 'runtime') return 'agent_harness mode:"setup_item" setupItemId:"connected-host-readiness"';
  if (item.id === 'provider-model') return 'models action:"status"';
  if (item.id === 'subscriptions') return 'models action:"providers"';
  if (item.id === 'agent-knowledge') return 'agent_knowledge mode:"status"';
  if (item.id === 'profile') return 'agent_harness mode:"workspace_action" actionId:"profile-template-show"';
  if (item.id === 'persona') return 'agent_harness mode:"workspace" target:"personas"';
  if (item.id === 'skills') return 'agent_harness mode:"workspace" target:"skills"';
  if (item.id === 'routines') return 'agent_harness mode:"workspace" target:"routines"';
  if (item.id === 'memory') return 'memory action:"status"';
  if (item.id === 'notes') return 'personal_ops action:"lane" laneId:"notes"';
  if (item.id === 'channels') return 'channels action:"status"';
  if (item.id === 'voice-media') return 'device action:"voice"';
  return `agent_harness mode:"setup_item" setupItemId:"${item.id}"`;
}

function setupChecklistActionId(item: AgentWorkspaceSetupChecklistItem): string {
  if (item.id === 'provider-model') return 'setup-provider-model';
  if (item.id === 'subscriptions') return 'subscription-login-start';
  if (item.id === 'agent-knowledge') return 'knowledge-status';
  if (item.id === 'profile') return 'profile-template-show';
  if (item.id === 'persona') return 'persona-search';
  if (item.id === 'skills') return 'skill-search';
  if (item.id === 'routines') return 'routine-search';
  if (item.id === 'channels') return 'channel-show';
  if (item.id === 'voice-media') return 'voice-enable';
  return item.id;
}

const SETUP_WIZARD_SNAPSHOT_BLOCKER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'agent-binary': ['runtime'],
  'connected-host-status': ['runtime'],
  'connected-host-auth': ['connected-host-auth'],
  'provider-model': ['provider-model'],
};

export function buildWorkspaceSetupWizard(
  checklist: readonly AgentWorkspaceSetupChecklistItem[],
  smokeHistory: AgentSetupWizardSmokeHistory,
  setupMarkerExists: boolean,
): AgentSetupWizard {
  const items: AgentSetupWizardSourceItem[] = checklist.map((item) => ({
    id: item.id,
    label: item.label,
    status: item.status,
    detail: item.detail,
    userRoute: setupChecklistUserRoute(item),
    modelRoute: setupChecklistModelRoute(item),
    actionId: setupChecklistActionId(item),
  }));
  return buildAgentSetupWizard({
    items,
    smokeHistory,
    closeoutCriticalStepIds: ['runtime', 'connected-host-auth', 'provider-model'],
    // Only the setup smoke saves evidence; the runtime and auth steps are decided by their live checks.
    receiptRequiredStepIds: ['install-smoke'],
    setupMarkerExists,
    repeatedBlockerAliases: SETUP_WIZARD_SNAPSHOT_BLOCKER_ALIASES,
  });
}

export function setupCompletionMarkerExists(context: CommandContext): boolean {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths || typeof shellPaths.resolveUserPath !== 'function') return false;
  try {
    return isOnboardingComplete(shellPaths);
  } catch {
    return false;
  }
}
