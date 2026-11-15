import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/platform/platform/state';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createMemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { ForensicsRegistry } from '@/runtime/index.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { memoryReadingsPort } from '../helpers/memory-readings.ts';
import { nativeMemoryWorkPrivacy } from '../helpers/native-memory-work-readings.ts';

function makeRecallCommandContext(
  printed: string[],
  options: {
    memoryRegistry: MemoryRegistry;
    forensicsRegistry: ForensicsRegistry;
    policyRuntimeState?: PolicyRuntimeState;
    mcpRegistry?: CommandContext['extensions']['mcpRegistry'];
    shellPaths?: CommandContext['workspace']['shellPaths'];
  },
): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {} as never;
  return {
    session: {
      conversationManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-1',
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {
      shellPaths: options.shellPaths,
    },
    platform: {
      config: {} as never,
      configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: options.mcpRegistry ?? ({} as never),
      memoryRegistry: options.memoryRegistry,
      forensicsRegistry: options.forensicsRegistry,
      policyRuntimeState: options.policyRuntimeState,
    },
    clients: {
      agentKnowledgeApi: {
        memory: createMemoryApi(options.memoryRegistry),
      } as never,
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

describe('recallCommand', () => {
  let printed: string[];
  let forensicsRegistry: ForensicsRegistry;
  let policyRuntimeState: PolicyRuntimeState;
  // The real registry over a real store: promote, review and export are judged by what the registry did, not by a stand-in.
  let dir: string;
  let store: MemoryStore;
  let memoryRegistry: MemoryRegistry;
  let previousJudgment: ReturnType<typeof installJudgmentPort>;

  beforeEach(async () => {
    dir = makeProjectTempDir('gv-recall-command');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(dir, '.goodvibes', 'tui'), workingDir: dir });
    store = new MemoryStore(join(dir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    await store.init();
    memoryRegistry = new MemoryRegistry(store);
    previousJudgment = installJudgmentPort(nativeMemoryWorkPrivacy(memoryReadingsPort().port).port);
    printed = [];
    policyRuntimeState = new PolicyRuntimeState();
    forensicsRegistry = new ForensicsRegistry();
    forensicsRegistry.push({
      id: 'incident-1',
      traceId: 'trace-1',
      sessionId: 'session-1',
      generatedAt: Date.now(),
      classification: 'permission_denied',
      summary: 'permission denied write access',
      turnId: 'turn-1',
      taskId: 'task-1',
      phaseTimings: [],
        slowPhases: [],
      phaseLedger: [],
      causalChain: [],
      cascadeEvents: [],
      permissionEvidence: [],
      budgetBreaches: [],
      jumpLinks: [],
    });
  });

  afterEach(() => {
    installJudgmentPort(previousJudgment);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('refuses a generic default knowledge memory client', async () => {
    const context = {
      ...makeRecallCommandContext(printed, {
        memoryRegistry,
        forensicsRegistry,
      }),
      clients: {
        knowledgeApi: {
          memory: createMemoryApi(memoryRegistry),
        },
      },
    } as unknown as CommandContext;

    await recallCommand.handler(['list'], context);

    const output = printed.join('\n');
    expect(output).toContain('Agent Memory API is not available');
    expect(output).toContain('Refusing to use default knowledge or non-Agent knowledge fallback');
  });

  test('captures the latest incident into memory', async () => {
    await recallCommand.handler(['capture', 'incident', 'latest'], makeRecallCommandContext(printed, {
      memoryRegistry,
      forensicsRegistry,
    }));

    expect(printed.join('\n')).toContain('Captured incident incident-1 into memory');
    expect(memoryRegistry.getAll()).toHaveLength(1);
  });

  test('captures the latest policy preflight review into memory', async () => {
    policyRuntimeState.recordPreflightReview({
      generatedAt: new Date().toISOString(),
      status: 'warn',
      summary: '1 warning detected in the current policy posture.',
      issueCount: 1,
      issues: [
        {
          severity: 'warn',
          source: 'mcp',
          serverName: 'ops',
          message: 'Ops MCP server remains quarantined pending operator review.',
        },
      ],
    });

    await recallCommand.handler(['capture', 'policy'], makeRecallCommandContext(printed, {
      memoryRegistry,
      forensicsRegistry,
      policyRuntimeState,
      mcpRegistry: { listServerSecurity: () => [] } as never,
    }));

    expect(printed.join('\n')).toContain('Captured policy preflight into memory');
    expect(memoryRegistry.getAll()).toHaveLength(1);
  });

  test('captures MCP security posture into memory', async () => {
    await recallCommand.handler(['capture', 'mcp', 'ops'], makeRecallCommandContext(printed, {
      memoryRegistry,
      forensicsRegistry,
      mcpRegistry: {
        listServerSecurity: () => [{
          name: 'ops',
          role: 'ops',
          trustMode: 'allow-all',
          connected: false,
          allowedPaths: ['/srv'],
          allowedHosts: ['deploy.example.com'],
          schemaFreshness: 'quarantined',
          quarantineReason: 'operator_flagged',
          quarantineDetail: 'unexpected deploy surface',
        }],
      } as never,
    }));

    expect(printed.join('\n')).toContain('Captured MCP server ops into memory');
    expect(memoryRegistry.getAll()).toHaveLength(1);
  });

  test('promotes a record to team scope and exports a handoff bundle', async () => {
    const shared = await memoryRegistry.add({ cls: 'decision', summary: 'Share this', scope: 'project' });
    const id = shared.id;

    await recallCommand.handler(['promote', id, 'team'], makeRecallCommandContext(printed, {
      memoryRegistry,
      forensicsRegistry,
    }));

    expect(printed.join('\n')).toContain(`Refusing to promote durable memory record ${id} to team scope without --yes`);
    expect(memoryRegistry.get(id)?.scope).toBe('project');

    printed.length = 0;
    await recallCommand.handler(['promote', id, 'team', '--yes'], makeRecallCommandContext(printed, {
      memoryRegistry,
      forensicsRegistry,
    }));

    expect(printed.join('\n')).toContain(`Promoted ${id} to team scope`);
    expect(memoryRegistry.get(id)?.scope).toBe('team');

    const dir = makeProjectTempDir('gv-memory-handoff');
    const bundlePath = join(dir, 'team-handoff.json');
    const shellPaths = createShellPathService({
      workingDirectory: dir,
      homeDirectory: dir,
    });
    printed.length = 0;
    await recallCommand.handler(['handoff-export', bundlePath, '--scope', 'team'], makeRecallCommandContext(printed, {
      memoryRegistry,
      forensicsRegistry,
      shellPaths,
    }));
    expect(printed.join('\n')).toContain('Refusing to export memory handoff bundle');
    expect(existsSync(bundlePath)).toBe(false);

    printed.length = 0;
    await recallCommand.handler(['handoff-export', bundlePath, '--scope', 'team', '--yes'], makeRecallCommandContext(printed, {
      memoryRegistry,
      forensicsRegistry,
      shellPaths,
    }));
    expect(printed.join('\n')).toContain('Exported team handoff bundle');
    expect(existsSync(bundlePath)).toBe(true);
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as { scope: string; records: Array<{ id: string; scope: string }> };
    expect(bundle.scope).toBe('team');
    expect(bundle.records.map((record) => [record.id, record.scope])).toEqual([[id, 'team']]);
  });

  test('explains reviewed knowledge injection for a task and supports stale shortcuts', async () => {
    const runbook = await memoryRegistry.add({
      cls: 'runbook',
      summary: 'Deploy tasks should quarantine risky MCP schemas first.',
      tags: ['deploy', 'mcp'],
      review: { state: 'reviewed', confidence: 92 },
    });
    const { port, requests } = memoryReadingsPort({ relevance: (task, _scope, record) => {
      expect(task).toBe('deploy the release');
      expect(record.summary).toBe('Deploy tasks should quarantine risky MCP schemas first.');
      return { relevant: 0.99, taskMatch: 0.99, scopeMatch: 0.01 };
    } });
    const previous = installJudgmentPort(nativeMemoryWorkPrivacy(port).port);
    try {
      await recallCommand.handler(['explain', 'deploy', 'the', 'release'], makeRecallCommandContext(printed, {
        memoryRegistry,
        forensicsRegistry,
      }));

      expect(printed.join('\n')).toContain('Injected Project Knowledge');
      expect(printed.join('\n')).toContain('matched task');
      expect(requests.length).toBeGreaterThan(0);

      printed.length = 0;
      await recallCommand.handler(['stale', runbook.id, 'operator', 'revalidation', 'needed'], makeRecallCommandContext(printed, {
        memoryRegistry,
        forensicsRegistry,
      }));

      expect(printed.join('\n')).toContain(`Reviewed ${runbook.id}: stale`);
      expect(memoryRegistry.get(runbook.id)?.reviewState).toBe('stale');
      expect(memoryRegistry.get(runbook.id)?.staleReason).toContain('operator revalidation needed');
    } finally { installJudgmentPort(previous); }
  });
});
