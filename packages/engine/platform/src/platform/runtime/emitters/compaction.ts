/**
 * emitters/compaction.ts
 *
 * Typed emission wrappers for the CompactionEvent domain.
 *
 * All emitter functions follow the same signature pattern as other domain
 * emitters: (bus, ctx, data) → void.
 */

import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';

/** Emit COMPACTION_CHECK when a threshold check is triggered. */
export function emitCompactionCheck(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; tokenCount: number; threshold: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_CHECK', { type: 'COMPACTION_CHECK', ...data }, ctx),
  );
}

/** Emit COMPACTION_MICROCOMPACT after a micro-compaction run. */
export function emitCompactionMicrocompact(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; turnCount: number; tokensBefore: number; tokensAfter: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_MICROCOMPACT', { type: 'COMPACTION_MICROCOMPACT', ...data }, ctx),
  );
}

/** Emit COMPACTION_COLLAPSE after a collapse compaction run. */
export function emitCompactionCollapse(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; messageCount: number; tokensBefore: number; tokensAfter: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_COLLAPSE', { type: 'COMPACTION_COLLAPSE', ...data }, ctx),
  );
}

/** Emit COMPACTION_AUTOCOMPACT when auto-compaction is triggered. */
export function emitCompactionAutocompact(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; strategy: string; tokensBefore: number; tokensAfter: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_AUTOCOMPACT', { type: 'COMPACTION_AUTOCOMPACT', ...data }, ctx),
  );
}

/** Emit COMPACTION_REACTIVE when reactive compaction is triggered. */
export function emitCompactionReactive(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; tokenCount: number; limit: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_REACTIVE', { type: 'COMPACTION_REACTIVE', ...data }, ctx),
  );
}

/** Emit COMPACTION_BOUNDARY_COMMIT when a boundary commit is persisted. */
export function emitCompactionBoundaryCommit(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; checkpointId: string },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope(
      'COMPACTION_BOUNDARY_COMMIT',
      { type: 'COMPACTION_BOUNDARY_COMMIT', ...data },
      ctx,
    ),
  );
}

/** Emit COMPACTION_DONE when a compaction lifecycle run completes successfully. */
export function emitCompactionDone(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; strategy: string; tokensBefore: number; tokensAfter: number; durationMs: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_DONE', { type: 'COMPACTION_DONE', ...data }, ctx),
  );
}

/** Emit COMPACTION_FAILED when a compaction lifecycle run fails. */
export function emitCompactionFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; strategy: string; error: string },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_FAILED', { type: 'COMPACTION_FAILED', ...data }, ctx),
  );
}

/** Emit the mandatory post-compaction receipt. Every automatic (and the manual)
 * compaction path emits this so a compaction is never silent. */
export function emitCompactionReceipt(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    sessionId: string;
    trigger: 'auto' | 'manual';
    strategy: string;
    tokensBefore: number;
    tokensAfter: number;
    messagesBefore: number;
    messagesAfter: number;
    qualityScore: number;
    qualityGrade: string;
    lowQuality: boolean;
    instructionsReinjected: boolean;
    validationPassed: boolean;
    sectionsIncluded: string[];
    requestedStrategy?: string | undefined;
    strategyFallbackReason?: string | undefined;
    outcome: 'applied' | 'kept-original' | 'failed';
    detail?: string | undefined;
  },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_RECEIPT', { type: 'COMPACTION_RECEIPT', ...data }, ctx),
  );
}
