import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import type { AuthenticatedPrincipal, BrowserJudgmentRequest } from '../daemon-api/src/index.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../platform/src/platform/judgment-browser/webui-runtime.ts';
import { WEBUI_COMMAND_CATALOG_VERSION } from '../platform/src/platform/judgment-browser/batteries/webui-command-catalog.ts';

const owner: AuthenticatedPrincipal = { principalId: 'owner', principalKind: 'user', admin: false, scopes: ['write:judgment', 'read:sessions'] };
const request = (): BrowserJudgmentRequest<'webui.palette.command-rank'> => ({
  protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.palette.command-rank', batteryVersion: 1,
  input: { query: { kind: 'inline', text: 'Find plans' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
    candidates: [{ kind: 'builtin', commandId: 'nav.chat' }, { kind: 'chat', sessionId: 'chat-1' }] },
});

async function rankWithTitle(title: string): Promise<{ response: object; titles: string[] }> {
  const log = new SqliteDecisionLog(':memory:');
  const titles: string[] = [];
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    titles.push((input.state as { candidate: { title: string } }).candidate.title);
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: Object.fromEntries(Object.keys(input.questions).map((name) => [name, { type: 'noul', noul: name === 'match' ? 0.99 : 0.01 }])) as never };
  } };
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(),
    currentRoute: () => ({ revision: 'route', kind: 'local', port: withDecisionLog(inner, log), assertCurrent() {} }),
    authorize: () => true });
  const session = { id: 'chat-1', title, createdAt: 1, updatedAt: 2 };
  service.bindChatSessions({ getSession: (id: string) => id === session.id ? session : null });
  try { return { response: await service.execute(request(), owner, new AbortController().signal, () => owner), titles }; }
  finally { await service.close(); log[Symbol.dispose](); }
}

test('an over-long chat title is clipped instead of holding the whole palette ranking', async () => {
  const { response, titles } = await rankWithTitle('x'.repeat(300));
  expect(response).toMatchObject({ status: 'settled' });
  expect(titles).toContain('x'.repeat(256));
});

test('a blank chat title is ranked as Untitled chat', async () => {
  const { response, titles } = await rankWithTitle('   ');
  expect(response).toMatchObject({ status: 'settled' });
  expect(titles).toContain('Untitled chat');
});

test('a title of blanks filling the clip then text is ranked as Untitled chat, not held', async () => {
  const { response, titles } = await rankWithTitle(' '.repeat(256) + 'plans');
  expect(response).toMatchObject({ status: 'settled' });
  expect(titles).toContain('Untitled chat');
});
