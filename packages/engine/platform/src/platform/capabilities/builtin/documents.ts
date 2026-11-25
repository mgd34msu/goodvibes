/**
 * Document drafts: the Agent's Markdown drafts (versions, review comments,
 * suggested changes, artifacts placed in them, export) and the review packet
 * presets that gather a draft with its evidence, and sending a packet. The
 * drafts are kept per project (`<project>/.goodvibes/agent/documents/`, the
 * store every Agent turn in that project writes), managed by the daemon for
 * the asking program's project, or the daemon's own when none is given.
 */
import type { FixedChoice, InputDescription, ListName } from '../types.js';
import { artifactPick } from './artifacts.js';
import { countInput, fixedInput, pickedInput, storeCapability, storeRead, wordsInput } from './agent-stores.js';

/** Your drafts, a draft's open comments, and its suggestions waiting for you (terminal-shell's lists read them). */
export const DOCUMENTS_LIST = 'documents' as ListName;
export const DOCUMENT_COMMENTS_LIST = 'documents.comments' as ListName;
export const DOCUMENT_SUGGESTIONS_LIST = 'documents.suggestions' as ListName;

const DOCUMENT: InputDescription = pickedInput({ id: 'document', label: 'Draft', help: 'Your document drafts', list: DOCUMENTS_LIST, other: 'a draft id or exact title' });
const STATUSES: readonly FixedChoice[] = [{ value: 'draft', label: 'A draft' }, { value: 'reviewed', label: 'Reviewed' }, { value: 'archived', label: 'Put away' }];
const text = (id: string, label: string, help: string, flag: `--${string}`, means: string, kind: InputDescription['kind'] = 'text'): InputDescription =>
  wordsInput({ id, label, help, why: 'your own words', kind, typed: { flag }, optional: { default: '', means } });
const VERSION_NOTE = (means: string): InputDescription => text('note', 'Version note', 'A short note for the version history', '--note', means);
const SUGGESTION: InputDescription = pickedInput({ id: 'suggestion', label: 'Suggestion', help: 'Its suggestions waiting for you', list: DOCUMENT_SUGGESTIONS_LIST, dependsOn: 'document', other: 'a suggestion id such as s1', position: 2 });

export const DOCUMENTS_LIST_ALL = storeRead({
  id: 'documents.list', actionId: 'list', label: 'See your drafts', word: 'list',
  inputs: [
    wordsInput({ id: 'words', label: 'Words', help: 'What to look for in titles, text, status and tags', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'every draft' } }),
    countInput('limit', 'At most', 'How many to show', '--limit', '20', '20'),
  ],
  sentence: 'Lists your drafts that match {words}, with their versions, status and tags.', example: { words: 'launch' },
});
export const DOCUMENTS_SHOW = storeRead({
  id: 'documents.show', actionId: 'show', label: 'Read a draft', word: 'show',
  inputs: [DOCUMENT, fixedInput({
    id: 'versions', label: 'Its history', help: 'Whether to list its earlier versions too',
    choices: [{ value: 'yes', label: 'With its versions' }, { value: 'no', label: 'The draft only' }],
    typed: { flag: '--no-versions', switchOn: 'no' }, optional: { default: 'yes', means: 'with its versions' },
  })],
  sentence: 'Shows draft {document} in full, with its comments, suggestions and versions.', example: { document: 'launch-plan' },
});
export const DOCUMENTS_CREATE = storeCapability({
  id: 'documents.create', actionId: 'create', label: 'Write a new draft', word: 'create',
  inputs: [
    wordsInput({ id: 'title', label: 'Title', help: 'What the draft is called', why: 'your own words', typed: { flag: '--title' } }),
    wordsInput({ id: 'body', label: 'Text', help: 'The draft, in Markdown', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    text('tags', 'Tags', 'Words to find it by, separated by commas', '--tags', 'document'),
    VERSION_NOTE('"Initial draft."'),
  ],
  sentence: 'A draft "{title}" reading "{body}" is kept as its first version, until you change it.', example: { title: 'Launch plan', body: '# Launch plan' },
});
export const DOCUMENTS_REVISE = storeCapability({
  id: 'documents.revise', actionId: 'revise', label: 'Revise a draft', word: 'revise',
  inputs: [
    DOCUMENT,
    text('title', 'Title', 'A new title', '--title', 'keep it'),
    text('body', 'Text', 'The new text, in Markdown', '--body', 'keep it', 'long-text'),
    text('tags', 'Tags', 'New tags, separated by commas', '--tags', 'keep them'),
    fixedInput({ id: 'status', label: 'Status', help: 'A draft, reviewed, or put away', choices: STATUSES, typed: { flag: '--status' }, optional: { default: '', means: 'keep it' } }),
    VERSION_NOTE('"Updated draft."'),
  ],
  sentence: 'Draft {document} gets a new version with the changes given, until you change it.', example: { document: 'launch-plan', status: 'reviewed' },
});
export const DOCUMENTS_MARK_REVIEWED = storeCapability({
  id: 'documents.mark-reviewed', actionId: 'mark-reviewed', label: 'Mark a draft reviewed', word: 'mark-reviewed', inputs: [DOCUMENT],
  sentence: 'Draft {document} is marked reviewed, until you change it.', example: { document: 'launch-plan' }, repeat: 'safe',
});
export const DOCUMENTS_COMMENT = storeCapability({
  id: 'documents.comment', actionId: 'comment', label: 'Comment on a draft', word: 'comment',
  inputs: [DOCUMENT, wordsInput({ id: 'comment', label: 'Comment', help: 'Your note or the change you want', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
  sentence: 'The comment "{comment}" is added to draft {document}, until you change it; its text is unchanged.', example: { document: 'launch-plan', comment: 'Add a date.' },
});
export const DOCUMENTS_RESOLVE_COMMENT = storeCapability({
  id: 'documents.resolve-comment', actionId: 'resolve-comment', label: 'Resolve a comment', word: 'resolve-comment',
  inputs: [DOCUMENT, pickedInput({ id: 'comment', label: 'Comment', help: 'Its open comments', list: DOCUMENT_COMMENTS_LIST, dependsOn: 'document', other: 'a comment id such as c1', position: 2 })],
  sentence: 'Comment {comment} on draft {document} is marked resolved, until you change it.', example: { document: 'launch-plan', comment: 'c1' }, repeat: 'safe',
});
export const DOCUMENTS_SUGGEST = storeCapability({
  id: 'documents.suggest', actionId: 'suggest', label: 'Suggest a change to a draft', word: 'suggest',
  inputs: [
    DOCUMENT,
    wordsInput({ id: 'body', label: 'Suggested text', help: 'The whole draft as it would read, in Markdown', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    text('title', 'Suggested title', 'A new title', '--title', 'keep it'),
    text('tags', 'Suggested tags', 'New tags, separated by commas', '--tags', 'keep them'),
    fixedInput({ id: 'status', label: 'Suggested status', help: 'A draft, reviewed, or put away', choices: STATUSES, typed: { flag: '--status' }, optional: { default: '', means: 'keep it' } }),
    VERSION_NOTE('"Suggested revision."'),
    text('why', 'Why', 'Why this change helps', '--why', 'no reason given', 'long-text'),
  ],
  sentence: 'The suggested text "{body}" for draft {document} is kept for you to take or leave, until you change it; the draft is unchanged.', example: { document: 'launch-plan', body: 'Ship in May.' },
});
export const DOCUMENTS_ACCEPT_SUGGESTION = storeCapability({
  id: 'documents.accept-suggestion', actionId: 'accept-suggestion', label: 'Take a suggested change', word: 'accept-suggestion', inputs: [DOCUMENT, SUGGESTION],
  sentence: 'Suggestion {suggestion} becomes the new version of draft {document}, until you change it.', example: { document: 'launch-plan', suggestion: 's1' },
});
export const DOCUMENTS_REJECT_SUGGESTION = storeCapability({
  id: 'documents.reject-suggestion', actionId: 'reject-suggestion', label: 'Leave a suggested change', word: 'reject-suggestion', inputs: [DOCUMENT, SUGGESTION],
  sentence: 'Suggestion {suggestion} on draft {document} is set aside, until you change it; the draft is unchanged.', example: { document: 'launch-plan', suggestion: 's1' }, repeat: 'safe',
});
export const DOCUMENTS_INSERT_ARTIFACT = storeCapability({
  id: 'documents.insert-artifact', actionId: 'insert-artifact', label: 'Put an artifact into a draft', word: 'insert-artifact',
  inputs: [
    DOCUMENT,
    artifactPick({ typed: { position: 2 } }),
    fixedInput({
      id: 'placement', label: 'Where', help: 'At the end, at the start, or in place of the text',
      choices: [{ value: 'append', label: 'At the end' }, { value: 'prepend', label: 'At the start' }, { value: 'replace', label: 'In place of the text', help: 'The text is still in the earlier version.' }],
      typed: { flag: '--at' }, optional: { default: 'append', means: 'at the end' },
    }),
    text('heading', 'Heading', 'A heading above it', '--heading', 'none'),
    fixedInput({
      id: 'content', label: 'Its text', help: 'Put in a text artifact\'s text, or only a reference (binary artifacts are always a reference)',
      choices: [{ value: 'yes', label: 'Its text' }, { value: 'no', label: 'A reference only' }],
      typed: { flag: '--reference-only', switchOn: 'no' }, optional: { default: 'yes', means: 'its text' },
    }),
    VERSION_NOTE('"Inserted saved artifact."'),
  ],
  sentence: 'Artifact {artifact} is put into draft {document} as a new version, until you change it.', example: { document: 'launch-plan', artifact: 'artifact-123' },
});
export const DOCUMENTS_ATTACH_ARTIFACT = storeCapability({
  id: 'documents.attach-artifact', actionId: 'attach-artifact', label: 'Attach an artifact to a draft', word: 'attach-artifact',
  inputs: [
    DOCUMENT,
    artifactPick({ typed: { position: 2 } }),
    text('name', 'Label', 'A short name for it', '--label', 'its file name'),
    text('why', 'Note', 'Why it belongs with the draft', '--why', 'none', 'long-text'),
  ],
  sentence: 'Artifact {artifact} is attached to draft {document}, until you change it; the text is unchanged.', example: { document: 'launch-plan', artifact: 'artifact-123' },
});
export const DOCUMENTS_EXPORT = storeCapability({
  id: 'documents.export', actionId: 'export', label: 'Save a draft as an artifact', word: 'export', inputs: [DOCUMENT],
  sentence: 'Draft {document} is saved as a Markdown artifact with its version, until you change it.', example: { document: 'launch-plan' },
});
export const DOCUMENTS_SAVE_PRESET = storeCapability({
  id: 'documents.save-preset', actionId: 'save-preset', label: 'Save a review packet preset', word: 'save-preset',
  inputs: [
    wordsInput({ id: 'name', label: 'Name', help: 'What the preset is called', why: 'a name you choose', typed: { position: 1 } }),
    { ...DOCUMENT, required: { default: '', defaultMeans: 'none' }, typed: { flag: '--document' } },
    text('title', 'Draft title', 'The title shown in summaries', '--title', 'the draft\'s'),
    artifactPick({ id: 'export', label: 'Draft export', help: 'The saved export of the draft', typed: { flag: '--export' }, optional: { default: '', means: 'none' } }),
    artifactPick({ id: 'comparison', label: 'Comparison', help: 'The saved model comparison', typed: { flag: '--comparison' }, optional: { default: '', means: 'none' } }),
    artifactPick({ id: 'judgment', label: 'Judgment', help: 'The saved judgment of the comparison', typed: { flag: '--judgment' }, optional: { default: '', means: 'none' } }),
    artifactPick({ id: 'revealed', label: 'Revealed judgment', help: 'The judgment with the model names shown', typed: { flag: '--revealed' }, optional: { default: '', means: 'none' } }),
    artifactPick({ id: 'decision', label: 'Model decision', help: 'The saved decision about the model', typed: { flag: '--decision' }, optional: { default: '', means: 'none' } }),
    fixedInput({ id: 'outcome', label: 'Decided', help: 'What was decided about the model', choices: [{ value: 'left-unchanged', label: 'Left as it was' }, { value: 'applied-winner', label: 'Changed to the winner' }], typed: { flag: '--outcome' }, optional: { default: '', means: 'not said' } }),
    artifactPick({ id: 'handoff', label: 'Reviewer handoff', help: 'The saved reviewer handoff', typed: { flag: '--handoff' }, optional: { default: '', means: 'none' } }),
    artifactPick({ id: 'archive', label: 'Handoff archive', help: 'The saved handoff ZIP', typed: { flag: '--archive' }, optional: { default: '', means: 'none' } }),
    text('related', 'Other artifacts', 'Other evidence ids, separated by commas', '--related', 'none'),
    text('summary', 'Summary', 'One line shown in lists', '--summary', 'none'),
  ],
  sentence: 'A review packet preset {name} is kept with the artifacts given, until you change it.', example: { name: 'Launch review' },
});
export const DOCUMENTS_REFRESH_PRESET = storeCapability({
  id: 'documents.refresh-preset', actionId: 'refresh-preset', label: 'Refresh a review packet preset', word: 'refresh-preset',
  inputs: [
    artifactPick({ id: 'preset', label: 'Preset', help: 'The saved preset to bring up to date' }),
    text('name', 'New name', 'What the new preset is called', '--name', 'the old name, refreshed'),
    text('summary', 'New summary', 'One line shown in lists', '--summary', 'the old one, brought up to date'),
  ],
  sentence: 'A new preset is saved from preset {preset} with its out-of-date artifacts replaced, until you change it; the old one stays.', example: { preset: 'artifact-123' },
});
export const DOCUMENTS_SHARE_PACKET = storeCapability({
  id: 'documents.share-packet', actionId: 'share-packet', label: 'Send a review packet', word: 'share-packet',
  inputs: [
    artifactPick({ id: 'archive', label: 'Handoff archive', help: 'The saved reviewer handoff ZIP' }),
    fixedInput({
      id: 'via', label: 'Send through', help: 'A channel, a bound route, or a web address',
      choices: [{ value: 'channel', label: 'A channel', help: 'surface:route, such as slack:C123' }, { value: 'route', label: 'A bound route' }, { value: 'webhook', label: 'A web address (webhook)' }],
      typed: { position: 2 },
    }),
    wordsInput({ id: 'to', label: 'To', help: 'The channel (slack:C123), route id, or https address', why: 'where it goes', typed: { flag: '--to' } }),
    text('title', 'Title', 'The heading of the message', '--title', '"GoodVibes Agent review packet"'),
    text('message', 'Message', 'A note to go with it', '--message', 'none', 'long-text'),
  ],
  sentence: 'The review packet in {archive} is sent through {via} to {to}.', example: { archive: 'artifact-123', via: 'webhook', to: 'https://example.com/hook' },
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out',
});

// The review packet of your drafts, computed by the daemon from the drafts and the saved artifacts themselves.
export const DOCUMENTS_READINESS = storeRead({
  id: 'documents.readiness', actionId: 'readiness', label: 'Check a draft is ready for review', word: 'readiness', inputs: [],
  sentence: 'Lists what still stands in the way of review (open comments, suggestions waiting, missing sources, hidden comparisons, the handoff), each with what settles it.',
  example: {},
});

export const DOCUMENTS_PACKET_STEPS = storeRead({
  id: 'documents.packet-steps', actionId: 'packet-steps', label: 'See the review packet steps', word: 'packet-steps', inputs: [],
  sentence: 'Shows the review packet\'s steps in order (review, export, compare and judge, hand off, decide, archive), which are done, and what to do next.',
  example: {},
});

export const DOCUMENTS_TIMELINE = storeRead({
  id: 'documents.timeline', actionId: 'timeline', label: 'See the review packet timeline', word: 'timeline', inputs: [],
  sentence: 'Lists, oldest first and dated, what happened to the review packet: drafts, comments, suggestions, attachments, exports, comparisons, judgments, model decisions, presets and handoffs.',
  example: {},
});

export const DOCUMENTS_CAPABILITIES = [
  DOCUMENTS_LIST_ALL, DOCUMENTS_SHOW, DOCUMENTS_CREATE, DOCUMENTS_REVISE, DOCUMENTS_MARK_REVIEWED, DOCUMENTS_COMMENT, DOCUMENTS_RESOLVE_COMMENT,
  DOCUMENTS_SUGGEST, DOCUMENTS_ACCEPT_SUGGESTION, DOCUMENTS_REJECT_SUGGESTION, DOCUMENTS_INSERT_ARTIFACT, DOCUMENTS_ATTACH_ARTIFACT, DOCUMENTS_EXPORT,
  DOCUMENTS_SAVE_PRESET, DOCUMENTS_REFRESH_PRESET, DOCUMENTS_SHARE_PACKET, DOCUMENTS_READINESS, DOCUMENTS_PACKET_STEPS, DOCUMENTS_TIMELINE,
] as const;
