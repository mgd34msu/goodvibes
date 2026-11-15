import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { skillStorePath } from '../../agent/skill-registry.ts';
import { buildAgentWorkspaceSetupChecklist, type AgentWorkspaceSetupChecklistInput } from '../../input/agent-workspace-setup.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../../input/agent-workspace-snapshot.ts';
import { buildReviewPacketDefaults } from '../../input/agent-workspace-review-packet-snapshot.ts';
import { reviewPacketPresetFreshness } from '../../input/agent-workspace-review-packet-utils.ts';
import { buildAgentWorkspaceVoiceMediaReadiness } from '../../input/agent-workspace-voice-media.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function artifact(id: string, createdAt: number, metadata: Record<string, unknown>): ArtifactDescriptor {
  return {
    id,
    kind: 'data',
    mimeType: 'application/json',
    filename: `${id}.json`,
    sizeBytes: 1,
    sha256: `sha-${id}`,
    createdAt,
    acquisitionMode: 'inline-data',
    fetchMode: 'not-applicable',
    metadata,
  };
}

function shellContext(extra: Record<string, unknown> = {}): { context: CommandContext; shellPaths: ReturnType<typeof createShellPathService> } {
  const root = makeProjectTempDir('goodvibes-agent-snapshot-reads');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const context = {
    executeCommand: async () => true,
    print: () => {},
    workspace: { shellPaths },
    ...extra,
  } as unknown as CommandContext;
  return { context, shellPaths };
}

describe('an unreadable store is not reported as an empty one', () => {
  test('a corrupt skill registry produces a warning and keeps the Skills item from saying "create"', () => {
    const { context, shellPaths } = shellContext();
    const path = skillStorePath(shellPaths);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');

    const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);

    expect(snapshot.warnings.some((warning) => warning.startsWith('Could not read skills'))).toBe(true);
    const item = snapshot.setupChecklist.find((entry) => entry.id === 'skills');
    expect(item?.status).toBe('recommended');
    expect(item?.detail).toContain('Could not read');
    expect(item?.detail).not.toContain('Create reusable');
  });

  test('a healthy empty store adds no warning and still says to create skills', () => {
    const { context } = shellContext();
    const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    expect(snapshot.warnings.some((warning) => warning.startsWith('Could not read'))).toBe(false);
    expect(snapshot.setupChecklist.find((entry) => entry.id === 'skills')?.status).toBe('optional');
  });

  test('a settings read that throws is named, and its value is labelled a default', () => {
    const { context } = shellContext({
      platform: {
        configManager: {
          get: (key: string) => {
            if (key === 'behavior.autoApprove') throw new Error('settings store unreadable');
            return undefined;
          },
        },
      },
    });
    const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    const warning = snapshot.warnings.find((entry) => entry.includes('behavior.autoApprove'));
    expect(warning).toContain('defaults');
    expect(snapshot.autoApprove).toBe(false);
  });

  test('a missing config manager is simply unconfigured and adds no settings warning', () => {
    const { context } = shellContext();
    const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    expect(snapshot.warnings.some((entry) => entry.includes('setting(s)'))).toBe(false);
  });
});

describe('artifact list window', () => {
  const presetMetadata = { purpose: 'agent-review-packet-preset', documentExportArtifactId: 'old-export' };
  const oldExport = artifact('old-export', 1, { purpose: 'agent-document-export', documentId: 'doc-1' });

  test('a preset reference older than the listed window is looked up by id, not counted missing', () => {
    const preset = artifact('preset', 500, presetMetadata);
    const listed = [preset];
    expect(reviewPacketPresetFreshness(preset, listed).missingCount).toBe(1);
    expect(reviewPacketPresetFreshness(preset, listed, (id) => (id === 'old-export' ? oldExport : null)).missingCount).toBe(0);
  });

  test('a full artifact page marks readiness unverified instead of ready', () => {
    const listed = Array.from({ length: 100 }, (_, index) => artifact(`filler-${index}`, 1000 + index, { purpose: 'other' }));
    const { context } = shellContext({
      platform: { artifactStore: { list: () => listed, get: () => null } },
    });
    const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    expect(snapshot.reviewerReadinessBadge.status).toBe('attention');
    expect(snapshot.reviewerReadinessBadge.next).toContain('Unverified');
  });

  test('a short artifact page with no issues is still ready', () => {
    const listed = [artifact('filler', 1000, { purpose: 'other' })];
    const { context } = shellContext({
      platform: { artifactStore: { list: () => listed, get: () => null } },
    });
    expect(buildAgentWorkspaceRuntimeSnapshot(context).reviewerReadinessBadge.status).toBe('ready');
  });
});

describe('review packet defaults follow one comparison', () => {
  const comparison = (id: string, createdAt: number, comparisonId: string) =>
    artifact(id, createdAt, { purpose: 'agent-model-compare', comparisonId });
  const revealedJudgment = (id: string, createdAt: number, comparisonId: string) =>
    artifact(id, createdAt, { purpose: 'agent-model-compare-judgment', comparisonId, revealIncludedInJudgment: true, winnerModel: 'm' });
  const handoff = (id: string, createdAt: number, comparisonId: string) =>
    artifact(id, createdAt, { purpose: 'agent-model-compare-handoff', comparisonId });

  test('a newer comparison does not inherit the older comparison judgment or handoff', () => {
    const defaults = buildReviewPacketDefaults([], [
      comparison('cmp-a', 10, 'A'),
      revealedJudgment('judge-a', 11, 'A'),
      handoff('handoff-a', 12, 'A'),
      comparison('cmp-b', 20, 'B'),
    ]);
    expect(defaults.comparisonArtifactId).toBe('cmp-b');
    expect(defaults.revealedJudgmentArtifactId).toBeNull();
    expect(defaults.handoffArtifactId).toBeNull();
  });

  test('the judgment and handoff of the newest comparison are chosen together', () => {
    const defaults = buildReviewPacketDefaults([], [
      comparison('cmp-a', 10, 'A'),
      revealedJudgment('judge-a', 11, 'A'),
      handoff('handoff-a', 12, 'A'),
      comparison('cmp-b', 20, 'B'),
      revealedJudgment('judge-b', 21, 'B'),
    ]);
    expect(defaults.revealedJudgmentArtifactId).toBe('judge-b');
    expect(defaults.handoffArtifactId).toBeNull();
  });

  test('a route decision with no revealed judgment is not offered', () => {
    const defaults = buildReviewPacketDefaults([], [
      comparison('cmp-a', 10, 'A'),
      artifact('route-a', 11, { purpose: 'agent-model-compare-route-decision', comparisonId: 'A', judgmentArtifactId: 'gone' }),
    ]);
    expect(defaults.routeDecisionArtifactId).toBeNull();
  });
});

describe('route decisions saved before purpose was recorded', () => {
  test('a filename-only route decision is offered for its revealed judgment', () => {
    const legacyDecision = { ...artifact('route-a', 12, { comparisonId: 'A', judgmentArtifactId: 'judge-a' }), filename: 'blind-model-comparison-route-decision-1.json' };
    const defaults = buildReviewPacketDefaults([], [
      artifact('cmp-a', 10, { purpose: 'agent-model-compare', comparisonId: 'A' }),
      artifact('judge-a', 11, { purpose: 'agent-model-compare-judgment', comparisonId: 'A', revealIncludedInJudgment: true, winnerModel: 'm' }),
      legacyDecision,
    ]);
    expect(defaults.routeDecisionArtifactId).toBe('route-a');
  });
});

describe('setup checklist inputs', () => {
  function checklistInput(overrides: Partial<AgentWorkspaceSetupChecklistInput>): AgentWorkspaceSetupChecklistInput {
    const empty = { count: 0, names: [] } as unknown as AgentWorkspaceSetupChecklistInput['discoveredPersonas'];
    return {
      provider: 'p', model: 'm', runtimeBaseUrl: 'http://127.0.0.1:3421',
      connectedHostTokenPresent: false, connectedHostTokenReadable: false, connectedHostTokenPath: '/some/path',
      activeSubscriptionCount: 0, pendingSubscriptionCount: 0, availableSubscriptionProviderCount: 0,
      sessionMemoryCount: 0, localMemoryCount: 0, localMemoryReviewQueueCount: 0, localNoteCount: 0, localNoteReviewQueueCount: 0,
      routineCount: 0, enabledRoutineCount: 0, missingRoutineRequirementCount: 0,
      skillCount: 0, enabledSkillCount: 0, skillBundleCount: 0, enabledSkillBundleCount: 0, missingSkillRequirementCount: 0,
      activePersonaName: '(none)', discoveredPersonas: empty, discoveredSkills: empty, discoveredRoutines: empty,
      readyChannelCount: 0, voiceProviderCount: 0, mediaProviderCount: 0, runtimeProfileCount: 0, runtimeStarterTemplateCount: 0,
      ...overrides,
    };
  }
  const authStatus = (input: AgentWorkspaceSetupChecklistInput) =>
    buildAgentWorkspaceSetupChecklist(input).find((item) => item.id === 'connected-host-auth')?.status;

  test('connected-host auth is recommended only when no Agent home exists, whatever the path text says', () => {
    expect(authStatus(checklistInput({ agentHomeUnavailable: true }))).toBe('recommended');
    expect(authStatus(checklistInput({ connectedHostTokenPath: '(Agent home unavailable)' }))).toBe('blocked');
  });
});

describe('voice and media readiness source', () => {
  test('a key found only in this Agent environment is not presented as verified for the connected host', () => {
    const previous = process.env.DEEPGRAM_API_KEY;
    process.env.DEEPGRAM_API_KEY = 'present';
    try {
      const { context } = shellContext({ platform: { configManager: { get: () => undefined } } });
      const readiness = buildAgentWorkspaceVoiceMediaReadiness({
        context,
        voiceProviders: [{ id: 'deepgram', capabilities: ['stt'] }],
        mediaProviders: [],
      });
      const status = readiness.voiceProviders[0];
      expect(status?.setupState).toBe('ready-agent-env');
      expect(readiness.readyVoiceProviderCount).toBe(0);
      expect(status?.nextStep).toContain('this Agent environment');
      expect(status?.nextStep).toContain('not checked');
    } finally {
      if (previous === undefined) delete process.env.DEEPGRAM_API_KEY;
      else process.env.DEEPGRAM_API_KEY = previous;
    }
  });
});
