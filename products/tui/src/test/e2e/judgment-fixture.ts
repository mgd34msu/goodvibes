import modelIdentity from '../fixtures/e2e-judgments/model-identity.json';
import modelTier from '../fixtures/e2e-judgments/model-tier.json';
import unavailableModelRoutes from '../fixtures/e2e-judgments/unavailable-model-routes.json';
import unavailableNotices from '../fixtures/e2e-judgments/unavailable-notices.json';
import planningGoals from '../fixtures/e2e-judgments/planning-goals.json';
import headlessCompletion from '../fixtures/e2e-judgments/headless-completion.json';
import completionApplicability from '../fixtures/e2e-judgments/completion-applicability.json';
import tuiCompletionTools from '../fixtures/e2e-judgments/tui-completion-tools.json';
// The field-name reading no longer exists (the activity log masks locally); a request naming it is unexpected.
const fieldKind = { name: 'engine.redaction.field-kind', items: { kind: { question: {} as never } } };

// Native TUI startup may finish after the original turn-entry snapshot; these recorded
// system notices are the only alternate complete transcripts a completion check may carry.
const tuiCompletionNotice = { role: 'system', content: '[Daemon] Web surface ready: http://127.0.0.1:3423, serving this machine only until web.hostMode is widened' };
const tuiPreviousSessionNotice = { role: 'system', content: 'Previous session found: 1 turn, 0 checkpoints: /resume to continue (or /session resume user-a1da092b directly) · /recall for memory' };
/** Only the generated session id of the previous-session notice varies. */
function completionShape(value: unknown): string {
  return stable(value).replace(/("content":"Previous session found: 1 turn, 0 checkpoints: \/resume to continue \(or \/session resume )user-[0-9a-f]{8}( directly\) · \/recall for memory","role":"system")/g, '$1<previous-session-id>$2');
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

type PrivacyKind = 'privacy-field';
// Explicit authored roles for these native diagnostic fields. Unknown names
// still fail; names that do not establish a value role remain uncertain.
const privacyFieldRoles = {
  "reason": "content",
  "refs": "uncertain",
  "handoffs": "uncertain",
  "edges": "uncertain",
  "locationsScanned": "other",
  "suggestions": "content",
  "count": "other",
  "sampleIds": "other",
  "path": "other",
  "cachePath": "other",
  "exists": "other",
  "invalidFields": "other",
  "kind": "other",
  "type": "other",
  "method": "other",
  "url": "other",
  "status": "other",
  "latencyMs": "other",
  "provider": "other",
  "providerName": "other",
  "model": "other",
  "baseURL": "other",
  "endpoint": "other",
  "endpointHost": "other",
  "contentLength": "other",
  "contentType": "other",
  "elapsedSeconds": "other",
  "thresholdSeconds": "other",
  "messageCount": "other",
  "toolCount": "other",
  "totalModels": "other",
  "childPid": "other",
  "deadOwnerPid": "other",
  "request": "content",
  "resumed": "other",
  "queued": "other",
  "reaped": "other",
  "skipped": "other",
  "projectRoot": "other",
  "movedTo": "other",
  "moved": "other",
  "discarded": "other",
  "mode": "other",
  "allowInsecureLocalhost": "other",
  "customCaEntryCount": "other",
  "effectiveCaStrategy": "other",
  "gitDir": "other",
  "ready": "other",
  "port": "other",
  "host": "other",
  "tlsMode": "other",
  "scheme": "other",
  "trustProxy": "other",
  "canonicalPath": "other",
  "totalImported": "other",
  "totalSkipped": "other",
  "missing": "other",
  "failed": "other",
  "filePath": "other",
  "tokenCount": "other",
  "max_tokens": "other",
  "requestId": "other",
  "retryStatus": "other",
  "error": "content",
  "lines": "content",
  "proseLines": "content",
  "report": "content",
  "errors": "content",
  "announcement": "content",
  "stdout": "content",
  "message": "content",
  "ENOENT": "uncertain",
  "fields": "uncertain",
  "ledger": "uncertain",
  "sources": "uncertain",
  "unlockPassphrase": "secret",
  "privateSigningMaterial": "secret",
  "loginPassword": "secret",
  "shippingAddress": "owner_profile",
  "billing_address": "owner_profile"
} as const;
function privacyAnswers(body: unknown): { kind: PrivacyKind; answers: unknown } | undefined {
  const serialized = stable(body);
  const matches = (state: unknown, questions: unknown) => serialized === stable({ state, questions, model: modelTier.model });
  for (const [field, role] of Object.entries(privacyFieldRoles)) {
    if (!matches({ field }, { kind: fieldKind.items.kind.question })) continue;
    const probabilities = { secret: 0, owner_profile: 0, content: 0, other: 0 };
    if (role === 'uncertain') {
      return { kind: 'privacy-field', answers: { kind: { type: 'choice', choice: 'other', confidence: 0.25,
        probabilities: { secret: 0.25, owner_profile: 0.25, content: 0.25, other: 0.25 } } } };
    }
    probabilities[role] = 1;
    return { kind: 'privacy-field', answers: { kind: { type: 'choice', choice: role, confidence: 1, probabilities } } };
  }
  return undefined;
}

/** Exact captured synthetic requests, never an approval/classification shortcut. */
export function e2eJudgmentAnswers(body: unknown): { kind: 'tier' | 'identity' | 'planning-goal' | PrivacyKind; answers: unknown } | undefined {
  const privacy = privacyAnswers(body);
  if (privacy) return privacy;
  const serialized = stable(body);
  if (planningGoals.some(request => serialized === stable(request))) return { kind: 'planning-goal', answers: {
    goal: { type: 'noul', noul: 0.99 },
  } };
  if (serialized === stable(modelTier)) return { kind: 'tier', answers: {
    frontier: { type: 'noul', noul: 0 }, small: { type: 'noul', noul: 1 },
  } };
  if (serialized === stable(modelIdentity)) return { kind: 'identity', answers: {
    pick: { type: 'choice', choice: 'none', confidence: 1, probabilities: { 'gemini-2.5-pro': 0, 'mercury-2': 0, none: 1 } },
    fits_0: { type: 'noul', noul: 0 }, fits_1: { type: 'noul', noul: 0 },
  } };
  return undefined;
}

export function startE2EJudgments() {
  const accepted: string[] = [];
  const rejected: unknown[] = [];
  const unexpected: unknown[] = [];
  // Captured background registry probes intentionally receive no synthetic
  // classification. They stay unavailable; any new semantic request is a failure.
  const expectedNegative = new Set(unavailableModelRoutes.map(stable));
  // These exact startup notices may stay unclassified. Only their generated
  // session identifier varies; a new notice or question still fails the test.
  const noticeShape = (value: unknown) => stable(value).replace(/user-[a-f0-9]{8}/g, 'user-<id>');
  const expectedNoticeNegative = new Set(unavailableNotices.map(noticeShape));
  const expectedApplicability = new Set<string>();
  const expectedCompletions = new Set<string>();
  const completionAnswers = Object.fromEntries(Object.keys(headlessCompletion.questions).map(name => [name, { type: 'noul' as const, noul: 0.01 }]));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/systemone') return new Response('not found', { status: 404 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('invalid JSON', { status: 400 }); }
    const reading = expectedApplicability.has(stable(body))
      ? { kind: 'completion-applicability', answers: { completion_required: { type: 'noul' as const, noul: 0.99 } } }
      : expectedCompletions.has(completionShape(body))
      ? { kind: 'completion', answers: completionAnswers }
      : e2eJudgmentAnswers(body);
    if (!reading) {
      rejected.push(body);
      if (!expectedNegative.has(stable(body)) && !expectedNoticeNegative.has(noticeShape(body))) unexpected.push(body);
      return Response.json({ error: { message: 'Unknown deterministic E2E judgment; rejected' } }, { status: 422 });
    }
    accepted.push(reading.kind);
    return Response.json({ model: modelTier.model, answers: reading.answers, usage: { input_tokens: 10, output_tokens: 3 } });
  } });
  return { baseURL: `http://127.0.0.1:${server.port}`, accepted, rejected, unexpected,
    /** A plain text reply to `request` needs no task-fulfillment check: the completion applicability question is answered "no". */
    expectTextOnlyCompletion(request: string, response: string) {
      const replyTarget = (text: string) => ({ text });
      const target = replyTarget(request);
      const requirements = { ...headlessCompletion.state.requirements, originalTask: request };
      expectedApplicability.add(stable({ ...completionApplicability, questions: {
        completion_required: { ...completionApplicability.questions.completion_required, instructions: {
          ...completionApplicability.questions.completion_required.instructions,
          nativeTargets: { version: 1, currentUserRequest: target },
        } },
      }, state: { request, instructions: [request, request, request], requirements } }));
      const transcript = [{ role: 'user', content: request }];
      const questions = structuredClone(headlessCompletion.questions);
      for (const question of Object.values(questions)) {
        const targets: Record<string, unknown> = question.instructions.nativeTargets;
        if (response.length <= 4_000) targets['proposedAnswer'] = replyTarget(response);
        else Reflect.deleteProperty(targets, 'proposedAnswer');
        if (request.length <= 4_000) targets['currentUserRequest'] = target;
        else Reflect.deleteProperty(targets, 'currentUserRequest');
      }
      const completion = { ...headlessCompletion, questions, state: { ...headlessCompletion.state,
        request, response, transcript, tools: tuiCompletionTools, requirements,
        initial: { request, transcript },
      } };
      expectedCompletions.add(completionShape(completion));
      for (const notice of [tuiCompletionNotice, tuiPreviousSessionNotice]) {
        expectedCompletions.add(completionShape({ ...completion, state: { ...completion.state, transcript: [...transcript, notice] } }));
      }
    },
    assertNoUnexpected: () => { if (unexpected.length) throw new Error(`E2E encountered ${unexpected.length} unknown judgment request(s): ${JSON.stringify(unexpected)}`); },
    stop: () => server.stop(true),
  };
}
