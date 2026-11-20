import type { JevDecision } from '@goodvibes-jev/judgment/decisions';

/**
 * ToolEvent, discriminated union covering all tool execution lifecycle events.
 *
 * Covers tool execution lifecycle events for the runtime event bus.
 */

/**
 * Structured summary of a tool result, avoids leaking raw `unknown` payloads
 * into the event stream while still providing enough context for observability.
 */
export interface ToolResultSummary {
  /** Discriminant for the result shape (e.g. 'text', 'json', 'error', 'binary'). */
  kind: string;
  /** Approximate byte size of the raw result. */
  byteSize: number;
  /** Optional short preview (first N chars, no credentials). */
  preview?: string | undefined;
}

export type ToolEvent =
  /** A tool call request was received from the LLM. */
  | { type: 'TOOL_RECEIVED'; callId: string; turnId: string; tool: string; args: Record<string, unknown> }
  /** Permission check completed; call may proceed. */
  | { type: 'TOOL_PERMISSIONED'; callId: string; turnId: string; tool: string; approved: boolean; readonly autonomousDecision?: JevDecision | undefined }
  /** Tool is actively executing. */
  | { type: 'TOOL_EXECUTING'; callId: string; turnId: string; tool: string; startedAt: number }
  /** Tool call completed successfully. */
  | { type: 'TOOL_SUCCEEDED'; callId: string; turnId: string; tool: string; durationMs: number; result?: ToolResultSummary }
  /** Tool call failed with an error. */
  | { type: 'TOOL_FAILED'; callId: string; turnId: string; tool: string; error: string; durationMs: number; result?: ToolResultSummary }
  /** Tool results were synthesized to reconcile unresolved calls. */
  | {
      type: 'TOOL_RECONCILED';
      turnId: string;
      count: number;
      callIds: string[];
      toolNames: string[];
      reason: string;
      timestamp: number;
      isMalformed?: boolean | undefined;
    }
  /** Tool call was cancelled before completion. */
  | { type: 'TOOL_CANCELLED'; callId: string; turnId: string; tool: string; reason?: string | undefined }
  /**
   * Every tool the health system tracks is failing, so turns that call them
   * are affected. Published by the tool-failed health rule, with the playbooks
   * that diagnose it; `tool` is the tool whose failure tipped the domain.
   */
  | { type: 'TOOL_DISPATCH_ERROR'; ruleId: string; tool?: string | undefined; reason?: string | undefined; playbooks: readonly string[] }
  /**
   * A tool call went over its `runtime.toolBudget.*` limit (with
   * `runtime.toolBudget.enforced` on). `phase` is `executing` when the time
   * limit stopped the call, `completed` when the call finished over a limit
   * (it still succeeded; the model is told which limit it went over).
   */
  | {
      type: 'BUDGET_EXCEEDED_MS';
      callId: string;
      turnId: string;
      tool: string;
      phase: string;
      limitMs: number;
      elapsedMs: number;
    }
  /** A tool call reported more tokens (`usedTokens`, its result's tokenCount) than `runtime.toolBudget.maxTokens` (`limitTokens`). */
  | {
      type: 'BUDGET_EXCEEDED_TOKENS';
      callId: string;
      turnId: string;
      tool: string;
      phase: string;
      limitTokens: number;
      usedTokens: number;
    }
  /** A tool call reported a cost (`usedCostUsd`, its result's costUsd) over `runtime.toolBudget.maxCostUsd` (`limitCostUsd`). */
  | {
      type: 'BUDGET_EXCEEDED_COST';
      callId: string;
      turnId: string;
      tool: string;
      phase: string;
      limitCostUsd: number;
      usedCostUsd: number;
    };

/** All tool event type literals as a union. */
export type ToolEventType = ToolEvent['type'];
