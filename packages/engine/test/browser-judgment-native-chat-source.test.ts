import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { type AuthenticatedPrincipal, type BrowserJudgmentRequest, WEBUI_CODE_LANGUAGES } from '../daemon-sdk/src/index.ts';
import { CompanionChatManager } from '../sdk/src/platform/companion/companion-chat-manager.ts';
import { CompanionChatPersistence, type PersistedChatSession } from '../sdk/src/platform/companion/companion-chat-persistence.ts';
import { dispatchCompanionChatRoutes } from '../sdk/src/platform/companion/companion-chat-routes.ts';
import type { CompanionChatRouteContext } from '../sdk/src/platform/companion/companion-chat-route-types.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';

const content = 'A complete sentence.\n\n```\nconst answer = 42;\n```';
const principal: AuthenticatedPrincipal = { principalId: 'native-chat-owner', principalKind: 'user', admin: false, scopes: ['write:judgment', 'read:sessions'] };

test('HTTP history revisions bind actual code and speech readers and expire across a daemon reload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-chat-source-'));
  const persistence = new CompanionChatPersistence(directory);
  const stored: PersistedChatSession = {
    meta: { id: 'native-chat', kind: 'companion-chat', title: 'Source', model: null, provider: null, systemPrompt: null,
      status: 'closed', createdAt: 1, updatedAt: 2, closedAt: 2, messageCount: 1 },
    messages: [{ id: 'reply', sessionId: 'native-chat', role: 'assistant', content, contentRevision: 'foreign-disk-revision', attachments: [], createdAt: 2 }],
  };
  const makeManager = () => new CompanionChatManager({
    provider: { async *chatStream() { yield { type: 'done' }; } }, eventPublisher: { publishEvent() {} },
    persist: true, sessionsDir: directory, rateLimiter: false, gcIntervalMs: 999_999,
  });
  const managers: CompanionChatManager[] = [];
  const log = new SqliteDecisionLog(':memory:');
  const calls: unknown[] = [];
  const port: JudgmentPort = { model: 'fixture', async ask(input) {
    calls.push(input.state);
    return { requestedModel: 'fixture', model: 'fixture', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: Object.fromEntries(Object.entries(input.questions).map(([name, question]) => [name, question.type === 'choice'
        ? { type: 'choice', choice: 'javascript', confidence: 0.99,
          probabilities: Object.fromEntries(WEBUI_CODE_LANGUAGES.map(language => [language, language === 'javascript' ? 1 : 0])) }
        : { type: 'noul', noul: 0.999 }])) as never };
  } };
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(), authorize: () => true,
    currentRoute: () => ({ revision: 'native-route', kind: 'local', port: withDecisionLog(port, log), assertCurrent() {} }),
  });
  let unbind: (() => void) | undefined;
  try {
    await persistence.save(stored);
    const manager = makeManager(); managers.push(manager); await manager.init();
    unbind = service.bindChatSessions(manager);
    const response = await dispatchCompanionChatRoutes(new Request('http://localhost/api/companion/chat/sessions/native-chat'),
      { chatManager: manager } as CompanionChatRouteContext);
    expect(response?.status).toBe(200);
    const history = await response!.json() as { messages: { id: string; sessionId: string; content: string; contentRevision: string }[] };
    const message = history.messages[0]!;
    expect(message.contentRevision).toBe(manager.getMessages('native-chat')[0]!.contentRevision);
    expect(message.contentRevision).not.toBe('foreign-disk-revision');
    const binding = { sessionId: message.sessionId, messageId: message.id, contentRevision: message.contentRevision };
    const code: BrowserJudgmentRequest<'webui.code.language'> = { protocolVersion: 1, requestId: crypto.randomUUID(),
      battery: 'webui.code.language', batteryVersion: 2, input: { ...binding, start: content.indexOf('```'), end: content.length } };
    const speech: BrowserJudgmentRequest<'webui.voice.speech-seams'> = { protocolVersion: 1, requestId: crypto.randomUUID(),
      battery: 'webui.voice.speech-seams', batteryVersion: 2, input: { ...binding, start: 0, end: content.indexOf('\n\n'), cursor: 0 } };
    const execute = (request: unknown) => service.execute(request, principal, new AbortController().signal, () => principal);
    expect(await execute(code)).toMatchObject({ batteryVersion: 2, status: 'settled', value: { language: 'javascript' } });
    expect(await execute(speech)).toMatchObject({ batteryVersion: 2, status: 'settled' });
    expect(calls.length).toBeGreaterThan(1);
    const priorCalls = calls.length;
    for (const request of [code, speech]) {
      await expect(execute({ ...request, batteryVersion: 1 })).rejects.toMatchObject({ code: 'JUDGMENT_BATTERY_VERSION_UNSUPPORTED' });
      await expect(execute({ ...request, input: { ...request.input, contentRevision: 'foreign-disk-revision' } })).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
    }
    expect(calls).toHaveLength(priorCalls);
    unbind(); unbind = undefined; manager.dispose();
    // Even the same saved bytes and an asserted prior revision cannot impersonate a new owner.
    await persistence.save({ ...stored, messages: [{ ...stored.messages[0]!, contentRevision: message.contentRevision }] });
    const restored = makeManager(); managers.push(restored); await restored.init();
    unbind = service.bindChatSessions(restored);
    expect(restored.getMessages('native-chat')[0]!.contentRevision).not.toBe(message.contentRevision);
    await expect(execute(code)).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
    await expect(execute(speech)).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
    expect(calls).toHaveLength(priorCalls);
  } finally {
    unbind?.(); await service.close(); log[Symbol.dispose]();
    for (const manager of managers) manager.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
