/**
 * model-compare-person.ts, what a person reads after a model comparison act
 * (model-compare-runner.ts): the answers, a judgment, a switch of model or a
 * saved report, in a person's words, read from the saved artifacts themselves.
 * The `agent_model_compare` tool's own text is written for a model (tool calls
 * to make next, ids to pass); a model that runs a comparison capability still
 * gets that text, and every caller gets the facts as data.
 */
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import type { AgentModelCompareArtifactStore, CompareCandidateResult, LoadedComparisonJudgment, StoredComparison } from './model-compare-types.js';
import { loadComparisonFromArtifact } from './model-compare-run.js';
import { loadJudgmentFromArtifact, loadSavedJudgments } from './model-compare-judgment.js';
import { listAllArtifacts } from './model-compare-utils.js';

/** What each saved comparison artifact is, by its purpose. */
export type SavedComparisonKind = 'comparison' | 'judgment' | 'decision' | 'report' | 'handoff' | 'archive';

const KINDS: Readonly<Record<string, SavedComparisonKind>> = {
  'agent-model-compare': 'comparison',
  'agent-model-compare-judgment': 'judgment',
  'agent-model-compare-route-decision': 'decision',
  'agent-model-compare-export': 'report',
  'agent-model-compare-handoff': 'handoff',
  'agent-model-compare-handoff-archive': 'archive',
};

/** One saved comparison artifact, in facts a list or a person reads. */
export interface SavedComparisonEntry {
  readonly id: string;
  readonly kind: SavedComparisonKind;
  /** The prompt the comparison it belongs to was asked, shortened. */
  readonly prompt: string;
  readonly createdAt: string;
  readonly comparisonId: string;
  /** A judgment's or decision's winning answer letter. */
  readonly winner?: string | undefined;
  /** The winning model, when the judgment named it. */
  readonly winnerModel?: string | undefined;
  /** A decision: whether the default model was switched to the winner or kept. */
  readonly decision?: 'switched' | 'kept' | undefined;
  /** A decision: the default model it left in use. */
  readonly model?: string | undefined;
}

const str = (value: unknown): string => typeof value === 'string' ? value : '';
/** Text a model or a file wrote, without terminal control sequences. */
const plain = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
const date = (iso: string): string => iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : 'an unknown time';
const kindOf = (artifact: ArtifactDescriptor): SavedComparisonKind | undefined => KINDS[str(artifact.metadata?.['purpose'])];

/** Every saved comparison artifact, newest first, each with the prompt of the comparison it belongs to. */
export function savedComparisons(store: AgentModelCompareArtifactStore | undefined): readonly SavedComparisonEntry[] {
  const artifacts = listAllArtifacts(store).filter((artifact) => kindOf(artifact) !== undefined);
  const prompts = new Map<string, string>();
  for (const artifact of artifacts) {
    const comparisonId = str(artifact.metadata['comparisonId']);
    const prompt = str(artifact.metadata['promptPreview']);
    if (comparisonId && prompt && !prompts.has(comparisonId)) prompts.set(comparisonId, prompt);
  }
  return artifacts.map((artifact): SavedComparisonEntry => {
    const metadata = artifact.metadata;
    const kind = kindOf(artifact)!;
    const comparisonId = str(metadata['comparisonId']);
    const decision = str(metadata['decision']);
    const winnerModel = str(metadata['winnerModel']);
    const model = str(metadata['selectedModel']) || str(metadata['currentModel']);
    return {
      id: artifact.id, kind, comparisonId,
      prompt: plain(str(metadata['promptPreview']) || prompts.get(comparisonId) || ''),
      createdAt: new Date(artifact.createdAt).toISOString(),
      ...(str(metadata['winnerBlindId']) ? { winner: str(metadata['winnerBlindId']) } : {}),
      ...(winnerModel ? { winnerModel } : {}),
      ...(kind === 'decision' ? { decision: decision === 'applied-winner' ? 'switched' as const : 'kept' as const } : {}),
      ...(model ? { model } : {}),
    };
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

const KIND_WORDS: Readonly<Record<SavedComparisonKind, string>> = {
  comparison: 'answers to judge', judgment: 'your judgment', decision: 'a model decision', report: 'a report', handoff: 'a reviewer handoff', archive: 'a ZIP of a reviewer handoff',
};

/** The saved comparisons, said to a person; `withIds` adds each one's id, which a model passes to act on it. */
export function savedComparisonsWords(entries: readonly SavedComparisonEntry[], withIds = false): string {
  if (entries.length === 0) return 'No model comparisons yet. Compare models on a prompt: the answers are kept here to judge, with the models\' names hidden.';
  const waiting = entries.filter((entry) => entry.kind === 'comparison').length;
  return [
    `${entries.length} saved, newest first${waiting > 0 ? `; ${waiting} comparison${waiting === 1 ? '' : 's'} with answers to judge` : ''}:`,
    ...entries.slice(0, 20).map((entry) => `  ${date(entry.createdAt)}  ${KIND_WORDS[entry.kind]}${entry.prompt ? ` for "${entry.prompt}"` : ''}${withIds ? `  (${entry.id})` : ''}`),
    ...(entries.length > 20 ? [`  and ${entries.length - 20} older.`] : []),
  ].join('\n');
}

function answerWords(candidate: CompareCandidateResult, reveal: boolean): string {
  const who = reveal ? ` (${candidate.model.displayName || candidate.model.registryKey})` : '';
  if (candidate.status !== 'completed') return `Answer ${candidate.blindId}${who}: no answer. ${plain(candidate.error ?? 'The model did not answer.')}`;
  return `Answer ${candidate.blindId}${who}:\n${plain(candidate.content).trim() || '(empty)'}`;
}

/** One comparison's answers, said to a person. */
export function comparisonWords(comparison: StoredComparison, reveal: boolean, lead: string): string {
  const answered = comparison.candidates.filter((candidate) => candidate.status === 'completed').length;
  return [
    `${lead} "${plain(comparison.promptPreview)}"`,
    ...(comparison.rubric ? [`How to judge: ${plain(comparison.rubric)}`] : []),
    '',
    ...comparison.candidates.flatMap((candidate) => [answerWords(candidate, reveal), '']),
    answered === 0 ? 'No model answered, so there is nothing to judge. Compare again.'
      : reveal ? 'Judge which answer won.' : 'Judge which answer won. Which model wrote which answer stays hidden until you judge.',
  ].join('\n');
}

function judgmentWords(judgment: LoadedComparisonJudgment, lead: string): string {
  return [
    `${lead}: answer ${judgment.winnerBlindId} won${judgment.winnerModel ? `, written by ${judgment.winnerModel.displayName || judgment.winnerModel.registryKey}` : ''}.`,
    ...(judgment.reasons ? [`Why: ${plain(judgment.reasons)}`] : []),
    ...(judgment.notes ? [`Notes: ${plain(judgment.notes)}`] : []),
    '',
    'The default model is unchanged: switch to the winner, or keep the default model and record why.',
  ].join('\n');
}

/** Reviewer text saved as a file, without the lines written to tell a model which tool to call. */
function savedText(text: string): string {
  return plain(text).split('\n').filter((line) => !/agent_[a-z_]+|\bmode:\s*"|artifactId:/.test(line)).join('\n').trim();
}

/** A saved comparison artifact read for a person: the answers, a judgment, a decision, a report or a handoff. */
export async function savedComparisonWords(store: AgentModelCompareArtifactStore | undefined, id: string, reveal: boolean): Promise<string> {
  const entry = savedComparisons(store).find((saved) => saved.id === id);
  if (!entry) return `No saved model comparison has that id (${id}).`;
  const about = entry.prompt ? ` for "${entry.prompt}"` : '';
  switch (entry.kind) {
    case 'comparison': {
      const comparison = await loadComparisonFromArtifact(store, id);
      return comparison ? comparisonWords(comparison, reveal, `Saved ${date(entry.createdAt)}: the same prompt sent to ${comparison.candidates.length} models,`) : `The comparison saved ${date(entry.createdAt)} could not be read.`;
    }
    case 'judgment': {
      const judgment = await loadJudgmentFromArtifact(store, id);
      return judgment ? judgmentWords(judgment, `Your judgment${about}, saved ${date(entry.createdAt)}`) : `The judgment saved ${date(entry.createdAt)} could not be read.`;
    }
    case 'decision':
      return entry.decision === 'switched'
        ? `On ${date(entry.createdAt)} the default model was switched to ${entry.model ?? 'the winner'}, the winner of the comparison${about}.`
        : `On ${date(entry.createdAt)} you kept ${entry.model ?? 'the default model'} as the default model after the comparison${about}${entry.winner ? `, which answer ${entry.winner} won` : ''}.`;
    case 'archive':
      return `A ZIP of a reviewer handoff${about}, saved ${date(entry.createdAt)}. Copy it out of your saved artifacts (Memory and knowledge) to open it.`;
    default: {
      if (!store?.readContent) return `${KIND_WORDS[entry.kind]}${about}, saved ${date(entry.createdAt)}.`;
      const { buffer } = await store.readContent(id);
      return [`${KIND_WORDS[entry.kind][0]!.toUpperCase()}${KIND_WORDS[entry.kind].slice(1)}${about}, saved ${date(entry.createdAt)}:`, '', savedText(buffer.toString('utf-8'))].join('\n');
    }
  }
}

/** The judgments counted by winner, said to a person. */
export async function winnersWords(store: AgentModelCompareArtifactStore | undefined, limit: number): Promise<string> {
  const { judgments, unreadable } = await loadSavedJudgments(store, limit, {});
  if (judgments.length === 0) return 'No judgments yet. Judge a comparison and the winners are counted here.';
  const wins = new Map<string, number>();
  let hidden = 0;
  for (const judgment of judgments) {
    const model = judgment.winnerModel?.displayName || judgment.winnerModel?.registryKey;
    if (!model) { hidden += 1; continue; }
    wins.set(model, (wins.get(model) ?? 0) + 1);
  }
  return [
    `${judgments.length} judgment${judgments.length === 1 ? '' : 's'}, newest first.`,
    ...[...wins.entries()].sort((left, right) => right[1] - left[1]).map(([model, count]) => `  ${model} won ${count} time${count === 1 ? '' : 's'}`),
    ...(hidden > 0 ? [`  ${hidden} judgment${hidden === 1 ? '' : 's'} kept the winning model's name hidden.`] : []),
    ...(unreadable > 0 ? [`${unreadable} saved judgment${unreadable === 1 ? '' : 's'} could not be read and ${unreadable === 1 ? 'is' : 'are'} not counted.`] : []),
  ].join('\n');
}

/** A report, handoff or ZIP just saved, said to a person. */
export function savedNowWords(entry: SavedComparisonEntry | undefined): string {
  if (!entry) return 'Saved.';
  const about = entry.prompt ? ` for "${entry.prompt}"` : '';
  return `Saved ${KIND_WORDS[entry.kind]}${about}. It is listed with your comparisons, and in your saved artifacts (Memory and knowledge).`;
}

/** Text written for a model, with the lines that name tools and their arguments taken out. */
export function withoutToolLines(text: string): string {
  return savedText(text);
}
