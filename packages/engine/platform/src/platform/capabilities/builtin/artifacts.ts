/**
 * Saved artifacts: the uploads, exports, generated media, reports and
 * comparisons in the daemon's artifact store (`~/.goodvibes/tui/artifacts/`,
 * the one the terminal app and the daemon's own turns already write, and the
 * Agent's now too), and copying them out to files of the asking program's
 * project.
 */
import { REPLACED_DONE, type InputDescription, type ListName } from '../types.js';
import { countInput, fixedInput, pickedInput, storeCapability, storeRead, wordsInput } from './agent-stores.js';

/** Your saved artifacts, newest first (terminal-shell's list reads them from artifacts.list). */
export const ARTIFACTS_LIST = 'artifacts' as ListName;

/** One saved artifact, by id. */
export function artifactPick(fields: { readonly id?: string; readonly label?: string; readonly help?: string; readonly typed?: InputDescription['typed']; readonly optional?: { readonly default: string; readonly means: string } } = {}): InputDescription {
  return pickedInput({
    id: fields.id ?? 'artifact', label: fields.label ?? 'Artifact', help: fields.help ?? 'Your saved artifacts', list: ARTIFACTS_LIST, other: 'an artifact id',
    ...(fields.optional ? { optional: fields.optional } : {}), ...(fields.typed ? { typed: fields.typed } : {}),
  });
}

const OVERWRITE: InputDescription = fixedInput({
  id: 'overwrite', label: 'If something is there', help: 'Stop, or put this in its place',
  choices: [{ value: 'no', label: 'Stop and change nothing' }, { value: 'yes', label: 'Put this in its place', help: 'What is there now is lost.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE }],
  typed: { flag: '--overwrite', switchOn: 'yes' }, optional: { default: 'no', means: 'stop and change nothing' },
});
const optional = (means: string) => ({ default: '', means });

export const ARTIFACTS_LIST_ALL = storeRead({
  id: 'artifacts.list', actionId: 'list', label: 'See your saved artifacts', word: 'list',
  inputs: [
    wordsInput({ id: 'words', label: 'Words', help: 'What to look for in names, types and where they came from', why: 'your own words', typed: { tail: true }, optional: optional('every artifact') }),
    fixedInput({
      id: 'kind', label: 'Kind', help: 'Only one kind of artifact',
      choices: ['file', 'image', 'audio', 'video', 'document', 'archive', 'data'].map((kind) => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) })),
      typed: { flag: '--kind' }, optional: optional('every kind'),
    }),
    wordsInput({ id: 'mimeType', label: 'File type', help: 'Part of its type, such as markdown, json or pdf', why: 'a file type', typed: { flag: '--type' }, optional: optional('any type') }),
    wordsInput({ id: 'purpose', label: 'Made for', help: 'What it was saved for, such as agent-model-compare', why: 'a purpose word', typed: { flag: '--purpose' }, optional: optional('anything') }),
    wordsInput({ id: 'source', label: 'Came from', help: 'Where it came from (a web address or a source name)', why: 'a source', typed: { flag: '--source' }, optional: optional('anywhere') }),
    countInput('limit', 'At most', 'How many to show', '--limit', '25', '25'),
    countInput('from', 'Starting after', 'How many of the newest to skip, to see older ones', '--from', '0', 'the newest'),
  ],
  sentence: 'Lists your saved artifacts that match {words}, newest first.', example: { words: 'report' },
});
export const ARTIFACTS_SHOW = storeRead({
  id: 'artifacts.show', actionId: 'show', label: 'Look at one artifact', word: 'show',
  inputs: [
    artifactPick(),
    fixedInput({
      id: 'preview', label: 'Show its text', help: 'A short preview of a text artifact; binary content is never shown',
      choices: [{ value: 'yes', label: 'Show a preview' }, { value: 'no', label: 'Details only' }],
      typed: { flag: '--no-preview', switchOn: 'no' }, optional: { default: 'yes', means: 'show a preview' },
    }),
    countInput('bytes', 'Preview length', 'How many bytes of text to show', '--bytes', '2048', '2048 bytes'),
  ],
  sentence: 'Shows artifact {artifact}: what it is, where it came from, and a short preview of its text.', example: { artifact: 'artifact-123' },
});
export const ARTIFACTS_EXPORT = storeCapability({
  id: 'artifacts.export', actionId: 'export', label: 'Copy an artifact to a file', word: 'export',
  inputs: [
    artifactPick(),
    { ...wordsInput({ id: 'path', label: 'File', help: 'Where in this workspace, such as exports/report.md', why: 'a file path', kind: 'path', typed: { position: 2 } }), file: 'written' },
    OVERWRITE,
  ],
  sentence: 'Artifact {artifact} is copied, byte for byte, to {path} in this workspace, until you change it.', example: { artifact: 'artifact-123', path: 'exports/report.md' },
});
export const ARTIFACTS_PACKAGE = storeCapability({
  id: 'artifacts.package', actionId: 'package', label: 'Copy several artifacts into a package', word: 'package',
  inputs: [
    wordsInput({ id: 'artifacts', label: 'Artifacts', help: 'Their ids, separated by commas', why: 'several artifact ids', typed: { position: 1 } }),
    { ...wordsInput({ id: 'path', label: 'Folder or ZIP file', help: 'Where in this workspace, such as exports/research-package or exports/research.zip', why: 'a path', kind: 'path', typed: { position: 2 } }), file: 'written', workFolder: false },
    fixedInput({
      id: 'format', label: 'As', help: 'A folder you can look through, or one ZIP file',
      choices: [{ value: 'directory', label: 'A folder' }, { value: 'zip', label: 'One ZIP file' }],
      typed: { flag: '--as' }, optional: { default: 'directory', means: 'a folder' },
    }),
    OVERWRITE,
  ],
  sentence: 'Artifacts {artifacts} are copied into {path}, with a list of what is in it, until you change it.', example: { artifacts: 'artifact-1,artifact-2', path: 'exports/package' },
});

/**
 * A turn's artifact saved in the daemon's one store: what a terminal program's turn makes (generated media, a model
 * comparison, a research report) is saved through this, so the daemon holds it and announces it (an open Artifacts list
 * follows with no key), and the program takes it up from the same folder (ArtifactStore `routeCreate`, `takeUp`).
 */
export const ARTIFACTS_SAVE = storeCapability({
  id: 'artifacts.save', actionId: 'save', label: 'Save an artifact', word: 'save',
  inputs: [
    { id: 'content', label: 'Content', help: 'What to keep: text, or base64 for anything else', kind: 'long-text', freeTextReason: 'what is kept', required: true, typed: { tail: true } },
    fixedInput({
      id: 'encoding', label: 'Written as', help: 'Whether the content is plain text or base64',
      choices: [{ value: 'text', label: 'Plain text' }, { value: 'base64', label: 'Base64' }], typed: { flag: '--encoding' }, optional: { default: 'text', means: 'plain text' },
    }),
    wordsInput({ id: 'filename', label: 'Name', help: 'The file name it is kept under', why: 'a file name', typed: { flag: '--name' }, optional: optional('a name made from its kind') }),
    wordsInput({ id: 'mimeType', label: 'File type', help: 'Its type, such as text/markdown or image/png', why: 'a file type', typed: { flag: '--type' }, optional: optional('read from the content') }),
    fixedInput({
      id: 'kind', label: 'Kind', help: 'What kind of artifact it is',
      choices: ['file', 'image', 'audio', 'video', 'document', 'archive', 'data'].map((kind) => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) })),
      typed: { flag: '--kind' }, optional: optional('read from its type'),
    }),
    wordsInput({ id: 'source', label: 'Came from', help: 'Where it came from (a web address or a source name)', why: 'a source', typed: { flag: '--source' }, optional: optional('nowhere named') }),
    wordsInput({ id: 'metadata', label: 'Details', help: 'Its details as JSON (what it was made for, what it belongs to)', why: 'JSON details', typed: { flag: '--details' }, optional: optional('none') }),
    countInput('retention', 'Kept for', 'How long to keep it, in milliseconds', '--keep-ms', '', 'the store\'s usual time'),
  ],
  sentence: 'The content is saved as one of your artifacts, in the daemon\'s store, until it expires or you delete it.', example: { content: '# Report', filename: 'report.md', mimeType: 'text/markdown' },
});

export const ARTIFACTS_CAPABILITIES = [ARTIFACTS_LIST_ALL, ARTIFACTS_SHOW, ARTIFACTS_EXPORT, ARTIFACTS_PACKAGE, ARTIFACTS_SAVE] as const;
