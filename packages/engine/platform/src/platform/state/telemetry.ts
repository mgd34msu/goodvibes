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
import { projectOfDecision } from '../permissions/call-project.js';
import { projectIdentityOf } from '../workspace/project-identity.js';

export interface ToolCallRecord {
  id: number;
  tool: string;
  status: 'ok' | 'error' | 'cancelled';
  duration_ms: number;
  /** Estimated from the result size (about four bytes per token). */
  tokens: number;
  result_bytes: number;
  timestamp: number;
  /** The project the call ran in (the decision's project when the call was made), when one was named. */
  project?: string | undefined;
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

/**
 * Which rows a view of the log shows: every row (the process's own log), or one project's (a tool registry of one
 * project in a host that serves many: a turn reads only its own project's calls). `unattributed`: rows that name no
 * project are shown too (a program's registry: every call of the process is its project's).
 */
interface TelemetryScope {
  readonly log: TelemetryDB;
  readonly project: string;
  readonly unattributed: boolean;
}

export class TelemetryDB {
  private readonly rows: ToolCallRecord[] = [];
  private nextId = 1;
  private dropped = 0;
  /** Rows dropped by the cap, per project they named ('' for none). */
  private readonly droppedOf = new Map<string, number>();

  constructor(private readonly rowCap = TOOL_CALL_TELEMETRY_ROW_CAP, private readonly scope?: TelemetryScope) {}

  /** This log as one project sees it (see {@link TelemetryScope}); recording through it records into this log. */
  forProject(project: string, options: { readonly unattributed?: boolean } = {}): TelemetryDB {
    return new TelemetryDB(this.rowCap, { log: this.scope?.log ?? this, project, unattributed: options.unattributed === true });
  }

  private shows(row: ToolCallRecord): boolean {
    if (!this.scope) return true;
    return row.project === undefined ? this.scope.unattributed : row.project === this.scope.project;
  }

  private visibleRows(): readonly ToolCallRecord[] {
    if (!this.scope) return this.rows;
    return this.scope.log.rows.filter((row) => this.shows(row));
  }

  private droppedCount(): number {
    if (!this.scope) return this.dropped;
    return (this.scope.log.droppedOf.get(this.scope.project) ?? 0) + (this.scope.unattributed ? this.scope.log.droppedOf.get('') ?? 0 : 0);
  }

  /** One row per finished call: name, status, duration and sizes only, and the project it ran in when one was named. */
  recordToolCall(call: { tool: string; status: ToolCallRecord['status']; durationMs: number; resultBytes?: number | undefined; timestamp?: number | undefined; project?: string | undefined }): void {
    if (this.scope) { this.scope.log.recordToolCall(call); return; }
    const resultBytes = Math.max(0, Math.round(call.resultBytes ?? 0));
    this.rows.push({
      id: this.nextId++,
      tool: call.tool,
      status: call.status,
      duration_ms: Math.max(0, Math.round(call.durationMs)),
      tokens: Math.ceil(resultBytes / BYTES_PER_TOKEN),
      result_bytes: resultBytes,
      timestamp: call.timestamp ?? Date.now(),
      ...(call.project !== undefined ? { project: call.project } : {}),
    });
    if (this.rows.length > this.rowCap) {
      const excess = this.rows.length - this.rowCap;
      for (const gone of this.rows.splice(0, excess)) this.droppedOf.set(gone.project ?? '', (this.droppedOf.get(gone.project ?? '') ?? 0) + 1);
      this.dropped += excess;
    }
  }

  /** Newest first. */
  query(filter: TelemetryFilter = {}): ToolCallRecord[] {
    const matched: ToolCallRecord[] = [];
    const limit = filter.limit !== undefined && Number.isFinite(filter.limit) ? Math.max(0, Math.floor(filter.limit)) : Number.POSITIVE_INFINITY;
    const rows = this.visibleRows();
    for (let index = rows.length - 1; index >= 0 && matched.length < limit; index--) {
      const row = rows[index]!;
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
      dropped_calls: this.droppedCount(), by_tool: {},
    };
    const durations: Record<string, number> = {};
    for (const row of this.visibleRows()) {
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
    // The project the call was decided for (permissions/call-project.ts): the bus delivers in the emitting call's
    // context, so a row names the project its call ran in, and a project's view of the log shows only its own.
    const decided = projectOfDecision();
    const project = decided !== undefined ? projectIdentityOf(decided) : undefined;
    if (event.type === 'TOOL_SUCCEEDED' || event.type === 'TOOL_FAILED') {
      log.recordToolCall({
        tool: event.tool,
        status: event.type === 'TOOL_SUCCEEDED' ? 'ok' : 'error',
        durationMs: event.durationMs,
        resultBytes: event.result?.byteSize,
        timestamp: envelope.ts,
        project,
      });
    } else if (event.type === 'TOOL_CANCELLED') {
      log.recordToolCall({ tool: event.tool, status: 'cancelled', durationMs: 0, timestamp: envelope.ts, project });
    }
  });
  return log;
}
