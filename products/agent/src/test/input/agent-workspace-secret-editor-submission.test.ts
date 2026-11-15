import { describe, expect, test } from 'bun:test';
import { buildAgentWorkspaceSecretEditorSubmission } from '../../input/agent-workspace-secret-editor-submission.ts';
import type { AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';

function editor(kind: AgentWorkspaceLocalEditor['kind']): AgentWorkspaceLocalEditor {
  return { kind, mode: 'create', title: 'Secret', selectedFieldIndex: 0, message: '', fields: [] };
}

function reader(values: Record<string, string>): (id: string) => string {
  return (id) => values[id] ?? '';
}

describe('secret editor scope and storage', () => {
  test('an unrecognised scope is refused instead of falling back to the project scope', () => {
    const result = buildAgentWorkspaceSecretEditorSubmission(
      editor('secret-set'),
      reader({ key: 'API_KEY', value: 'v', scope: 'usr', storage: 'plaintext', confirm: 'yes' }),
    );
    expect(result.kind).toBe('editor');
    if (result.kind !== 'editor') return;
    expect(result.editor.message).toContain('"usr"');
    expect(result.editor.message).toContain('project or user');
  });

  test('an unrecognised storage is refused', () => {
    const result = buildAgentWorkspaceSecretEditorSubmission(
      editor('secret-link'),
      reader({ key: 'API_KEY', ref: 'env:X', scope: 'user', storage: 'vault', confirm: 'yes' }),
    );
    expect(result.kind).toBe('editor');
  });

  test('a mistyped scope never reaches secret deletion', () => {
    const result = buildAgentWorkspaceSecretEditorSubmission(
      editor('secret-delete'),
      reader({ key: 'API_KEY', scope: 'users', confirm: 'yes' }),
    );
    expect(result.kind).toBe('editor');
  });

  test('blank scope and storage still dispatch with no flags, and a known scope keeps its flag', () => {
    const blank = buildAgentWorkspaceSecretEditorSubmission(editor('secret-delete'), reader({ key: 'K', confirm: 'yes' }));
    expect(blank.kind === 'dispatch' && blank.command).toBe('/secrets delete K --yes');
    const user = buildAgentWorkspaceSecretEditorSubmission(editor('secret-delete'), reader({ key: 'K', scope: ' User ', confirm: 'yes' }));
    expect(user.kind === 'dispatch' && user.command).toBe('/secrets delete K --user --yes');
  });
});
