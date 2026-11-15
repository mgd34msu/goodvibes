import { describe, expect, test } from 'bun:test';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { AgentWorkspace } from '../../input/agent-workspace.ts';
import { handleAgentWorkspaceToken } from '../../input/agent-workspace-token.ts';
import { createAgentWorkspaceOperationsCommandEditor } from '../../input/agent-workspace-operations-command-editors.ts';
import { buildAgentWorkspaceOperationsCommandEditorSubmission } from '../../input/agent-workspace-operations-command-editor-submission.ts';
import { buildAgentArtifactExportPromptSubmission, createAgentArtifactExportEditor } from '../../input/agent-workspace-artifact-browser-editor.ts';
import { buildAgentResearchSourcePromptSubmission, createAgentResearchSourceEditor } from '../../input/agent-workspace-research-source-editor.ts';

function reader(values: Record<string, string>): (id: string) => string {
  return (id) => values[id] ?? '';
}

describe('schedule edit type', () => {
  const edit = (scheduleKind: string) => buildAgentWorkspaceOperationsCommandEditorSubmission(
    createAgentWorkspaceOperationsCommandEditor('schedule-edit'),
    reader({ scheduleId: 'sch_1', scheduleKind, scheduleValue: '10m', confirm: 'yes' }),
  );

  test('text that is not at, every or cron cannot add flags to the command', () => {
    const result = edit('at --disabled');
    expect(result.kind).toBe('editor');
  });

  test('a known type, in any case, keeps its flag', () => {
    const result = edit('Every');
    expect(result.kind === 'dispatch' && result.command).toBe('/schedule edit sch_1 --every 10m --yes');
  });
});

describe('research source URL', () => {
  const submit = (url: string) => buildAgentResearchSourcePromptSubmission(
    createAgentResearchSourceEditor(),
    reader({ question: 'q', title: 't', summary: 's', url, confirm: 'yes' }),
    true,
  );

  test.each([
    'https://user:pass@example.com/doc',
    'https://example.com/doc?access_token=abc',
    'https://example.com/doc?x=1&api_key=abc',
    'example.com/doc?token=abc',
    '//u:p@example.com/x',
    'user:pass@example.com/doc',
  ])('a URL carrying a credential is not placed in the prompt: %s', (url) => {
    const result = submit(url);
    expect(result.kind).toBe('editor');
    expect(JSON.stringify(result)).not.toContain('pass@');
    expect(JSON.stringify(result)).not.toContain('token=abc');
    expect(JSON.stringify(result)).not.toContain('u:p@');
  });

  test('"y" confirms the form the same way it confirms a secret store', () => {
    const result = buildAgentResearchSourcePromptSubmission(
      createAgentResearchSourceEditor(),
      reader({ question: 'q', title: 't', summary: 's', confirm: 'y' }),
      true,
    );
    expect(result.kind).toBe('prompt');
  });

  test('the result says the model was asked, not that the source was added', () => {
    const result = submit('https://example.com/doc');
    expect(result.kind === 'prompt' && result.actionResult.detail.startsWith('Asked the model')).toBe(true);
  });

  test('an ordinary URL, including a harmless query, is sent', () => {
    const result = submit('https://example.com/doc?page=2&keyword=a');
    expect(result.kind === 'prompt' && result.prompt).toContain('https://example.com/doc?page=2&keyword=a');
  });
});

describe('artifact export confirmation', () => {
  const submit = (confirm: string) => buildAgentArtifactExportPromptSubmission(
    createAgentArtifactExportEditor(),
    reader({ artifactId: 'art_1', destinationPath: 'out/a.txt', confirm }),
    true,
  );

  test('"y" confirms like every other form; a blank answer does not', () => {
    expect(submit('y').kind).toBe('prompt');
    expect(submit('').kind).toBe('editor');
  });
});

describe('Delete key in workspace text fields', () => {
  function fakeWorkspace(overrides: Record<string, unknown>) {
    const calls: string[] = [];
    const workspace = {
      active: true,
      localEditor: null,
      actionSearchActive: false,
      editorBackspace: () => calls.push('editorBackspace'),
      actionSearchBackspace: () => calls.push('actionSearchBackspace'),
      ...overrides,
    } as unknown as AgentWorkspace;
    return { workspace, calls };
  }
  const key = (logicalName: string): InputToken => ({ type: 'key', name: logicalName, logicalName, ctrl: false, shift: false, meta: false });

  test('Backspace removes a character in an editor field and Delete does not', () => {
    const { workspace, calls } = fakeWorkspace({ localEditor: { kind: 'note' } });
    handleAgentWorkspaceToken(workspace, key('delete'), () => {}, () => {});
    expect(calls).toEqual([]);
    handleAgentWorkspaceToken(workspace, key('backspace'), () => {}, () => {});
    expect(calls).toEqual(['editorBackspace']);
  });

  test('the same holds for the action search filter', () => {
    const { workspace, calls } = fakeWorkspace({ actionSearchActive: true });
    handleAgentWorkspaceToken(workspace, key('delete'), () => {}, () => {});
    expect(calls).toEqual([]);
    handleAgentWorkspaceToken(workspace, key('backspace'), () => {}, () => {});
    expect(calls).toEqual(['actionSearchBackspace']);
  });
});
