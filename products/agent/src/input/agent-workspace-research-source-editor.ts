import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export interface AgentResearchSourceWorkspaceToolArgs {
  readonly mode: 'add';
  readonly question: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly publishedAt?: string;
  readonly accessedAt?: string;
  readonly summary: string;
  readonly evidence?: string;
  readonly credibility?: string;
  readonly score?: number;
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly confirm: true;
  readonly explicitUserRequest: string;
}

function splitTags(value: string): readonly string[] {
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function readOptionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : undefined;
}

export function createAgentResearchSourceEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'research-source',
    mode: 'create',
    title: 'Add Research Source',
    selectedFieldIndex: 0,
    message: 'Capture one source in the project-local research queue. This does not save a report or ingest Agent Knowledge.',
    fields: [
      { id: 'question', label: 'Question', value: '', required: true, multiline: true, hint: 'Research question or topic this source supports.' },
      { id: 'title', label: 'Source title', value: '', required: true, multiline: false, hint: 'Readable source title.' },
      { id: 'url', label: 'URL', value: '', required: false, multiline: false, hint: 'Optional HTTP or HTTPS URL. A URL with a login or a secret-like query value is refused.' },
      { id: 'publisher', label: 'Publisher', value: '', required: false, multiline: false, hint: 'Optional source owner, publication, repo, or docs site.' },
      { id: 'publishedAt', label: 'Published', value: '', required: false, multiline: false, hint: 'Optional source date if known.' },
      { id: 'summary', label: 'Summary', value: '', required: true, multiline: true, hint: 'Short source summary. Ctrl-J inserts a new line.' },
      { id: 'evidence', label: 'Evidence notes', value: '', required: false, multiline: true, hint: 'Useful quoted-or-paraphrased evidence notes within copyright limits.' },
      { id: 'credibility', label: 'Credibility', value: 'unreviewed', required: false, multiline: false, hint: 'unreviewed, low, medium, high, or mixed.' },
      { id: 'score', label: 'Score', value: '', required: false, multiline: false, hint: 'Optional 0-100 usefulness/credibility score.' },
      { id: 'tags', label: 'Tags', value: 'research', required: false, multiline: false, hint: 'Comma-separated source tags.' },
      { id: 'note', label: 'Review note', value: '', required: false, multiline: true, hint: 'Why this source is useful, risky, primary, outdated, or disputed.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to add this source to the local queue.' },
    ],
  };
}

export function buildAgentResearchSourceToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentResearchSourceWorkspaceToolArgs {
  const url = readField('url').trim();
  const publisher = readField('publisher').trim();
  const publishedAt = readField('publishedAt').trim();
  const evidence = readField('evidence').trim();
  const credibility = readField('credibility').trim();
  const score = readOptionalNumber(readField('score'));
  const tags = splitTags(readField('tags'));
  const note = readField('note').trim();
  return {
    mode: 'add',
    question: readField('question').trim(),
    title: readField('title').trim(),
    ...(url ? { url } : {}),
    ...(publisher ? { publisher } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    summary: readField('summary').trim(),
    ...(evidence ? { evidence } : {}),
    ...(credibility ? { credibility } : {}),
    ...(score === undefined ? {} : { score }),
    ...(tags.length > 0 ? { tags } : {}),
    ...(note ? { note } : {}),
    confirm: true,
    explicitUserRequest,
  };
}
