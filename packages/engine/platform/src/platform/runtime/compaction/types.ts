/**
 * types.ts
 *
 * Core types for the session compaction lifecycle engine.
 *
 * These are distinct from `src/core/compaction-types.ts` (the prompt compaction
 * section types). This module defines the *lifecycle* layer: state machine
 * states, strategies, boundary commits, and repair records.
 */

import type { ProviderMessage } from '../../providers/interface.js';
import type { CompactionQualityScore } from './quality-score.js';

export type { CompactionQualityScore };

// ---------------------------------------------------------------------------
// Compaction lifecycle states
// ---------------------------------------------------------------------------

/**
 * All states of the compaction lifecycle state machine.
 *
 * Transition map:
 *   idle → checking_threshold
 *   checking_threshold → microcompact | collapse | autocompact | reactive_compact | done | failed
 *   each strategy state → boundary_commit | failed, or another strategy state
 *   boundary_commit → done | failed
 *   done → idle
 *   failed → idle
 *
 * `compactionLifecycle` in lifecycle.ts is the authoritative table.
 */
export type CompactionLifecycleState =
  | 'idle'
  | 'checking_threshold'
  | 'microcompact'
  | 'collapse'
  | 'autocompact'
  | 'reactive_compact'
  | 'boundary_commit'
  | 'done'
  | 'failed';

// ---------------------------------------------------------------------------
// Strategy types
// ---------------------------------------------------------------------------

/**
 * Discriminated union identifying which compaction strategy to apply.
 *
 * - `microcompact` , lightweight summary of recent turns; lowest latency
 * - `collapse`     , full context collapse into a single summary message
 * - `autocompact`  , threshold-based automatic compaction
 * - `reactive`     , emergency compaction triggered by prompt-too-long errors
 */
export type CompactionStrategy =
  | 'microcompact'
  | 'collapse'
  | 'autocompact'
  | 'reactive';

// ---------------------------------------------------------------------------
// Strategy input/output
// ---------------------------------------------------------------------------

/** Input passed to every compaction strategy. */
export interface StrategyInput {
  /** Session ID for event correlation. */
  sessionId: string;
  /** Messages at the time compaction is triggered. */
  messages: readonly ProviderMessage[];
  /** Estimated token count before compaction. */
  tokensBefore: number;
  /** Context window size for the current model. */
  contextWindow: number;
  /** Which strategy is being applied (for self-identification in results). */
  strategy: CompactionStrategy;
  /** Optional additional metadata from the trigger. */
  meta?: Record<string, unknown> | undefined;
}

/** Output produced by every compaction strategy. */
export interface StrategyOutput {
  /** Compacted message list to replace the current conversation. */
  messages: ProviderMessage[];
  /** Estimated token count after compaction. */
  tokensAfter: number;
  /** Human-readable summary of what was compacted. */
  summary: string;
  /** Strategy that produced this output. */
  strategy: CompactionStrategy;
  /** Wall-clock duration for this strategy's execution. */
  durationMs: number;
  /** Any warnings encountered while compacting. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Boundary commit
// ---------------------------------------------------------------------------

/**
 * A boundary commit persists a compacted snapshot for replay-safe resumption.
 *
 * Each boundary commit stores:
 * - A unique checkpoint ID
 * - The compacted message slice (replay-safe: can be sliced from any prior state)
 * - A lineage reference to its parent (or null for the root commit)
 * - The strategy that produced this checkpoint
 */
export interface BoundaryCommit {
  /** Unique monotonic checkpoint identifier (e.g. `cpt_<ulid>`). */
  checkpointId: string;
  /** Session ID this commit belongs to. */
  sessionId: string;
  /** Unix timestamp (ms) when this commit was created. */
  createdAt: number;
  /** Strategy that produced the compacted snapshot. */
  strategy: CompactionStrategy;
  /**
   * Parent checkpoint ID in the lineage chain.
   * `null` for the root commit (no prior compaction).
   */
  parentCheckpointId: string | null;
  /**
   * Ordered lineage of all prior checkpoint IDs from root to this commit.
   * Used for replay-safe slicing, always append-only.
   */
  lineage: readonly string[];
  /** The compacted messages at this boundary. */
  messages: readonly ProviderMessage[];
  /** Token count of the compacted messages. */
  tokenCount: number;
  /** Estimated token count before compaction (for audit). */
  tokensBefore: number;
  /** Human-readable summary stored with this checkpoint. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/**
 * What initiated the compaction lifecycle run.
 *
 * - `auto`       , threshold check determined compaction is needed
 * - `manual`     , user or orchestrator explicitly requested compaction
 * - `prompt_too_long`, reactive trigger from a provider prompt-too-long error
 */
export type CompactionTrigger = 'auto' | 'manual' | 'prompt_too_long';
