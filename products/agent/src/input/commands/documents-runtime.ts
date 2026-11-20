/**
 * `/documents`, described once (command-actions/): the Agent's own Markdown
 * drafts (versions, review comments, suggested changes, artifacts placed in
 * them, export) and the review packet that gathers a draft with its
 * comparison, judgment and reviewer handoff. Each action is one call of an
 * Agent tool, run as the owner's own act (owner-tool-call.ts).
 */
import { AgentDocumentRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/document-registry';
import { defineCommand, defineList, type ActionDescription, type FixedChoice, type InputDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { artifactInput } from './artifacts-runtime.ts';
import { given, ownerRead, ownerToolCall, positiveNumber, runOwnerToolCall, splitWords } from './owner-tool-call.ts';

const TOOL = 'agent_documents';
const LOCAL_ONLY = { terminalOnly: 'Document drafts are kept in this Agent\'s home.' } as const;

function documentsOf(ctx: CommandContext): AgentDocumentRegistry {
  return AgentDocumentRegistry.fromShellPaths(requireShellPaths(ctx));
}

const DOCUMENTS = defineList<CommandContext>({
  name: 'documents',
  async read(ctx) {
    return documentsOf(ctx).list().map((doc): ListRow => ({ value: doc.id, label: doc.title, detail: `${doc.versionCount} version${doc.versionCount === 1 ? '' : 's'}`, state: doc.status }));
  },
  operator: LOCAL_ONLY,
});
const OPEN_COMMENTS = defineList<CommandContext>({
  name: 'documents.comments',
  async read(ctx, earlier) {
    const doc = earlier.document ? documentsOf(ctx).get(earlier.document) : null;
    return (doc?.comments ?? []).filter((comment) => comment.status !== 'resolved')
      .map((comment): ListRow => ({ value: comment.id, label: comment.body.replace(/\s+/g, ' ').slice(0, 80), state: comment.status }));
  },
  operator: LOCAL_ONLY,
});
const PENDING_SUGGESTIONS = defineList<CommandContext>({
  name: 'documents.suggestions',
  async read(ctx, earlier) {
    const doc = earlier.document ? documentsOf(ctx).get(earlier.document) : null;
    return (doc?.suggestions ?? []).filter((suggestion) => suggestion.status === 'proposed')
      .map((suggestion): ListRow => ({ value: suggestion.id, label: suggestion.summary || suggestion.title, state: suggestion.status }));
  },
  operator: LOCAL_ONLY,
});

const DOCUMENT: InputDescription = listInput({ id: 'document', label: 'Draft', help: 'Your document drafts', list: DOCUMENTS, other: 'a draft id or exact title' });
const STATUSES: readonly FixedChoice[] = [{ value: 'draft', label: 'A draft' }, { value: 'reviewed', label: 'Reviewed' }, { value: 'archived', label: 'Put away' }];
const text = (id: string, label: string, help: string, flag: `--${string}`, means: string, kind: InputDescription['kind'] = 'text'): InputDescription =>
  textInput({ id, label, help, why: 'your own words', kind, typed: { flag }, optional: { default: '', means } });
const VERSION_NOTE = (means: string): InputDescription => text('note', 'Version note', 'A short note for the version history', '--note', means);

type DocumentAction = ActionDescription<CommandContext>;
/** A change to a draft: one call of agent_documents in `mode`, kept until changed. */
function draftChange(fields: Pick<DocumentAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example'> & Partial<Pick<DocumentAction, 'risk' | 'undoneBy' | 'touches'>>, mode: string, args: (values: Readonly<Record<string, string>>) => Record<string, unknown>): DocumentAction {
  return {
    done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ownerOnly: ownerToolCall(TOOL), ...fields,
    async run(values, ctx) {
      return runOwnerToolCall(ctx, TOOL, { mode, ...args(values), confirm: true, explicitUserRequest: `${fields.label}: ${values.document ?? values.title ?? ''}` }, fields.label.toLowerCase());
    },
  };
}

/** The packet tools' answer for a lane read of agent_harness (the review readiness and the packet steps). */
function laneRead(id: string, label: string, word: string, sentence: string, laneId: string): DocumentAction {
  return ownerRead('agent_harness', readAction<CommandContext>({
    id, label, word, sentence, operator: LOCAL_ONLY,
    async run(_values, ctx) { return runOwnerToolCall(ctx, 'agent_harness', { mode: 'document_ops_lane', laneId, includeParameters: true }, label.toLowerCase()); },
  }));
}

export function registerDocumentsRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'documents',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Documents',
    summary: 'Your Markdown drafts: write, revise, comment, take or leave suggested changes, place artifacts in them, and export',
    group: 'Agent',
    report: 'list',
    firstScreenRows: [
      'list', 'show', 'create', 'revise', 'export',
      { label: 'Review a draft…', actions: ['mark-reviewed', 'comment', 'resolve-comment', 'suggest', 'accept-suggestion', 'reject-suggestion'] },
      { label: 'Put an artifact in a draft…', actions: ['insert-artifact', 'attach-artifact'] },
      { label: 'Review packet…', actions: ['readiness', 'packet-steps', 'save-preset', 'refresh-preset', 'share-packet'] },
    ],
    actions: [
      ownerRead(TOOL, readAction<CommandContext>({
        id: 'list', label: 'See your drafts', word: 'list', operator: LOCAL_ONLY,
        inputs: [
          textInput({ id: 'words', label: 'Words', help: 'What to look for in titles, text, status and tags', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'every draft' } }),
          { id: 'limit', label: 'At most', help: 'How many to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '20', defaultMeans: '20' }, typed: { flag: '--limit' } },
        ],
        sentence: 'Lists your drafts that match {words}, with their versions, status and tags.', example: { words: 'launch' },
        async rowValue(ctx) { const count = documentsOf(ctx).list().length; return count === 1 ? '1 draft' : `${count} drafts`; },
        async run(values, ctx) {
          const limit = positiveNumber(values.limit);
          return runOwnerToolCall(ctx, TOOL, { mode: 'list', ...(values.words ? { query: values.words } : {}), ...(limit ? { limit } : {}) }, 'list document drafts');
        },
      })),
      ownerRead(TOOL, readAction<CommandContext>({
        id: 'show', label: 'Read a draft', word: 'show', operator: LOCAL_ONLY,
        inputs: [DOCUMENT, choiceInput({
          id: 'versions', label: 'Its history', help: 'Whether to list its earlier versions too',
          choices: [{ value: 'yes', label: 'With its versions' }, { value: 'no', label: 'The draft only' }],
          typed: { flag: '--no-versions', switchOn: 'no' }, optional: { default: 'yes', means: 'with its versions' },
        })],
        sentence: 'Shows draft {document} in full, with its comments, suggestions and versions.', example: { document: 'launch-plan' },
        async run(values, ctx) { return runOwnerToolCall(ctx, TOOL, { mode: 'show', documentId: values.document!, includeVersions: values.versions !== 'no' }, `show draft ${values.document}`); },
      })),
      draftChange({
        id: 'create', label: 'Write a new draft', word: 'create',
        inputs: [
          textInput({ id: 'title', label: 'Title', help: 'What the draft is called', why: 'your own words', typed: { flag: '--title' } }),
          textInput({ id: 'body', label: 'Text', help: 'The draft, in Markdown', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          text('tags', 'Tags', 'Words to find it by, separated by commas', '--tags', 'document'),
          VERSION_NOTE('"Initial draft."'),
        ],
        sentence: 'A draft "{title}" is kept with its first version, until you change it.', example: { title: 'Launch plan', body: '# Launch plan' },
      }, 'create', (values) => ({ title: values.title, body: values.body, tags: values.tags ? splitWords(values.tags) : ['document'], changeSummary: values.note || 'Initial draft.' })),
      draftChange({
        id: 'revise', label: 'Revise a draft', word: 'revise',
        inputs: [
          DOCUMENT,
          text('title', 'Title', 'A new title', '--title', 'keep it'),
          text('body', 'Text', 'The new text, in Markdown', '--body', 'keep it', 'long-text'),
          text('tags', 'Tags', 'New tags, separated by commas', '--tags', 'keep them'),
          choiceInput({ id: 'status', label: 'Status', help: 'A draft, reviewed, or put away', choices: STATUSES, typed: { flag: '--status' }, optional: { default: '', means: 'keep it' } }),
          VERSION_NOTE('"Updated draft."'),
        ],
        sentence: 'Draft {document} gets a new version with the changes given, until you change it.', example: { document: 'launch-plan', status: 'reviewed' },
      }, 'update', (values) => ({ documentId: values.document, ...given(values, 'title', 'body', 'status'), ...(values.tags ? { tags: splitWords(values.tags) } : {}), changeSummary: values.note || 'Updated draft.' })),
      draftChange({
        id: 'mark-reviewed', label: 'Mark a draft reviewed', word: 'mark-reviewed', inputs: [DOCUMENT],
        sentence: 'Draft {document} is marked reviewed, until you change it.', example: { document: 'launch-plan' },
      }, 'review', (values) => ({ documentId: values.document })),
      draftChange({
        id: 'comment', label: 'Comment on a draft', word: 'comment',
        inputs: [DOCUMENT, textInput({ id: 'comment', label: 'Comment', help: 'Your note or the change you want', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: 'The comment "{comment}" is added to draft {document}, until you change it; its text is unchanged.', example: { document: 'launch-plan', comment: 'Add a date.' },
      }, 'comment', (values) => ({ documentId: values.document, comment: values.comment })),
      draftChange({
        id: 'resolve-comment', label: 'Resolve a comment', word: 'resolve-comment',
        inputs: [DOCUMENT, listInput({ id: 'comment', label: 'Comment', help: 'Its open comments', list: OPEN_COMMENTS, dependsOn: 'document', other: 'a comment id such as c1', position: 2 })],
        sentence: 'Comment {comment} on draft {document} is marked resolved, until you change it.', example: { document: 'launch-plan', comment: 'c1' },
      }, 'resolveComment', (values) => ({ documentId: values.document, commentId: values.comment })),
      draftChange({
        id: 'suggest', label: 'Suggest a change to a draft', word: 'suggest',
        inputs: [
          DOCUMENT,
          textInput({ id: 'body', label: 'Suggested text', help: 'The whole draft as it would read, in Markdown', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          text('title', 'Suggested title', 'A new title', '--title', 'keep it'),
          text('tags', 'Suggested tags', 'New tags, separated by commas', '--tags', 'keep them'),
          choiceInput({ id: 'status', label: 'Suggested status', help: 'A draft, reviewed, or put away', choices: STATUSES, typed: { flag: '--status' }, optional: { default: '', means: 'keep it' } }),
          VERSION_NOTE('"Suggested revision."'),
          text('why', 'Why', 'Why this change helps', '--why', 'no reason given', 'long-text'),
        ],
        sentence: 'A suggested new text for draft {document} is kept for you to take or leave, until you change it; the draft is unchanged.', example: { document: 'launch-plan', body: '# Launch plan\n\nShip in May.' },
      }, 'suggest', (values) => ({
        documentId: values.document, body: values.body, ...given(values, 'title', 'status'), ...(values.tags ? { tags: splitWords(values.tags) } : {}),
        changeSummary: values.note || 'Suggested revision.', ...(values.why ? { suggestionRationale: values.why } : {}),
      })),
      draftChange({
        id: 'accept-suggestion', label: 'Take a suggested change', word: 'accept-suggestion',
        inputs: [DOCUMENT, listInput({ id: 'suggestion', label: 'Suggestion', help: 'Its suggestions waiting for you', list: PENDING_SUGGESTIONS, dependsOn: 'document', other: 'a suggestion id such as s1', position: 2 })],
        sentence: 'Suggestion {suggestion} becomes the new version of draft {document}, until you change it.', example: { document: 'launch-plan', suggestion: 's1' },
      }, 'acceptSuggestion', (values) => ({ documentId: values.document, suggestionId: values.suggestion })),
      draftChange({
        id: 'reject-suggestion', label: 'Leave a suggested change', word: 'reject-suggestion',
        inputs: [DOCUMENT, listInput({ id: 'suggestion', label: 'Suggestion', help: 'Its suggestions waiting for you', list: PENDING_SUGGESTIONS, dependsOn: 'document', other: 'a suggestion id such as s1', position: 2 })],
        sentence: 'Suggestion {suggestion} on draft {document} is set aside, until you change it; the draft is unchanged.', example: { document: 'launch-plan', suggestion: 's1' },
      }, 'rejectSuggestion', (values) => ({ documentId: values.document, suggestionId: values.suggestion })),
      draftChange({
        id: 'insert-artifact', label: 'Put an artifact into a draft', word: 'insert-artifact',
        inputs: [
          DOCUMENT,
          artifactInput({ typed: { position: 2 } }),
          choiceInput({
            id: 'placement', label: 'Where', help: 'At the end, at the start, or in place of the text',
            choices: [{ value: 'append', label: 'At the end' }, { value: 'prepend', label: 'At the start' }, { value: 'replace', label: 'In place of the text', help: 'The text is still in the earlier version.' }],
            typed: { flag: '--at' }, optional: { default: 'append', means: 'at the end' },
          }),
          text('heading', 'Heading', 'A heading above it', '--heading', 'none'),
          choiceInput({
            id: 'content', label: 'Its text', help: 'Put in a text artifact\'s text, or only a reference (binary artifacts are always a reference)',
            choices: [{ value: 'yes', label: 'Its text' }, { value: 'no', label: 'A reference only' }],
            typed: { flag: '--reference-only', switchOn: 'no' }, optional: { default: 'yes', means: 'its text' },
          }),
          VERSION_NOTE('"Inserted saved artifact."'),
        ],
        sentence: 'Artifact {artifact} is put into draft {document} as a new version, until you change it.', example: { document: 'launch-plan', artifact: 'artifact-123' },
      }, 'insertArtifact', (values) => ({
        documentId: values.document, artifactId: values.artifact, placement: values.placement || 'append', ...(values.heading ? { sectionTitle: values.heading } : {}),
        includeContent: values.content !== 'no', changeSummary: values.note || 'Inserted saved artifact.',
      })),
      draftChange({
        id: 'attach-artifact', label: 'Attach an artifact to a draft', word: 'attach-artifact',
        inputs: [
          DOCUMENT,
          artifactInput({ typed: { position: 2 } }),
          text('name', 'Label', 'A short name for it', '--label', 'its file name'),
          text('why', 'Note', 'Why it belongs with the draft', '--why', 'none', 'long-text'),
        ],
        sentence: 'Artifact {artifact} is attached to draft {document}, until you change it; the text is unchanged.', example: { document: 'launch-plan', artifact: 'artifact-123' },
      }, 'attachArtifact', (values) => ({ documentId: values.document, artifactId: values.artifact, ...(values.name ? { attachmentLabel: values.name } : {}), ...(values.why ? { attachmentNote: values.why } : {}) })),
      draftChange({
        id: 'export', label: 'Save a draft as an artifact', word: 'export', inputs: [DOCUMENT],
        sentence: 'Draft {document} is saved as a Markdown artifact with its version, until you change it.', example: { document: 'launch-plan' },
      }, 'export', (values) => ({ documentId: values.document })),
      laneRead('readiness', 'Check a draft is ready for review', 'readiness',
        'Lists what still stands in the way of review: open comments, suggestions waiting, missing sources, hidden comparisons and the handoff.', 'reviewer_readiness'),
      laneRead('packet-steps', 'See the review packet steps', 'packet-steps',
        'Shows the review packet\'s steps (review, export, compare, judge, hand off, decide, archive), which are done, and the next one.', 'review_packet_wizard'),
      {
        id: 'save-preset', label: 'Save a review packet preset', word: 'save-preset',
        inputs: [
          textInput({ id: 'name', label: 'Name', help: 'What the preset is called', why: 'a name you choose', typed: { position: 1 } }),
          { ...DOCUMENT, required: { default: '', defaultMeans: 'none' }, typed: { flag: '--document' } },
          text('title', 'Draft title', 'The title shown in summaries', '--title', 'the draft\'s'),
          artifactInput({ id: 'export', label: 'Draft export', help: 'The saved export of the draft', typed: { flag: '--export' }, optional: { default: '', means: 'none' } }),
          artifactInput({ id: 'comparison', label: 'Comparison', help: 'The saved model comparison', typed: { flag: '--comparison' }, optional: { default: '', means: 'none' } }),
          artifactInput({ id: 'judgment', label: 'Judgment', help: 'The saved judgment of the comparison', typed: { flag: '--judgment' }, optional: { default: '', means: 'none' } }),
          artifactInput({ id: 'revealed', label: 'Revealed judgment', help: 'The judgment with the model names shown', typed: { flag: '--revealed' }, optional: { default: '', means: 'none' } }),
          artifactInput({ id: 'decision', label: 'Model decision', help: 'The saved decision about the model', typed: { flag: '--decision' }, optional: { default: '', means: 'none' } }),
          choiceInput({ id: 'outcome', label: 'Decided', help: 'What was decided about the model', choices: [{ value: 'left-unchanged', label: 'Left as it was' }, { value: 'applied-winner', label: 'Changed to the winner' }], typed: { flag: '--outcome' }, optional: { default: '', means: 'not said' } }),
          artifactInput({ id: 'handoff', label: 'Reviewer handoff', help: 'The saved reviewer handoff', typed: { flag: '--handoff' }, optional: { default: '', means: 'none' } }),
          artifactInput({ id: 'archive', label: 'Handoff archive', help: 'The saved handoff ZIP', typed: { flag: '--archive' }, optional: { default: '', means: 'none' } }),
          text('related', 'Other artifacts', 'Other evidence ids, separated by commas', '--related', 'none'),
          text('summary', 'Summary', 'One line shown in lists', '--summary', 'none'),
        ],
        sentence: 'A review packet preset {name} is kept with the artifacts given, until you change it.', example: { name: 'Launch review' },
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ownerOnly: ownerToolCall('agent_review_packet_presets'),
        async run(values, ctx) {
          return runOwnerToolCall(ctx, 'agent_review_packet_presets', {
            mode: 'save', name: values.name,
            ...(values.document ? { documentId: values.document } : {}), ...(values.title ? { documentTitle: values.title } : {}),
            ...(values.export ? { documentExportArtifactId: values.export } : {}), ...(values.comparison ? { comparisonArtifactId: values.comparison } : {}),
            ...(values.judgment ? { judgmentArtifactId: values.judgment } : {}), ...(values.revealed ? { revealedJudgmentArtifactId: values.revealed } : {}),
            ...(values.decision ? { routeDecisionArtifactId: values.decision } : {}), ...(values.outcome ? { routeDecision: values.outcome } : {}),
            ...(values.handoff ? { handoffArtifactId: values.handoff } : {}), ...(values.archive ? { handoffArchiveArtifactId: values.archive } : {}),
            relatedArtifactIds: splitWords(values.related), ...(values.summary ? { summary: values.summary } : {}),
            confirm: true, explicitUserRequest: `Save review packet preset ${values.name}.`,
          }, `save review packet preset ${values.name}`);
        },
      },
      {
        id: 'refresh-preset', label: 'Refresh a review packet preset', word: 'refresh-preset',
        inputs: [
          artifactInput({ id: 'preset', label: 'Preset', help: 'The saved preset to bring up to date' }),
          text('name', 'New name', 'What the new preset is called', '--name', 'the old name, refreshed'),
          text('summary', 'New summary', 'One line shown in lists', '--summary', 'the old one, brought up to date'),
        ],
        sentence: 'A new preset is saved from preset {preset} with its out-of-date artifacts replaced, until you change it; the old one stays.', example: { preset: 'artifact-123' },
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ownerOnly: ownerToolCall('agent_review_packet_presets'),
        async run(values, ctx) {
          return runOwnerToolCall(ctx, 'agent_review_packet_presets', {
            mode: 'refresh', artifactId: values.preset, ...given(values, 'name', 'summary'), confirm: true, explicitUserRequest: `Refresh review packet preset ${values.preset}.`,
          }, `refresh review packet preset ${values.preset}`);
        },
      },
      {
        id: 'share-packet', label: 'Send a review packet', word: 'share-packet',
        inputs: [
          artifactInput({ id: 'archive', label: 'Handoff archive', help: 'The saved reviewer handoff ZIP' }),
          choiceInput({
            id: 'via', label: 'Send through', help: 'A channel, a bound route, or a web address',
            choices: [{ value: 'channel', label: 'A channel', help: 'surface:route, such as slack:C123' }, { value: 'route', label: 'A bound route' }, { value: 'webhook', label: 'A web address (webhook)' }],
            typed: { position: 2 },
          }),
          textInput({ id: 'to', label: 'To', help: 'The channel (slack:C123), route id, or https address', why: 'where it goes', typed: { flag: '--to' } }),
          text('title', 'Title', 'The heading of the message', '--title', '"GoodVibes Agent review packet"'),
          text('message', 'Message', 'A note to go with it', '--message', 'none', 'long-text'),
        ],
        sentence: 'The review packet in {archive} is sent through {via} to {to}.', example: { archive: 'artifact-123', via: 'webhook', to: 'https://example.com/hook' },
        done: '', touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out', operator: LOCAL_ONLY, ownerOnly: ownerToolCall('agent_review_packet_share'),
        async run(values, ctx) {
          return runOwnerToolCall(ctx, 'agent_review_packet_share', {
            archiveArtifactId: values.archive, [values.via === 'route' ? 'route' : values.via === 'webhook' ? 'webhook' : 'channel']: values.to,
            ...given(values, 'title', 'message'), confirm: true, explicitUserRequest: `Send review packet ${values.archive} to ${values.to}.`,
          }, `send review packet ${values.archive}`);
        },
      },
    ],
  }));
}
