import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { journalPathFor, openTranscriptJournal } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-resume-journal-failure');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(sm: SessionManager, conversation: ConversationManager, printed: string[]): CommandContext {
  return {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    session: {
      conversationManager: conversation,
      runtime: { sessionId: 'current-session', model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium' },
      sessionManager: sm,
    },
    workspace: {
      shellPaths: { workingDirectory: tmpDir, homeDirectory: tmpDir },
      surface: makeTestSurface(tmpDir),
    },
    platform: { configManager: { get: () => 'off', getCategory: () => ({}) } },
    clients: { providerApi: { selectModel: async (model: string) => ({ registryKey: model, providerId: 'p' }) } },
  } as unknown as CommandContext;
}

describe('/session resume: journal that cannot be replayed', () => {
  test('tells the user recovery failed and that the journal was kept', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-j', [{ role: 'user', content: 'hi' }], { title: 'J', model: 'm', provider: 'p', timestamp: Date.now() - 5000 });
    const journalPath = journalPathFor(makeTestSurface(tmpDir), 'sess-j');
    mkdirSync(dirname(journalPath), { recursive: true });
    openTranscriptJournal(journalPath, 'sess-j').appendRecord('assistant_turn', [
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'later turn' },
    ] as never);
    // Only the journal's newest transcript carries this message, so the snapshot itself still loads.
    const conversation = new ConversationManager(() => 80);
    const loadState = conversation.fromJSON.bind(conversation);
    conversation.fromJSON = (state) => {
      if (JSON.stringify(state).includes('later turn')) throw new Error('journal transcript not understood');
      loadState(state);
    };
    const printed: string[] = [];

    await handleSessionWorkflowCommand(['resume', 'sess-j'], makeCtx(sm, conversation, printed));

    const output = printed.join('\n');
    expect(output).toContain('Resumed session: sess-j');
    expect(output).toContain('Recovery of the journal failed (journal transcript not understood); it was kept and will be retried on the next resume.');
    expect(existsSync(journalPath)).toBe(true);
  });
});
