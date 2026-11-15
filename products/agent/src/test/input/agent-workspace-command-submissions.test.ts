import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/platform/platform/state';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { buildAgentWorkspaceChannelCommandEditorSubmission } from '../../input/agent-workspace-channel-command-editor-submission.ts';
import { createAgentWorkspaceChannelCommandEditor } from '../../input/agent-workspace-channel-command-editors.ts';
import { buildAgentWorkspaceNotifyEditorSubmission } from '../../input/agent-workspace-notify-editor-submission.ts';
import { buildAgentWorkspaceMcpCommandEditorSubmission } from '../../input/agent-workspace-mcp-command-editor-submission.ts';
import { createAgentWorkspaceMcpCommandEditor } from '../../input/agent-workspace-mcp-command-editors.ts';
import {
  buildAgentDocumentReviewPacketPresetPromptSubmission,
  buildAgentDocumentReviewPacketPresetRefreshPromptSubmission,
  buildAgentDocumentReviewPacketSharePromptSubmission,
  createAgentDocumentReviewPacketPresetRefreshEditor,
  createAgentDocumentReviewPacketShareEditor,
} from '../../input/agent-workspace-document-ops-editor.ts';
import { buildAgentModelComparePromptSubmission } from '../../input/agent-workspace-model-compare-prompt-submission.ts';
import { createAgentModelCompareEditor } from '../../input/agent-workspace-model-compare-editor.ts';
import { submitAgentWorkspaceMemoryEditor } from '../../input/agent-workspace-memory-editor.ts';
import { submitAgentWorkspaceGoogleSetupEditor } from '../../input/agent-workspace-google-setup-editor.ts';
import { isAffirmative, isEnabledValue } from '../../input/agent-workspace-editors.ts';
import { runFollowUpWrite } from '../../input/agent-workspace-learned-behavior.ts';
import { syncAgentWorkspaceLiveCounters } from '../../input/agent-workspace-live-counters.ts';
import type { AgentWorkspaceLocalEditor, AgentWorkspaceRuntimeSnapshot } from '../../input/agent-workspace-types.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function reader(values: Record<string, string>): (id: string) => string {
  return (id) => values[id] ?? '';
}

describe('MCP server add form', () => {
  const base = { name: 'files', command: 'npx', confirm: 'yes' };

  test('server args go after "--" so a server flag cannot be read as an MCP sandbox setting', () => {
    const editor = createAgentWorkspaceMcpCommandEditor('mcp-server');
    const result = buildAgentWorkspaceMcpCommandEditorSubmission(editor, reader({ ...base, args: '--host 0.0.0.0 --path /data', hosts: 'api.example.test' }));
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    const tokens = result.command.split(' ');
    const separator = tokens.indexOf('--');
    expect(separator).toBeGreaterThan(0);
    expect(tokens.slice(separator + 1)).toEqual(['--host', '0.0.0.0', '--path', '/data']);
    // The only --host before the separator is the one the user typed in the Hosts field.
    expect(tokens.slice(0, separator).filter((token) => token === '--host')).toHaveLength(1);
    expect(tokens.slice(0, separator)).toContain('--yes');
  });

  test('no separator is emitted when the server has no args', () => {
    const editor = createAgentWorkspaceMcpCommandEditor('mcp-server');
    const result = buildAgentWorkspaceMcpCommandEditorSubmission(editor, reader(base));
    expect(result.kind === 'dispatch' && result.command.split(' ').includes('--')).toBe(false);
  });

  test('the result pane shows env values redacted while the dispatched command keeps them', () => {
    const editor = createAgentWorkspaceMcpCommandEditor('mcp-server');
    const result = buildAgentWorkspaceMcpCommandEditorSubmission(editor, reader({ ...base, env: 'API_KEY=abc123' }));
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.command).toContain('API_KEY=abc123');
    expect(result.actionResult.command).not.toContain('abc123');
    expect(result.actionResult.command).toContain('API_KEY=<redacted>');
  });
});

describe('channel send form', () => {
  const base = { message: 'hello', confirm: 'yes' };

  test('more than one target field is refused before anything is dispatched', () => {
    const editor = createAgentWorkspaceChannelCommandEditor('channel-send');
    const result = buildAgentWorkspaceChannelCommandEditorSubmission(editor, reader({ ...base, channel: 'slack:ops', webhook: 'https://hooks.example.test/T1/secret' }));
    expect(result.kind).toBe('editor');
  });

  test('no target field keeps the form open with the typed message', () => {
    const editor = createAgentWorkspaceChannelCommandEditor('channel-send');
    const result = buildAgentWorkspaceChannelCommandEditorSubmission(editor, reader(base));
    expect(result.kind).toBe('editor');
  });

  test('the webhook URL is masked in the result pane but sent in full', () => {
    const editor = createAgentWorkspaceChannelCommandEditor('channel-send');
    const result = buildAgentWorkspaceChannelCommandEditorSubmission(editor, reader({ ...base, webhook: 'https://hooks.example.test/T1/secret-token' }));
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.command).toContain('secret-token');
    expect(result.actionResult.command).not.toContain('secret-token');
    expect(result.actionResult.command).toContain('hooks.example.test');
  });
});

describe('document ops packet prompts require the Confirm field', () => {
  const cases = [
    ['preset save', buildAgentDocumentReviewPacketPresetPromptSubmission, createAgentDocumentReviewPacketShareEditor()],
    ['preset refresh', buildAgentDocumentReviewPacketPresetRefreshPromptSubmission, createAgentDocumentReviewPacketPresetRefreshEditor()],
    ['share', buildAgentDocumentReviewPacketSharePromptSubmission, createAgentDocumentReviewPacketShareEditor()],
  ] as const;

  for (const [label, build, editor] of cases) {
    test(`${label}: confirm "no" stays in the editor and submits nothing`, () => {
      const result = build(editor, reader({ artifactId: 'a1', archiveArtifactId: 'a1', webhook: 'https://hooks.example.test/x', confirm: 'no' }), true);
      expect(result.kind).toBe('editor');
    });
    test(`${label}: confirm "yes" submits the prompt`, () => {
      const result = build(editor, reader({ artifactId: 'a1', archiveArtifactId: 'a1', webhook: 'https://hooks.example.test/x', confirm: 'yes' }), true);
      expect(result.kind).toBe('prompt');
    });
  }
});

describe('model comparison prompt', () => {
  test('a blank Max tokens is described as the model default, not zero', () => {
    const result = buildAgentModelComparePromptSubmission(createAgentModelCompareEditor(), reader({ prompt: 'Compare these', confirm: 'yes' }), true);
    expect(result.kind).toBe('prompt');
    if (result.kind !== 'prompt') return;
    expect(result.prompt).not.toContain(': 0.');
    expect(result.prompt).toContain('Max tokens per candidate: model default.');
  });

  test('an explicit Max tokens is passed through', () => {
    const result = buildAgentModelComparePromptSubmission(createAgentModelCompareEditor(), reader({ prompt: 'Compare these', confirm: 'yes', maxTokens: '512' }), true);
    expect(result.kind === 'prompt' && result.prompt.includes('Max tokens per candidate: 512.')).toBe(true);
  });

  test('the result says the model was asked, not that the action is done', () => {
    const result = buildAgentModelComparePromptSubmission(createAgentModelCompareEditor(), reader({ prompt: 'Compare these', confirm: 'yes' }), true);
    expect(result.kind === 'prompt' && result.actionResult.detail.startsWith('Asked the model')).toBe(true);
  });
});

describe('memory editor', () => {
  async function withRegistry<T>(run: (registry: MemoryRegistry) => Promise<T>): Promise<T> {
    const root = makeProjectTempDir('agent-memory-editor');
    const configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
      workingDir: root,
    });
    const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
    await store.init();
    try {
      return await run(new MemoryRegistry(store));
    } finally {
      await store.save();
      store.close();
    }
  }

  test('clearing Detail on an update removes the stored detail', async () => {
    await withRegistry(async (registry) => {
      const record = await registry.add({ scope: 'project', cls: 'fact', summary: 'Prefers tabs', detail: 'old detail', provenance: [{ kind: 'event', ref: 'test' }] });
      const editor: AgentWorkspaceLocalEditor = { kind: 'memory', mode: 'update', recordId: record.id, title: 'Edit', fields: [], selectedFieldIndex: 0, message: '' };
      const api = registry as unknown as MemoryApi; // the update-mode path only calls update()
      const result = await submitAgentWorkspaceMemoryEditor(editor, api, reader({ scope: 'project', summary: 'Prefers tabs', detail: '', tags: '' }));
      expect(result.verb).toBe('Updated');
      expect(registry.get(record.id)?.detail ?? '').toBe('');
    });
  });
});

describe('notification webhook forms', () => {
  const secretUrl = 'https://hooks.example.test/services/T000/B000/secret-token';
  for (const kind of ['notify-webhook', 'notify-webhook-remove'] as const) {
    test(`${kind} dispatches the full URL but never shows it in the result`, () => {
      const editor: AgentWorkspaceLocalEditor = { kind, mode: 'create', title: 'Webhook', fields: [], selectedFieldIndex: 0, message: '' };
      const submission = buildAgentWorkspaceNotifyEditorSubmission(editor, reader({ url: secretUrl, confirm: 'yes' }));
      if (submission.kind !== 'dispatch') throw new Error('expected a dispatch');
      expect(submission.command).toContain('secret-token');
      expect(JSON.stringify(submission.actionResult)).not.toContain('secret-token');
      expect(submission.actionResult.command).toContain('hooks.example.test');
    });
  }
});

describe('confirmation gates', () => {
  test('the shared isAffirmative never confirms on blank, "on" or "enabled"', () => {
    for (const value of ['', '  ', 'on', 'enabled', 'no']) expect(isAffirmative(value)).toBe(false);
    for (const value of ['y', 'YES', 'true']) expect(isAffirmative(value)).toBe(true);
  });

  test('the Enable-now reading keeps blank as on', () => {
    expect(isEnabledValue('')).toBe(true);
    expect(isEnabledValue('no')).toBe(false);
  });

  test('Remove stored Google credentials refuses a blank confirm and changes nothing', async () => {
    const host = { localEditor: null as AgentWorkspaceLocalEditor | null, status: '', lastActionResult: null };
    const editor: AgentWorkspaceLocalEditor = { kind: 'google-forget', mode: 'delete', title: 'Forget', fields: [], selectedFieldIndex: 0, message: '' };
    await submitAgentWorkspaceGoogleSetupEditor(host, editor, null, () => '');
    expect(host.localEditor?.message).toContain('Not confirmed');
    expect(host.lastActionResult).toBeNull();
  });
});

describe('two-write saves', () => {
  test('a failed second write says the record was saved', () => {
    const failing = () => runFollowUpWrite('Skill "Triage"', 'applying the enabled setting', () => { throw new Error('disk is read-only'); });
    expect(failing).toThrow(/Skill "Triage" was saved, but applying the enabled setting failed: disk is read-only/);
  });

  test('a successful second write is silent', () => {
    let ran = false;
    runFollowUpWrite('Skill "Triage"', 'x', () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe('live counters', () => {
  test('a failed read keeps the previous counters and marks them stale', () => {
    const snapshot = { localMemoryCount: 7, liveCountersStale: false } as unknown as AgentWorkspaceRuntimeSnapshot;
    let current: AgentWorkspaceRuntimeSnapshot = snapshot;
    let clamped = 0;
    syncAgentWorkspaceLiveCounters({
      context: new Proxy({}, { get() { throw new Error('config store unreadable'); } }) as CommandContext,
      runtimeSnapshot: snapshot,
      setRuntimeSnapshot: (next) => { current = next; },
      clampSelection: () => { clamped += 1; },
    });
    expect(current.localMemoryCount).toBe(7);
    expect(current.liveCountersStale).toBe(true);
    expect(clamped).toBe(1);
  });
});
