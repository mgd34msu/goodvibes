/**
 * `/artifacts`, described once (command-actions/): the saved uploads,
 * exports, generated media, reports and comparisons in the artifact store,
 * and copying them out to files. Each action is one call of the
 * `agent_artifacts` tool, run as the owner's own act (owner-tool-call.ts).
 */
import { defineCommand, defineList, type ActionDescription, type InputDescription, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, listInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { given, ownerRead, ownerToolCall, positiveNumber, runOwnerToolCall, splitWords } from './owner-tool-call.ts';

const TOOL = 'agent_artifacts';
const LOCAL_ONLY = { terminalOnly: 'Saved artifacts are read and copied on this machine.' } as const;

/** The saved artifacts, newest first: what an artifact blank of any Agent command offers. */
export const ARTIFACTS = defineList<CommandContext>({
  name: 'artifacts',
  async read(ctx) {
    const store = ctx.platform?.artifactStore;
    if (!store?.list) return [];
    return store.list(Number.MAX_SAFE_INTEGER).map((artifact): ListRow => ({
      value: artifact.id, label: artifact.filename ?? artifact.id,
      detail: `${artifact.kind}, ${artifact.mimeType}`, state: new Date(artifact.createdAt).toISOString().slice(0, 10),
    }));
  },
  operator: LOCAL_ONLY,
});

/** One saved artifact, by id. */
export function artifactInput(fields: { readonly id?: string; readonly label?: string; readonly help?: string; readonly typed?: InputDescription['typed']; readonly optional?: { default: string; means: string } } = {}): InputDescription {
  return {
    ...listInput({ id: fields.id ?? 'artifact', label: fields.label ?? 'Artifact', help: fields.help ?? 'Your saved artifacts', list: ARTIFACTS, other: 'an artifact id', ...(fields.optional ? { optional: fields.optional } : {}) }),
    ...(fields.typed ? { typed: fields.typed } : {}),
  };
}

const OVERWRITE: InputDescription = choiceInput({
  id: 'overwrite', label: 'If something is there', help: 'Stop, or put this in its place',
  choices: [{ value: 'no', label: 'Stop and change nothing' }, { value: 'yes', label: 'Put this in its place', help: 'What is there now is lost.', risk: 'cannot-be-undone' }],
  typed: { flag: '--overwrite', switchOn: 'yes' }, optional: { default: 'no', means: 'stop and change nothing' },
});

type ArtifactAction = ActionDescription<CommandContext>;
function copyOut(fields: Pick<ArtifactAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'>): ArtifactAction {
  return { done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ownerOnly: ownerToolCall(TOOL), ...fields };
}

export function registerArtifactsRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'artifacts',
    title: 'Saved artifacts',
    summary: 'The files the Agent has saved (uploads, exports, media, reports, comparisons) and copying them out',
    group: 'Agent',
    report: 'list',
    actions: [
      ownerRead(TOOL, readAction<CommandContext>({
        id: 'list', label: 'See your saved artifacts', word: 'list', operator: LOCAL_ONLY,
        inputs: [
          textInput({ id: 'words', label: 'Words', help: 'What to look for in names, types and where they came from', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'every artifact' } }),
          choiceInput({
            id: 'kind', label: 'Kind', help: 'Only one kind of artifact',
            choices: ['file', 'image', 'audio', 'video', 'document', 'archive', 'data'].map((kind) => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) })),
            typed: { flag: '--kind' }, optional: { default: '', means: 'every kind' },
          }),
          textInput({ id: 'mimeType', label: 'File type', help: 'Part of its type, such as markdown, json or pdf', why: 'a file type', typed: { flag: '--type' }, optional: { default: '', means: 'any type' } }),
          textInput({ id: 'purpose', label: 'Made for', help: 'What it was saved for, such as agent-model-compare', why: 'a purpose word', typed: { flag: '--purpose' }, optional: { default: '', means: 'anything' } }),
          textInput({ id: 'source', label: 'Came from', help: 'Where it came from (a web address or a source name)', why: 'a source', typed: { flag: '--source' }, optional: { default: '', means: 'anywhere' } }),
          { id: 'limit', label: 'At most', help: 'How many to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '25', defaultMeans: '25' }, typed: { flag: '--limit' } },
          { id: 'from', label: 'Starting after', help: 'How many of the newest to skip, to see older ones', kind: 'number', freeTextReason: 'a whole number', required: { default: '0', defaultMeans: 'the newest' }, typed: { flag: '--from' } },
        ],
        sentence: 'Lists your saved artifacts that match {words}, newest first.', example: { words: 'report' },
        async run(values, ctx) {
          const limit = positiveNumber(values.limit);
          const skipped = Number(values.from ?? '0');
          const from = Number.isFinite(skipped) && skipped > 0 ? Math.trunc(skipped) : 0;
          return runOwnerToolCall(ctx, TOOL, { mode: 'list', ...(values.words ? { query: values.words } : {}), ...given(values, 'kind', 'mimeType', 'purpose', 'source'), ...(limit ? { limit } : {}), ...(from ? { offset: from } : {}) }, 'list saved artifacts');
        },
      })),
      ownerRead(TOOL, readAction<CommandContext>({
        id: 'show', label: 'Look at one artifact', word: 'show', operator: LOCAL_ONLY,
        inputs: [
          artifactInput(),
          choiceInput({
            id: 'preview', label: 'Show its text', help: 'A short preview of a text artifact; binary content is never shown',
            choices: [{ value: 'yes', label: 'Show a preview' }, { value: 'no', label: 'Details only' }],
            typed: { flag: '--no-preview', switchOn: 'no' }, optional: { default: 'yes', means: 'show a preview' },
          }),
          { id: 'bytes', label: 'Preview length', help: 'How many bytes of text to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '2048', defaultMeans: '2048 bytes' }, typed: { flag: '--bytes' } },
        ],
        sentence: 'Shows artifact {artifact}: what it is, where it came from, and a short preview of its text.', example: { artifact: 'artifact-123' },
        async run(values, ctx) {
          const previewBytes = positiveNumber(values.bytes);
          return runOwnerToolCall(ctx, TOOL, { mode: 'show', artifactId: values.artifact!, includeContent: values.preview !== 'no', ...(previewBytes ? { previewBytes } : {}) }, `show artifact ${values.artifact}`);
        },
      })),
      copyOut({
        id: 'export', label: 'Copy an artifact to a file', word: 'export',
        inputs: [
          artifactInput(),
          textInput({ id: 'path', label: 'File', help: 'Where in this workspace, such as exports/report.md', why: 'a file path', kind: 'path', typed: { position: 2 } }),
          OVERWRITE,
        ],
        sentence: 'Artifact {artifact} is copied, byte for byte, to {path} in this workspace, until you change it.', example: { artifact: 'artifact-123', path: 'exports/report.md' },
        async run(values, ctx) {
          return runOwnerToolCall(ctx, TOOL, { mode: 'export', artifactId: values.artifact!, destinationPath: values.path!, overwrite: values.overwrite === 'yes', confirm: true, explicitUserRequest: `Copy artifact ${values.artifact} to ${values.path}.` }, `copy artifact ${values.artifact} to ${values.path}`);
        },
      }),
      copyOut({
        id: 'package', label: 'Copy several artifacts into a package', word: 'package',
        inputs: [
          textInput({ id: 'artifacts', label: 'Artifacts', help: 'Their ids, separated by commas', why: 'several artifact ids', typed: { position: 1 } }),
          textInput({ id: 'path', label: 'Folder or ZIP file', help: 'Where in this workspace, such as exports/research-package or exports/research.zip', why: 'a path', kind: 'path', typed: { position: 2 } }),
          choiceInput({
            id: 'format', label: 'As', help: 'A folder you can look through, or one ZIP file',
            choices: [{ value: 'directory', label: 'A folder' }, { value: 'zip', label: 'One ZIP file' }],
            typed: { flag: '--as' }, optional: { default: 'directory', means: 'a folder' },
          }),
          OVERWRITE,
        ],
        sentence: 'Artifacts {artifacts} are copied into {path}, with a list of what is in it, until you change it.', example: { artifacts: 'artifact-1,artifact-2', path: 'exports/package' },
        async run(values, ctx) {
          return runOwnerToolCall(ctx, TOOL, {
            mode: values.format === 'zip' ? 'archive' : 'package', artifactIds: splitWords(values.artifacts), destinationPath: values.path!,
            overwrite: values.overwrite === 'yes', confirm: true, explicitUserRequest: `Copy artifacts ${values.artifacts} into ${values.path}.`,
          }, `copy artifacts into ${values.path}`);
        },
      }),
    ],
  }));
}
