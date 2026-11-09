import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { composeDraftReply, extractStyleProfile, type StyleReplyMessage, type StyleSentMessage } from '@goodvibes-jev/engine/platform/platform/email';
import { isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { assertJudgmentInput, retainStrictJudgmentJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { PersonalOpsLiveRecord, PersonalOpsWorkflow } from './agent-harness-personal-ops-types.ts';

export const STYLE_DRAFT_RECORD_ID = 'inbox-style-reply-draft';

export function personalOpsStyleDraftRecord(): PersonalOpsLiveRecord {
  return {
    id: STYLE_DRAFT_RECORD_ID, label: 'Draft reply in my writing style', status: 'ready',
    summary: isClassicOperation()
      ? 'Return a protected draft using the default template and supplied key points. Writing style and personal salutation are not inferred in Classic.'
      : 'Read an explicitly supplied sent-message corpus and inbound message under protected semantic readings, then return a draft for review.',
    userRoute: 'Agent Workspace -> Personal Ops -> Inbox -> Draft reply in my writing style',
    modelRoute: `personal_ops action:"read" laneId:"inbox" recordId:"${STYLE_DRAFT_RECORD_ID}"`,
    effect: 'read-only', capability: 'inbox-style-reply-draft', confirmationRequired: false,
    requiredFields: ['inbound', 'sentMessages'], optionalFields: ['context'],
    sampleInput: { inbound: { from: 'Alice Smith <alice@example.com>', subject: 'Project update', bodyPreview: 'Is the project on track?' },
      sentMessages: [{ bodyPreview: 'Hi Alice,\nThe milestone is ready.\nThanks' }], context: 'The milestone is ready.' },
    tags: ['style-reply', 'draft', 'inbox'],
  };
}
export function personalOpsStyleDraftWorkflow(): PersonalOpsWorkflow {
  return {
    id: 'inbox-style-matched-draft-reply', label: 'Writing-style-matched draft reply', status: 'ready',
    summary: isClassicOperation()
      ? 'Classic uses a default template with supplied key points; it does not learn style from the corpus. The draft remains separate from delivery.'
      : 'Use the provided corpus, not an assumed sent mailbox. The draft remains separate from delivery.',
    next: 'Supply the full inbound message, sent-message bodies and optional key points. Review the returned draft before choosing any separately admitted send route.',
    modelRoute: personalOpsStyleDraftRecord().modelRoute,
    inspectRoutes: ['personal_ops action:"lane" laneId:"inbox"'],
    prerequisites: ['Explicit inbound message and sent-message corpus', isClassicOperation() ? 'Current protected source owner; Classic template is not a learned style' : 'Current protected source owner and settled style readings'],
    runBoundary: 'Read and draft only. Source ownership and privacy checks remain required; Classic returns an unassessed template. Sending has its own effect admission.',
  };
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function message(value: unknown): value is StyleReplyMessage {
  return plain(value) && typeof value.from === 'string' && typeof value.subject === 'string' && typeof value.bodyPreview === 'string';
}
function sentMessage(value: unknown): value is StyleSentMessage {
  return plain(value) && typeof value.bodyPreview === 'string';
}

/** The registered parent owns admission; this helper never reads a provider or sends mail. */
export async function runPersonalOpsStyleDraft(fields: unknown, options: CatalogRankingOptions): Promise<Record<string, unknown>> {
  return withConfiguredDecisionModelPolicy(async () => {
    const optionsCurrent = captureCatalogMethods(options, ['sourceOwner', 'signal', 'assertCurrent', 'retainCurrent']);
    const signal = options.signal, caller = options.assertCurrent, retain = options.retainCurrent, owner = options.sourceOwner;
    const source = retainStrictJudgmentJson(fields, () => new ToolInputProjectionError('invalid'));
    const input = source.snapshot;
    if (!plain(input) || Object.keys(input).some(key => key !== 'inbound' && key !== 'sentMessages' && key !== 'context')
      || !message(input.inbound) || !Array.isArray(input.sentMessages) || !input.sentMessages.every(sentMessage)
      || (input.context !== undefined && typeof input.context !== 'string')) throw new ToolInputProjectionError('invalid');
    const current = () => {
      optionsCurrent(); source.assertCurrent(); signal?.throwIfAborted();
      const returned: unknown = caller?.();
      if (returned !== undefined) { drainOwned(returned); throw new ToolInputProjectionError('held'); }
      optionsCurrent(); source.assertCurrent(); signal?.throwIfAborted();
    };
    current();
    const reading = { signal, sourceOwner: owner, assertCurrent: current, retainCurrent: retain };
    const profile = await extractStyleProfile(input.sentMessages, reading);
    current();
    const draft = await composeDraftReply(input.inbound, profile, input.context ?? '', text => {
      try { assertJudgmentInput(text); return false; } catch { return true; }
    }, reading);
    current();
    retain?.(() => { optionsCurrent(); source.assertCurrent(); signal?.throwIfAborted(); });
    return {
      status: 'drafted', recordId: STYLE_DRAFT_RECORD_ID, draft,
      ...(draft.provenance === 'classic' ? { provenance: 'classic', styleAssessment: 'not-evaluated' } : {}),
      corpusSource: 'explicitly-supplied-sent-messages', sentMessageCount: input.sentMessages.length,
      policy: 'This operation produces a draft only. It neither reads an unselected mailbox nor sends mail. Delivery requires a separate current recorded effect admission.',
    };
  });
}
