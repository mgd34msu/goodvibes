/**
 * Tool-call analytics for the `state` tool's analytics mode.
 *
 * Each tool call is recorded once, where tools run: the tool runtime emits
 * TOOL_SUCCEEDED, TOOL_FAILED or TOOL_CANCELLED on the runtime event bus, and
 * {@link toolCallTelemetryFor} subscribes one log per bus to those events. A
 * row holds the tool name, status, duration, result size and an estimate of
 * its tokens, never the arguments or the result itself. The log lives in
 * memory for the life of the process and keeps the newest
 * {@link TOOL_CALL_TELEMETRY_ROW_CAP} rows.
 */
import type { RuntimeEventBus } from '../runtime/events/index.js';

export interface ToolCallRecord {
  id: number;
  tool: string;
  status: 'ok' | 'error' | 'cancelled';
  duration_ms: number;
  /** Estimated from the result size (about four bytes per token). */
  tokens: number;
  result_bytes: number;
  timestamp: number;
}

export interface TelemetryFilter {
  tool?: string | undefined;
  status?: ToolCallRecord['status'] | undefined;
  since?: number | undefined;
  until?: number | undefined;
  limit?: number | undefined;
}

export interface TelemetrySummary {
  total_calls: number;
  total_tokens: number;
  total_errors: number;
  total_cancelled: number;
  total_duration_ms: number;
  /** Calls dropped from the start of the log once it held the row cap. */
  dropped_calls: number;
  by_tool: Record<string, { calls: number; tokens: number; errors: number; avg_duration_ms: number }>;
}

/** Rows kept; the oldest leave first. */
export const TOOL_CALL_TELEMETRY_ROW_CAP = 10_000;

const BYTES_PER_TOKEN = 4;

export class TelemetryDB {
  private readonly rows: ToolCallRecord[] = [];
  private nextId = 1;
  private dropped = 0;

  constructor(private readonly rowCap = TOOL_CALL_TELEMETRY_ROW_CAP) {}

  /** One row per finished call: name, status, duration and sizes only. */
  recordToolCall(call: { tool: string; status: ToolCallRecord['status']; durationMs: number; resultBytes?: number | undefined; timestamp?: number | undefined }): void {
    const resultBytes = Math.max(0, Math.round(call.resultBytes ?? 0));
    this.rows.push({
      id: this.nextId++,
      tool: call.tool,
      status: call.status,
      duration_ms: Math.max(0, Math.round(call.durationMs)),
      tokens: Math.ceil(resultBytes / BYTES_PER_TOKEN),
      result_bytes: resultBytes,
      timestamp: call.timestamp ?? Date.now(),
    });
    if (this.rows.length > this.rowCap) {
      const excess = this.rows.length - this.rowCap;
      this.rows.splice(0, excess);
      this.dropped += excess;
    }
  }

  /** Newest first. */
  query(filter: TelemetryFilter = {}): ToolCallRecord[] {
    const matched: ToolCallRecord[] = [];
    const limit = filter.limit !== undefined && Number.isFinite(filter.limit) ? Math.max(0, Math.floor(filter.limit)) : Number.POSITIVE_INFINITY;
    for (let index = this.rows.length - 1; index >= 0 && matched.length < limit; index--) {
      const row = this.rows[index]!;
      if (filter.tool && row.tool !== filter.tool) continue;
      if (filter.status && row.status !== filter.status) continue;
      if (filter.since !== undefined && row.timestamp < filter.since) continue;
      if (filter.until !== undefined && row.timestamp > filter.until) continue;
      matched.push({ ...row });
    }
    return matched;
  }

  getSummary(): TelemetrySummary {
    const summary: TelemetrySummary = {
      total_calls: 0, total_tokens: 0, total_errors: 0, total_cancelled: 0, total_duration_ms: 0,
      dropped_calls: this.dropped, by_tool: {},
    };
    const durations: Record<string, number> = {};
    for (const row of this.rows) {
      summary.total_calls++;
      summary.total_tokens += row.tokens;
      summary.total_duration_ms += row.duration_ms;
      if (row.status === 'error') summary.total_errors++;
      if (row.status === 'cancelled') summary.total_cancelled++;
      const entry = summary.by_tool[row.tool] ??= { calls: 0, tokens: 0, errors: 0, avg_duration_ms: 0 };
      entry.calls++;
      entry.tokens += row.tokens;
      if (row.status === 'error') entry.errors++;
      durations[row.tool] = (durations[row.tool] ?? 0) + row.duration_ms;
    }
    for (const [tool, entry] of Object.entries(summary.by_tool)) {
      entry.avg_duration_ms = Math.round((durations[tool] ?? 0) / entry.calls);
    }
    return summary;
  }

  export(format: 'json' | 'csv' = 'json'): string {
    const records = this.query({});
    if (format === 'csv') {
      const header = 'id,tool,status,duration_ms,tokens,result_bytes,timestamp';
      const rows = records.map((r) =>
        `${r.id},${JSON.stringify(r.tool)},${r.status},${r.duration_ms},${r.tokens},${r.result_bytes},${r.timestamp}`,
      );
      return [header, ...rows].join('\n');
    }
    return JSON.stringify(records, null, 2);
  }
}

const logsByBus = new WeakMap<RuntimeEventBus, TelemetryDB>();

/**
 * The process's tool-call log for this bus, subscribed on first use, so every
 * tool registry built on the same bus shares one log and one subscription.
 * Cost per tool call: one array push.
 */
export function toolCallTelemetryFor(bus: RuntimeEventBus): TelemetryDB {
  const existing = logsByBus.get(bus);
  if (existing) return existing;
  const log = new TelemetryDB();
  logsByBus.set(bus, log);
  bus.onDomain('tools', (envelope) => {
    const event = envelope.payload;
    if (event.type === 'TOOL_SUCCEEDED' || event.type === 'TOOL_FAILED') {
      log.recordToolCall({
        tool: event.tool,
        status: event.type === 'TOOL_SUCCEEDED' ? 'ok' : 'error',
        durationMs: event.durationMs,
        resultBytes: event.result?.byteSize,
        timestamp: envelope.ts,
      });
    } else if (event.type === 'TOOL_CANCELLED') {
      log.recordToolCall({ tool: event.tool, status: 'cancelled', durationMs: 0, timestamp: envelope.ts });
    }
  });
  return log;
}
