/** Shared in-memory harness context and recorded-admission helper for the parity and remote handoff tests. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'bun:test';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { ProcessManager, ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { VoiceProviderRegistry } from '@goodvibes-jev/engine/platform/platform/voice';
import { FileUndoManager } from '@goodvibes-jev/engine/platform/platform/state';
import { WorkPlanStore } from '@goodvibes-jev/engine/platform/platform/workflow';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

export interface HandoffFixtureOptions {
  readonly label: string;
  /** Runs after the tool registry exists and before the harness registers, for fixtures that bind an owner or wrap a manager. */
  readonly prepare?: (parts: { readonly toolRegistry: ToolRegistry; readonly processManager: ProcessManager }) => void;
}

export function makeHandoffFixture(options: HandoffFixtureOptions) {
  const root = makeProjectTempDir(options.label);
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const commandRegistry = new CommandRegistry();
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
  configManager.flushConfigFileChanges();
  const permissionManager = new PermissionManager(undefined, createPermissionConfigReader(configManager), new PolicyRuntimeState());
  const toolRegistry = new ToolRegistry(permissionManager);
  const processManager = new ProcessManager();
  options.prepare?.({ toolRegistry, processManager });
  const fileUndoManager = new FileUndoManager();
  const workPlanStore = new WorkPlanStore({ homeDirectory: root, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, projectId: `${options.label}-test`, projectRoot: root });

  const context = {
    print: (_text: string) => {},
    renderRequest: () => {},
    executeCommand: async (name: string, args: string[]) => commandRegistry.execute(name, args, context as CommandContext),
    openWorkspacePicker: () => {},
    openAgentWorkspace: () => {},
    dismissAgentWorkspace: () => false,
    openSettingsModal: () => {},
    openMcpWorkspace: () => {},
    openModelPicker: () => {},
    openModelPickerWithTarget: () => true,
    openProviderPicker: () => {},
    openProviderModelPickerWithTarget: () => true,
    openReasoningEffortPicker: () => ({ opened: true, model: 'test', levels: [] }),
    openSessionPicker: () => {},
    openProfilePicker: () => {},
    openBookmarkModal: () => {},
    openProcessModal: () => {},
    openLiveTail: () => ({ opened: true, processId: 'bg-test', label: 'test' }),
    openConversationSearch: () => {},
    openPromptHistorySearch: () => {},
    openSlashCommandMode: () => true,
    openFilePicker: () => true,
    openBlockActions: () => true,
    openContextInspector: () => {},
    openHelpOverlay: () => {},
    openShortcutsOverlay: () => {},
    openSelection: () => {},
    workspace: { shellPaths: paths, processManager, bookmarkManager: { list: () => [], listSavedFiles: () => [] }, fileUndoManager, workPlanStore },
    platform: {
      configManager,
      serviceRegistry: { getAll: () => ({}), inspect: async () => null },
      localUserAuthManager: {
        inspect: () => ({
          userStorePath: join(root, '.goodvibes', 'auth', 'users.json'),
          bootstrapCredentialPath: join(root, '.goodvibes', 'auth', 'bootstrap.txt'),
          persisted: true,
          bootstrapCredentialPresent: false,
          userCount: 0,
          sessionCount: 0,
          users: [],
          sessions: [],
        }),
      },
      subscriptionManager: { list: () => [], listPending: () => [], get: () => null, getPending: () => null },
      voiceProviderRegistry: new VoiceProviderRegistry(),
      voiceService: { listVoices: async () => [] },
      readModels: {
        security: {
          getSnapshot: () => ({
            audit: { totalTokens: 0, results: [], blocked: [], scopeViolations: [], rotationWarnings: [], rotationOverdue: [] },
            policy: { preflightStatus: 'ok', preflightIssueCount: 0, lintFindingCount: 0 },
            mcpServers: [], plugins: [], incidents: [], deniedPermissions: 0,
          }),
        },
      },
    },
    clients: {
      mcpApi: {
        listServerSecurity: () => [],
        listAllTools: async () => [],
        captureToolCatalog: () => ({ listAllTools: async () => [], assertCurrent() {} }),
      },
    },
    session: {
      runtime: { sessionId: `${options.label}-session`, provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'medium' },
      conversationManager: { title: 'Handoff test', getMessageCount: () => 0, getMessageSnapshot: () => [], getTranscriptEventIndex: () => ({ events: [], groups: [] }) },
      sessionManager: { list: () => [], search: () => [] },
    },
    provider: {
      providerRegistry: {
        listModels: () => [],
        getContextWindowForModel: () => 128_000,
      },
    },
    ops: {
      executionLedger: {
        getSnapshot: () => ({ records: [], total: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 }),
        subscribe: () => () => {},
        dispose: () => {},
      },
    },
    extensions: { toolRegistry },
  } as unknown as CommandContext;

  registerAgentHarnessTool(toolRegistry, commandRegistry, context);
  const tool = toolRegistry.list().find(candidate => candidate.definition.name === 'agent_harness');
  if (!tool) throw new Error('Registered harness handoff fixture is unavailable.');
  let sequence = 0;
  /** Prepare and admit one harness call through the real autonomous admission path. */
  async function admit(source: { readonly goal: string; readonly criteria: readonly string[] }, args: Record<string, unknown>, signal?: AbortSignal) {
    configManager.flushConfigFileChanges();
    const call = await toolRegistry.prepareCall(`${options.label}-handoff-${++sequence}`, 'agent_harness', args, { signal });
    const admission = await permissionManager.admitAutonomous(call.callId, call.name, call.args, {
      sourceOf: () => source, signal, schemaRevision: call.schemaRevision, preparedCall: { registry: toolRegistry, call },
    });
    expect(admission.result.approved).toBe(true);
    expect(admission.result.autonomousDecision).toBeUndefined();
    return { call, admission };
  }
  return { root, paths, commandRegistry, configManager, permissionManager, toolRegistry, processManager, context, tool, admit };
}
