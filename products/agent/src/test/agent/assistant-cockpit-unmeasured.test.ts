/**
 * assistant-cockpit-unmeasured.test.ts, the workspace-snapshot cockpit does not
 * report lanes it has no data for as healthy.
 */

import { describe, expect, test } from 'bun:test';
import { buildAssistantCockpitFromMetrics, buildAssistantCockpitFromSummaries } from '../../agent/assistant-cockpit.ts';

describe('assistant cockpit lanes', () => {
  test('lanes a caller marked unmeasured say so', () => {
    const cockpit = buildAssistantCockpitFromMetrics({
      setupBlockers: 0, modelStatus: 'ready', executionRoutes: 1, personalGaps: 0, runningWork: 0,
      researchRuns: 0, documentLanes: 7, documentGaps: 0, securityFindings: 0,
      unmeasured: ['work-and-files', 'background-work'],
    });

    const summary = (id: string) => cockpit.lanes.find((lane) => lane.id === id)!.summary;
    expect(summary('work-and-files')).toStartWith('Not measured in this view;');
    expect(summary('background-work')).toStartWith('Not measured in this view;');
    expect(summary('safety-and-recovery')).not.toContain('Not measured');
    const state = (id: string) => cockpit.lanes.find((lane) => lane.id === id)!.state;
    expect(state('work-and-files')).toBe('unmeasured');
    expect(state('background-work')).toBe('unmeasured');
    expect(state('safety-and-recovery')).toBe('ready');
  });

  test('a measured problem in a lane is not hidden by the unmeasured list', () => {
    const cockpit = buildAssistantCockpitFromMetrics({
      setupBlockers: 2, modelStatus: 'ready', executionRoutes: 1, personalGaps: 0, runningWork: 3,
      researchRuns: 3, documentLanes: 7, documentGaps: 0, securityFindings: 0,
      unmeasured: ['setup', 'work-and-files', 'background-work'],
    });

    const lane = (id: string) => cockpit.lanes.find((l) => l.id === id)!;
    expect(lane('setup').state).toBe('attention');
    expect(lane('setup').summary).toContain('2 setup blocker');
    expect(lane('background-work').state).toBe('attention');
    expect(lane('work-and-files').state).toBe('unmeasured');
  });

  test('the summaries path measures everything and marks nothing', () => {
    const cockpit = buildAssistantCockpitFromSummaries({
      setupPosture: {}, modelRouting: { status: 'ready' }, executionPosture: { routes: 3 }, personalOps: {},
      autonomyQueue: {}, researchRuns: {}, documentOps: { lanes: 7 }, securityPosture: {},
    });

    expect(cockpit.lanes.some((lane) => lane.summary.includes('Not measured'))).toBe(false);
  });
});
