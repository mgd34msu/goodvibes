/**
 * Store domain factories: every initial state starts at revision 0 from the
 * 'init' source, and no two calls share a mutable collection (a shared Map or
 * array would leak one store's data into the next).
 */

import { describe, expect, test } from 'bun:test';
import { createInitialAcpState } from '../platform/src/platform/runtime/store/domains/acp.js';
import { createInitialAgentsState } from '../platform/src/platform/runtime/store/domains/agents.js';
import { createInitialAutomationState } from '../platform/src/platform/runtime/store/domains/automation.js';
import { createInitialContractsState } from '../platform/src/platform/runtime/store/domains/contracts.js';
import { createInitialConversationState } from '../platform/src/platform/runtime/store/domains/conversation.js';
import { createInitialDaemonState } from '../platform/src/platform/runtime/store/domains/daemon.js';
import { createInitialDiscoveryState } from '../platform/src/platform/runtime/store/domains/discovery.js';
import { createInitialGitState } from '../platform/src/platform/runtime/store/domains/git.js';
import { createInitialIntelligenceState } from '../platform/src/platform/runtime/store/domains/intelligence.js';
import { createInitialMcpState } from '../platform/src/platform/runtime/store/domains/mcp.js';
import { createInitialModelState } from '../platform/src/platform/runtime/store/domains/model.js';
import { createInitialPermissionsState } from '../platform/src/platform/runtime/store/domains/permissions.js';
import { createInitialSessionState } from '../platform/src/platform/runtime/store/domains/session.js';
import { createInitialTasksState } from '../platform/src/platform/runtime/store/domains/tasks.js';

const factories: ReadonlyArray<readonly [string, () => object]> = [
  ['acp', createInitialAcpState],
  ['agents', createInitialAgentsState],
  ['automation', createInitialAutomationState],
  ['contracts', createInitialContractsState],
  ['conversation', createInitialConversationState],
  ['daemon', createInitialDaemonState],
  ['discovery', createInitialDiscoveryState],
  ['git', createInitialGitState],
  ['intelligence', createInitialIntelligenceState],
  ['mcp', createInitialMcpState],
  ['model', createInitialModelState],
  ['permissions', createInitialPermissionsState],
  ['session', createInitialSessionState],
  ['tasks', createInitialTasksState],
];

/** Every Map, Set and array reachable from the state, one level of plain objects deep. */
function collections(value: object): object[] {
  const found: object[] = [];
  for (const entry of Object.values(value)) {
    if (entry instanceof Map || entry instanceof Set || Array.isArray(entry)) found.push(entry);
    else if (entry !== null && typeof entry === 'object') found.push(...collections(entry));
  }
  return found;
}

describe('platform/runtime/store/domains: initial state', () => {
  for (const [name, create] of factories) {
    test(`${name} starts at revision 0 from the init source and shares no collection between calls`, () => {
      const first = create() as Record<string, unknown>;
      expect(first['revision']).toBe(0);
      expect(first['lastUpdatedAt']).toBe(0);
      expect(first['source']).toBe('init');

      const firstCollections = collections(first);
      const secondCollections = new Set(collections(create()));
      for (const collection of firstCollections) expect(secondCollections.has(collection)).toBe(false);
    });
  }

  test('conversation begins idle with no turn, and tasks and agents begin empty', () => {
    expect(createInitialConversationState()).toMatchObject({ turnState: 'idle', totalTurns: 0, currentTurnId: undefined });
    expect(createInitialAgentsState()).toMatchObject({ activeAgentIds: [], totalSpawned: 0, peakConcurrency: 0 });
    expect(createInitialAgentsState().agents.size).toBe(0);
    expect(createInitialTasksState()).toMatchObject({ queuedIds: [], runningIds: [], blockedIds: [], totalCreated: 0 });
    expect(createInitialContractsState()).toMatchObject({ activeContractIds: [], totalContracts: 0, spawnGuardTrips: 0 });
  });
});
