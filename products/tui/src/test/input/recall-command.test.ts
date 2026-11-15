import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import { MemoryRegistry, MemoryStore, MemoryEmbeddingProviderRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerControlRoomRuntimeCommands } from '../../input/commands/control-room-runtime.ts';
import { createMemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { MemorySpineClient, createLocalMemoryAccess, type LocalMemoryStore } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { ForensicsRegistry } from '@/runtime/index.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

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
      knowledgeApi: {
        memory: createMemoryApi(options.memoryRegistry),
      } as never,
      // /recall's browse/link/queue/export/import (and add/get/remove/review)
      // route through the memory spine; local mode (no transport activated)
      // goes straight to the registry the assertions read back through.
      memorySpine: new MemorySpineClient({
        local: createLocalMemoryAccess(options.memoryRegistry as unknown as LocalMemoryStore),
      }),
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
      enableVectorIndex: false,
    });
    await store.init();
    memoryRegistry = new MemoryRegistry(store);
    previousJudgment = installJudgmentPort(fakePort(() => noulAnswer(0.95)).port);
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

  test('captures the latest incident into memory', async () => {
    await recallCommand.handler(['capture', 'incident', 'latest'], makeRecallCommandContext(printed, {
      memoryRegistry,
      forensicsRegistry,
    }));

    expect(printed.some((line) => line.includes('Captured incident incident-1 into memory'))).toBe(true);
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

    expect(printed.some((line) => line.includes('Captured policy preflight into memory'))).toBe(true);
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

    expect(printed.some((line) => line.includes('Captured MCP server ops into memory'))).toBe(true);
    expect(memoryRegistry.getAll()).toHaveLength(1);
  });

  test('promotes a record to team scope and exports a handoff bundle', async () => {
    const shared = await memoryRegistry.add({ cls: 'decision', summary: 'Share this', scope: 'project' });
    const id = shared.id;

    expect(memoryRegistry.get(id)?.scope).toBe('project');
    await recallCommand.handler(['promote', id, 'team'], makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry }));
    expect(printed.some((line) => line.includes(`Promoted ${id} to team scope`))).toBe(true);
    expect(memoryRegistry.get(id)?.scope).toBe('team');

    const handoffDir = makeProjectTempDir('gv-memory-handoff');
    const bundlePath = join(handoffDir, 'team-handoff.json');
    const shellPaths = createShellPathService({ workingDirectory: handoffDir, homeDirectory: handoffDir });
    printed.length = 0;
    expect(existsSync(bundlePath)).toBe(false);
    await recallCommand.handler(['handoff-export', bundlePath, '--scope', 'team'], makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry, shellPaths }));
    expect(printed.some((line) => line.includes('Exported team handoff bundle'))).toBe(true);
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as { scope: string; records: Array<{ id: string; scope: string }> };
    expect(bundle.scope).toBe('team');
    expect(bundle.records.map((record) => [record.id, record.scope])).toEqual([[id, 'team']]);
  });

  test('explains reviewed knowledge injection for a task and supports stale shortcuts', async () => {
    const record = await memoryRegistry.add({
      cls: 'runbook',
      summary: 'Deploy tasks should quarantine risky MCP schemas first.',
      tags: ['deploy', 'mcp'],
      review: { state: 'reviewed', confidence: 92 },
    });
    await recallCommand.handler(['explain', 'deploy', 'the', 'release'], makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry }));

    expect(printed.join('\n')).toContain('Injected Project Knowledge');
    expect(printed.join('\n')).toContain('matched task');
    expect(printed.join('\n')).toContain('Deploy tasks should quarantine risky MCP schemas first.');

    printed.length = 0;
    const commands = new CommandRegistry();
    registerControlRoomRuntimeCommands(commands);
    await commands.get('project-memory')!.handler(['explain', 'deploy', 'the', 'release'], makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry }));
    expect(printed.join('\n')).toContain('Injected Project Knowledge');
    expect(printed.join('\n')).toContain('Deploy tasks should quarantine risky MCP schemas first.');

    printed.length = 0;
    await recallCommand.handler(['stale', record.id, 'operator', 'revalidation', 'needed'], makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry }));
    expect(printed.some((line) => line.includes(`Reviewed ${record.id}: stale`))).toBe(true);
    expect(memoryRegistry.get(record.id)?.reviewState).toBe('stale');
    expect(memoryRegistry.get(record.id)?.staleReason).toContain('operator revalidation needed');
  });

  // ── item 3: report-vs-modal front door ─────────────────────────────
  describe('front door (bare opens the memory-modal; report preserves the old usage output)', () => {
    test('bare /recall opens the memory-modal, prints nothing', async () => {
      const opened: string[] = [];
      const ctx = { ...makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry }), openModal: (name: string) => opened.push(name) };
      await recallCommand.handler([], ctx);
      expect(opened).toEqual(['memory-modal']);
      expect(printed).toEqual([]);
    });

    test('/recall report prints the subcommand usage text (scriptability preserved) and does not open the modal', async () => {
      const opened: string[] = [];
      const ctx = { ...makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry }), openModal: (name: string) => opened.push(name) };
      await recallCommand.handler(['report'], ctx);
      expect(opened).toEqual([]);
      expect(printed.length).toBe(1);
      expect(printed[0]).toContain('Usage: /recall <subcommand>');
      expect(printed[0]).toContain('add <class> <summary>');
    });

    test('an unrecognized subcommand still shows the usage text (unchanged lenient fallback)', async () => {
      const opened: string[] = [];
      const ctx = { ...makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry }), openModal: (name: string) => opened.push(name) };
      await recallCommand.handler(['not-a-real-subcommand'], ctx);
      expect(opened).toEqual([]);
      expect(printed[0]).toContain('Usage: /recall <subcommand>');
    });

    test('a real subcommand (list) still dispatches normally, not affected by the front-door change', async () => {
      const opened: string[] = [];
      const ctx = { ...makeRecallCommandContext(printed, { memoryRegistry, forensicsRegistry }), openModal: (name: string) => opened.push(name) };
      await recallCommand.handler(['list'], ctx);
      expect(opened).toEqual([]);
      expect(printed.join('\n')).not.toContain('Usage: /recall <subcommand>');
      expect(printed.length).toBeGreaterThan(0);
    });
  });
});
