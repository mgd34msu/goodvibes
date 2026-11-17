/**
 * Playbook: Export Recovery
 *
 * Telemetry (OTLP) export that is off or not delivering.
 */
import type { Playbook } from '../types.js';
import { safeCheck } from '../safe-check.js';

/** Telemetry export recovery playbook. */
export const exportRecoveryPlaybook: Playbook = {
  id: 'export-recovery',
  name: 'Export Recovery',
  description: 'Diagnoses telemetry (OTLP) export that is off or not delivering. Agent work is not affected by an export failure.',
  symptoms: [
    'Traces or spans do not reach the collector',
    'OTLP export failed',
    'Telemetry export queue overflow',
  ],
  checks: [
    {
      id: 'export.otlp-endpoint-reachable',
      label: 'Trace export',
      description: 'Whether trace export is on in this app, and where it sends.',
      run: (ctx) => safeCheck(() => {
        const trace = ctx.store.getState().telemetry.traceContext;
        const active = trace?.exportActive === true;
        return {
          passed: active,
          summary: active ? `Trace export is on${trace?.endpoint ? `, sending to ${trace.endpoint}` : ''}.` : 'Trace export is off in this app.',
          severity: active ? 'info' : 'warning',
        };
      }),
    },
  ],
  steps: [
    { step: 1, title: 'Check the export settings', action: 'Open /settings and search for telemetry to see whether export is on and which endpoint it uses.', kind: 'command', command: '/settings', expectedOutcome: 'Export is on and points at the collector.', automatable: false },
    { step: 2, title: 'Check the collector', action: 'Confirm the collector at that endpoint is running and reachable from this machine.', kind: 'observe', expectedOutcome: 'The collector receives spans.', automatable: false },
  ],
  escalationCriteria: ['Spans stay missing with export on and the collector reachable'],
  tags: ['telemetry', 'export', 'otlp', 'tracing'],
};
