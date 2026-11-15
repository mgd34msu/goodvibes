import { describe, expect, test } from 'bun:test';
import { AGENT_WORKSPACE_EDITOR_KINDS } from '../../input/agent-workspace-editor-kinds.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { createAgentWorkspaceEditor } from '../../input/agent-workspace-activation.ts';

/** Opened over live state by their own rows (every setting row; the settings import row), not by an `editorKind` row. */
const OPENED_BY_SETTING_ROWS = new Set(['setting-set', 'settings-import']);

describe('every workspace form is reachable', () => {
  test('each form kind has a row that opens it and a constructor', () => {
    const rows = new Set(AGENT_WORKSPACE_CATEGORIES.flatMap((category) => category.actions.map((action) => action.editorKind)));
    const kinds = AGENT_WORKSPACE_EDITOR_KINDS.filter((kind) => !OPENED_BY_SETTING_ROWS.has(kind));
    expect(kinds.filter((kind) => !rows.has(kind))).toEqual([]);
    expect(kinds.filter((kind) => createAgentWorkspaceEditor(kind) === null)).toEqual([]);
  });
});
