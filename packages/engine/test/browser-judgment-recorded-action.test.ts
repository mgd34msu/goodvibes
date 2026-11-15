import { describe, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { BrowserJudgmentError, type AuthenticatedPrincipal } from '../daemon-api/src/index.ts';
import { BrowserJudgmentReferences, BrowserJudgmentRegistry, BrowserJudgmentService } from '../platform/src/platform/judgment-browser/index.ts';
import { createSpeechSeamsAdapter } from '../platform/src/platform/judgment-browser/batteries/speech-seams.ts';
import { snapshotSpeechSeams } from '../platform/src/platform/judgment-browser/speech-source.ts';
import { webuiDaemonRefusalAdapter } from '../platform/src/platform/judgment-browser/batteries/webui-adapters.ts';

const ERRORS = 'webui.errors.daemon-refusal' as const;
const owner: AuthenticatedPrincipal = { principalId: 'owner', principalKind: 'user', admin: true, scopes: ['write:judgment'] };

function fixture(options: { revokeDuringProject: boolean }) {
  const log = new SqliteDecisionLog(':memory:');
  const references = new BrowserJudgmentReferences();
  const registry = new BrowserJudgmentRegistry();
  let current = true;
  const inner: JudgmentPort = { model: 'jev-1.13.0', ask: async (request) => ({
    answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: 0.01 }])) as never,
    requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined,
  }) };
  const port = withDecisionLog(inner, log);
  registry.register({
    ...webuiDaemonRefusalAdapter,
    // The source is withdrawn after the reading was taken but before the result reaches the client.
    project: (result) => {
      const projection = webuiDaemonRefusalAdapter.project(result);
      if (options.revokeDuringProject) current = false;
      return projection;
    },
  });
  const service = new BrowserJudgmentService({ registry, references,
    currentRoute: () => ({ revision: 'route-1', kind: 'local', port, assertCurrent() {} }),
    authorize: () => true,
  });
  const errorRef = references.issue({
    principalId: owner.principalId, battery: ERRORS, revision: crypto.randomUUID(), expiresAt: Date.now() + 300_000,
    snapshot: { methodId: 'sessions.get', status: 500, message: 'Internal failure' },
    assertCurrent: () => { if (!current) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); },
    mayRead: () => true,
  });
  const request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: ERRORS, batteryVersion: 1, input: { errorRef } };
  return { service, log, request };
}

const actions = (log: SqliteDecisionLog): string[] => log.query().flatMap((entry) => entry.status !== 'answered' ? [] :
  (entry.notes as readonly { kind: string; action?: string }[]).filter((note) => note.kind === 'action').map((note) => String(note.action)));

describe('browser judgment retained action', () => {
  test('a delivered settled result retains the ready action', async () => {
    const f = fixture({ revokeDuringProject: false });
    try {
      expect(await f.service.execute(f.request, owner, new AbortController().signal, () => owner)).toMatchObject({ status: 'settled' });
      expect(actions(f.log)).toEqual(['ready']);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test('a result refused after projection does not leave a ready action in the decision log', async () => {
    const f = fixture({ revokeDuringProject: true });
    try {
      await expect(f.service.execute(f.request, owner, new AbortController().signal, () => owner)).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      expect(f.log.query()).toHaveLength(1);
      expect(actions(f.log)).toEqual([]);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
});

describe('speech seams retained action', () => {
  const SPEECH = 'webui.voice.speech-seams' as const;
  function speech(options: { revokeDuringProject: boolean }) {
    const log = new SqliteDecisionLog(':memory:');
    const references = new BrowserJudgmentReferences();
    const registry = new BrowserJudgmentRegistry();
    let current = true;
    const inner: JudgmentPort = { model: 'jev-1.13.0', ask: async (request) => ({
      answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: 0.99 }])) as never,
      requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined,
    }) };
    const adapter = createSpeechSeamsAdapter(async (_input, context) => {
      const id = references.issue({
        principalId: owner.principalId, battery: SPEECH, revision: crypto.randomUUID(), expiresAt: Date.now() + 300_000,
        snapshot: { paragraph: 'One. Two.', candidates: [4, 9], nextCursor: null },
        assertCurrent: () => { if (!current) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); },
        mayRead: () => true,
      });
      return references.resolve(id, context.currentPrincipal, SPEECH, snapshotSpeechSeams);
    });
    registry.register({
      ...adapter,
      project: (result) => {
        const projection = adapter.project(result);
        if (options.revokeDuringProject) current = false;
        return projection;
      },
    });
    const service = new BrowserJudgmentService({ registry, references,
      currentRoute: () => ({ revision: 'route-1', kind: 'local', port: withDecisionLog(inner, log), assertCurrent() {} }),
      authorize: () => true,
    });
    const request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: SPEECH, batteryVersion: 2,
      input: { sessionId: 'chat', messageId: 'message', start: 0, end: 9, contentRevision: 'r', cursor: 0 } };
    return { service, log, request };
  }

  test('a delivered speech result retains the ready action', async () => {
    const f = speech({ revokeDuringProject: false });
    try {
      expect(await f.service.execute(f.request as never, owner, new AbortController().signal, () => owner)).toMatchObject({ status: 'settled' });
      expect(new Set(actions(f.log))).toEqual(new Set(['ready']));
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test('a speech result refused after projection does not leave an action in the decision log', async () => {
    const f = speech({ revokeDuringProject: true });
    try {
      await expect(f.service.execute(f.request as never, owner, new AbortController().signal, () => owner)).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
      expect(f.log.query().length).toBeGreaterThan(0);
      expect(actions(f.log)).toEqual([]);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
});
