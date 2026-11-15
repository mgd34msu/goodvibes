/** A tool's host-only facts are saved with its message and restored with the session, but never reach the model. */
import { expect, test } from 'bun:test';
import { ConversationManager } from '../platform/src/platform/core/conversation.js';

const evidence = { reads: [{ index: 0, path: 'src/a.ts', resolvedPath: '/project/src/a.ts', readObservation: { schemaVersion: 2 } }] } as never;

test('host evidence rides the saved tool message and the model never sees it', () => {
  const conversation = new ConversationManager();
  conversation.addAssistantMessage('reading', { toolCalls: [{ id: 'call-1', name: 'read', arguments: {} }] });
  conversation.addToolResults([{ callId: 'call-1', success: true, output: '{"success":true,"files":[]}', hostEvidence: evidence }]);
  const saved = conversation.getMessageSnapshot().find((message) => message.role === 'tool');
  expect(saved).toMatchObject({ role: 'tool', callId: 'call-1', hostEvidence: { reads: [{ path: 'src/a.ts', resolvedPath: '/project/src/a.ts' }] } });
  expect(JSON.stringify(conversation.getMessagesForLLM())).not.toContain('resolvedPath');
  const restored = new ConversationManager();
  restored.fromJSON(JSON.parse(JSON.stringify(conversation.toJSON())));
  expect(restored.getMessageSnapshot().find((message) => message.role === 'tool')).toMatchObject({ hostEvidence: { reads: [{ path: 'src/a.ts' }] } });
});

test('a result with no host evidence adds no field', () => {
  const conversation = new ConversationManager();
  conversation.addAssistantMessage('running', { toolCalls: [{ id: 'call-1', name: 'exec', arguments: {} }] });
  conversation.addToolResults([{ callId: 'call-1', success: true, output: 'ok' }]);
  expect(conversation.getMessageSnapshot().find((message) => message.role === 'tool')).not.toHaveProperty('hostEvidence');
});
