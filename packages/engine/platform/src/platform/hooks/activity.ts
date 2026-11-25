import type { HookEvent, HookResult, HookType } from './types.js';

export interface HookActivityRecord {
  readonly timestamp: number;
  readonly path: string;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly code?: HookResult['code'] | undefined;
  readonly specific: string;
  readonly pattern: string;
  readonly hookName: string;
  readonly hookType: HookType;
  readonly ok: boolean;
  readonly decision?: HookResult['decision'] | undefined;
  /** The hook's own reason for its decision, when it gave one. */
  readonly reason?: string | undefined;
  /** It changed the input of what it ran on (a Pre hook rewriting a tool's arguments). */
  readonly changedInput?: boolean | undefined;
  /** It added context to the conversation. */
  readonly addedContext?: boolean | undefined;
  readonly error?: string | undefined;
  readonly durationMs: number;
  readonly async: boolean;
}

const MAX_ACTIVITY = 100;

export class HookActivityTracker {
  private readonly records: HookActivityRecord[] = [];
  private readonly recordListeners = new Set<(record: HookActivityRecord) => void>();

  /** Told of each hook run as it is recorded (the hook trace posts it to the daemon); returns the stop. */
  public onRecord(listener: (record: HookActivityRecord) => void): () => void {
    this.recordListeners.add(listener);
    return () => { this.recordListeners.delete(listener); };
  }

  public record(
    event: HookEvent,
    params: {
      pattern: string;
      hookName?: string | undefined;
      hookType: HookType;
      result: HookResult;
      durationMs: number;
      async: boolean;
      turnId?: string | undefined;
    },
  ): void {
    const record: HookActivityRecord = {
      timestamp: Date.now(),
      path: event.path,
      sessionId: event.sessionId,
      turnId: params.turnId,
      code: params.result.code,
      specific: event.specific,
      pattern: params.pattern,
      hookName: params.hookName ?? '(unnamed)',
      hookType: params.hookType,
      ok: params.result.ok,
      decision: params.result.decision,
      ...(params.result.reason ? { reason: params.result.reason } : {}),
      ...(params.result.updatedInput ? { changedInput: true } : {}),
      ...(params.result.additionalContext ? { addedContext: true } : {}),
      error: params.result.error,
      durationMs: params.durationMs,
      async: params.async,
    };
    this.records.unshift(record);
    if (this.records.length > MAX_ACTIVITY) {
      this.records.length = MAX_ACTIVITY;
    }
    for (const listener of [...this.recordListeners]) {
      try { listener(record); } catch { /* A listener cannot fail the hook it records. */ }
    }
  }

  public listRecent(limit = 20): readonly HookActivityRecord[] {
    return this.records.slice(0, limit);
  }

  public clear(): void {
    this.records.length = 0;
  }
}
