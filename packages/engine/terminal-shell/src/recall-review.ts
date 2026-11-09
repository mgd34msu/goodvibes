import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryRecord, MemoryReviewPatch, MemoryScope } from '@goodvibes-jev/engine/platform/platform/state';
import { VALID_REVIEW_STATES, VALID_SCOPES, isValidReviewState, isValidScope, temporalStatusLabel } from './recall-shared.js';
import { afterMemory, mutationArguments, type RecallQueryContext } from './recall-query.js';
export interface RecallReviewPort {
  reviewQueue(limit: number): Promise<readonly MemoryRecord[]>;
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
    readonly validValuesLabel: string;
    readonly validValuesSuffix: string;
    readonly scopedQueue: boolean;
    readonly temporal: boolean;
    readonly staleSeparator: string;
    readonly confirmPromote: boolean;
    readonly reviewState: (state: MemoryRecord['reviewState']) => string;
    readonly queueExtras?: ((context: Context) => readonly string[] | undefined) | undefined;
  },
) {
  function handleRecallReview(args: string[], context: Context): void | Promise<void> {
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const [id, stateRaw, ...rest] = args;
    if (!id || !stateRaw || !isValidReviewState(stateRaw)) {
      context.print(
        `${presentation.tag} Usage: /${presentation.command} review <id> <${VALID_REVIEW_STATES.join('|')}> [--confidence <0-100>] [--by <name>] [--reason <text>]`,
      );
      return;
    }
    const confidenceIdx = rest.indexOf('--confidence');
    const byIdx = rest.indexOf('--by');
    const reasonIdx = rest.indexOf('--reason');
    const confidence = confidenceIdx !== -1 ? parseInt(rest[confidenceIdx + 1] ?? '', 10) : undefined;
    const reviewedBy = byIdx !== -1 ? rest[byIdx + 1] : 'operator';
    const staleReason = reasonIdx !== -1 ? rest.slice(reasonIdx + 1).join(' ') : undefined;
    return afterMemory(
      memory.updateReview(id, {
        state: stateRaw,
        confidence: Number.isFinite(confidence) ? confidence : undefined,
        reviewedBy,
        staleReason,
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
    const scopeIdx = args.indexOf('--scope');
    const scopeValues = scopeIdx !== -1 ? args.slice(scopeIdx + 1).filter((token) => !token.startsWith('--')) : [];
    const taskTokens = args.filter((token, index) => {
      if (token === '--scope') return false;
      if (scopeIdx !== -1 && index > scopeIdx) return false;
      return true;
    });
    const task = taskTokens.join(' ').trim();
    if (!task) {
      context.print(`${presentation.tag} Usage: /${presentation.command} explain <task description...> [--scope <write-scope> ...]`);
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
    let scopeFilter: MemoryScope | undefined;
    let remaining = args;
    if (presentation.scopedQueue) {
      const index = args.indexOf('--scope');
      const scope = args[index + 1];
      if (index !== -1 && scope) {
        if (!isValidScope(scope)) {
          context.print(
            `${presentation.tag} Unknown scope "${scope}". ${presentation.validValuesLabel} ${VALID_SCOPES.join(', ')}${presentation.validValuesSuffix}`,
          );
          return;
        }
        scopeFilter = scope;
        remaining = args.filter((_, i) => i !== index && i !== index + 1);
      }
    }
    const limitRaw = presentation.scopedQueue ? remaining.find((a) => !a.startsWith('--')) : remaining[0];
    const limit = Math.max(1, parseInt(limitRaw ?? '10', 10) || 10);
    const raw = await memory.reviewQueue(scopeFilter ? 1000 : limit);
    const queue = scopeFilter ? raw.filter((r) => r.scope === scopeFilter).slice(0, limit) : raw;
    const extra = presentation.queueExtras?.(context) ?? [];
    if (!queue.length) {
      context.print(`${presentation.tag} Review queue is empty.`);
    } else {
      context.print(`${presentation.tag} Review queue (${queue.length}):`);
      for (const record of queue) {
        const reason = record.staleReason ? presentation.staleSeparator + record.staleReason : '';
        context.print(
          `  ${record.id} [${record.scope}/${record.cls}] ${presentation.reviewState(record.reviewState)} ${record.confidence}%  ${record.summary}${reason}${presentation.temporal ? temporalStatusLabel(record) : ''}`,
        );
      }
    }
    for (const line of extra) context.print(line);
  }
  function handleRecallPromote(args: string[], context: Context): void | Promise<void> {
    const memory = getMemory(context);
    if (!memory) return;
    const parsed = mutationArguments(args, presentation.confirmPromote);
    const [id, scope] = parsed.rest;
    if (!id || !scope || !isValidScope(scope)) {
      context.print(
        `${presentation.tag} Usage: /${presentation.command} promote <id> <${VALID_SCOPES.join('|')}>${presentation.confirmPromote ? ' --yes' : ''}`,
      );
      return;
    }
    if (!parsed.yes) {
      context.print(
        `Refusing to promote durable memory record ${id} to ${scope} scope without --yes.\nUsage: /${presentation.command} promote <id> <scope> --yes`,
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
