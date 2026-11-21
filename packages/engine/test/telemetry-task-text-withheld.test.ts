// Proves: The text of a task the owner gave reaches an OTLP collector, and read:telemetry clients in the safe view, through its lifecycle span.
// Red when: The safe span view stops withholding the task span's `task.description` attribute, so the exported OTLP document carries the task's words.
/**
 * A collector is a remote reader and gets the telemetry API's safe view: ids,
 * kinds, statuses and timings, never the content of what was asked. The real
 * tracer, task span and OTLP exporter; the collector is a stand-in at the HTTP
 * wire that keeps every body posted to it.
 */
import { afterEach, expect, test } from 'bun:test';
import { RuntimeTracer } from '../platform/src/platform/runtime/telemetry/tracer.ts';
import { OtlpExporter } from '../platform/src/platform/runtime/telemetry/exporters/otlp.ts';
import { startTaskSpan } from '../platform/src/platform/runtime/telemetry/spans/task.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('a task span exported to a collector carries the task id but not the task text', async () => {
  const posted: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    posted.push(String(init?.body ?? ''));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const exporter = new OtlpExporter({ endpoint: 'https://collector.example/v1/traces', batchSize: 512, timeoutMs: 10_000 });
  const tracer = new RuntimeTracer({ scope: 'goodvibes-platform', exporters: [exporter], enabled: true });

  startTaskSpan(tracer, { taskId: 'task-fixture-1', description: 'Write to Dr. Ames about the biopsy results', priority: 1, traceId: 'trace-fixture-1' }).end();
  await exporter.flush();

  const body = posted.join('\n');
  expect({ exported: body.includes('task-fixture-1'), taskText: body.includes('biopsy') }).toEqual({ exported: true, taskText: false });
});
