import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryRecord, MemoryReviewPatch, MemoryScope } from '@goodvibes-jev/engine/platform/platform/state';
import {
  VALID_REVIEW_STATES,
  VALID_SCOPES,
  isValidReviewState,
  isValidScope,
  readRecallFlags,
  temporalStatusLabel,
  type RecallFlagKind,
} from './recall-shared.js';
import { afterMemory, mutationArguments, type RecallQueryContext } from './recall-query.js';
import { commandRefusal } from './command-confirmation.js';
const REVIEW_FLAGS: Readonly<Record<string, RecallFlagKind>> = { '--confidence': 'word', '--by': 'text', '--reason': 'text' };
const EXPLAIN_FLAGS: Readonly<Record<string, RecallFlagKind>> = { '--scope': 'words' };
const QUEUE_FLAGS: Readonly<Record<string, RecallFlagKind>> = { '--scope': 'word' };
export interface RecallReviewPort {
  reviewQueue(limit: number, scope?: MemoryScope): Promise<readonly MemoryRecord[]>;
  updateReview(id: string, patch: MemoryReviewPatch): MemoryRecord | null | Promise<MemoryRecord | null>;
  update(
    id: string,
    patch: {
      scope: MemoryScope;
    },
  ): MemoryRecord | null | Promise<MemoryRecord | null>;
}
export function createRecallReviewCommands<Context extends RecallQueryContext>(
  getMemory: (context: Context) => RecallReviewPort | null,
  getLocalMemory: (context: Context) => MemoryApi | null,
  presentation: {
    readonly tag: string;
    readonly command: string;
    readonly scopedQueue: boolean;
    readonly temporal: boolean;
    readonly queueExtras?: ((context: Context) => readonly string[] | undefined) | undefined;
  },
) {
  function handleRecallReview(args: string[], context: Context): void | Promise<void> {
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const usage = `${presentation.tag} Usage: /${presentation.command} review <id> <${VALID_REVIEW_STATES.join('|')}> [--confidence <0-100>] [--by <name>] [--reason <text>]`;
    const flags = readRecallFlags(args, REVIEW_FLAGS);
    if ('refusal' in flags) {
      context.print(`${presentation.tag} ${flags.refusal}\n${usage}`);
      return;
    }
    const [id, stateRaw, ...extra] = flags.positional;
    if (!id || !stateRaw || !isValidReviewState(stateRaw)) {
      context.print(usage);
      return;
    }
    if (extra.length > 0) {
      context.print(`${presentation.tag} "${extra.join(' ')}" is not part of a review; a reason goes after --reason. Nothing was changed.\n${usage}`);
      return;
    }
    const confidenceRaw = flags.values.get('--confidence');
    if (confidenceRaw !== undefined && !/^(100|[1-9]?\d)$/.test(confidenceRaw)) {
      context.print(`${presentation.tag} --confidence takes a whole number from 0 to 100, not "${confidenceRaw}". Nothing was changed.`);
      return;
    }
    const reason = flags.values.get('--reason');
    return afterMemory(
      memory.updateReview(id, {
        state: stateRaw,
        confidence: confidenceRaw === undefined ? undefined : Number(confidenceRaw),
        reviewedBy: flags.values.get('--by') ?? 'operator',
        staleReason: reason,
      }),
      (record) => {
        if (!record) {
          context.print(`${presentation.tag} Record not found: ${id}`);
          return;
        }
        context.print(`${presentation.tag} Reviewed ${record.id}: ${record.reviewState} ${record.confidence}%`);
      },
    );
  }
  async function handleRecallExplain(args: string[], context: Context): Promise<void> {
    const memory = getLocalMemory(context);
    if (!memory) {
      return;
    }
    const usage = `${presentation.tag} Usage: /${presentation.command} explain <task description...> [--scope <write-scope> ...]`;
    const flags = readRecallFlags(args, EXPLAIN_FLAGS);
    if ('refusal' in flags) {
      context.print(`${presentation.tag} ${flags.refusal}\n${usage}`);
      return;
    }
    const scopeValues = [...(flags.lists.get('--scope') ?? [])];
    const task = flags.positional.join(' ').trim();
    if (!task) {
      context.print(usage);
      return;
    }
    const explanation = await memory.explain(task, scopeValues);
    if (explanation.injections.length === 0) {
      context.print(`${presentation.tag} No reviewed project knowledge was selected for that task.`);
      return;
    }
    context.print(explanation.prompt ?? `${presentation.tag} No explainable project knowledge was selected.`);
  }
  async function handleRecallQueue(args: string[], context: Context): Promise<void> {
    const memory = getMemory(context);
    if (!memory) return;
    const usage = `${presentation.tag} Usage: /${presentation.command} queue [limit]${presentation.scopedQueue ? ' [--scope <scope>]' : ''}`;
    const flags = readRecallFlags(args, presentation.scopedQueue ? QUEUE_FLAGS : {});
    if ('refusal' in flags) {
      context.print(`${presentation.tag} ${flags.refusal}\n${usage}`);
      return;
    }
    let scopeFilter: MemoryScope | undefined;
    const scope = flags.values.get('--scope');
    if (scope !== undefined) {
      if (!isValidScope(scope)) {
        context.print(
          `${presentation.tag} Unknown scope "${scope}". Valid: ${VALID_SCOPES.join(', ')}.`,
        );
        return;
      }
      scopeFilter = scope;
    }
    const [limitRaw, ...unexpected] = flags.positional;
    if (unexpected.length > 0 ||(limitRaw !== undefined && !/^[1-9]\d*$/.test(limitRaw))) {
      context.print(`${presentation.tag} The queue takes one limit, a positive whole number. Nothing was listed.\n${usage}`);
      return;
    }
    const limit = limitRaw === undefined ? 10 : Number(limitRaw);
    // The store filters by scope, so a scoped queue is one page of that scope.
    const queue = await memory.reviewQueue(limit, scopeFilter);
    const extra = presentation.queueExtras?.(context) ?? [];
    if (!queue.length) {
      context.print(`${presentation.tag} Review queue is empty.`);
    } else {
      context.print(`${presentation.tag} Review queue (${queue.length}):`);
      for (const record of queue) {
        const reason = record.staleReason ? ': ' + record.staleReason : '';
        context.print(
          `  ${record.id} [${record.scope}/${record.cls}] ${record.reviewState} ${record.confidence}%  ${record.summary}${reason}${presentation.temporal ? temporalStatusLabel(record) : ''}`,
        );
      }
    }
    for (const line of extra) context.print(line);
  }
  function handleRecallPromote(args: string[], context: Context): void | Promise<void> {
    const memory = getMemory(context);
    if (!memory) return;
    const parsed = mutationArguments(args);
    const [id, scope] = parsed.rest;
    if (!id || !scope || !isValidScope(scope)) {
      context.print(
        `${presentation.tag} Usage: /${presentation.command} promote <id> <${VALID_SCOPES.join('|')}>`,
      );
      return;
    }
    return afterMemory(memory.update(id, { scope }), (record) => {
      if (!record) {
        context.print(`${presentation.tag} Record not found: ${id}`);
        return;
      }
      context.print(`${presentation.tag} Promoted ${record.id} to ${record.scope} scope.`);
    });
  }
  return { handleRecallQueue, handleRecallReview, handleRecallExplain, handleRecallPromote };
}
