/**
 * method-catalog-flags.ts
 *
 * The flags.graduation.report descriptor, a read-only view over the internal
 * capability registry that lists every capability with its default-disposition
 * state (dark / soaking / graduate-candidate / graduated / blocked). The daemon
 * holds no validation readings, so evidence is reported as not collected.
 * ws-only invoke verb (no REST binding, so no gateway-rest-routes parity
 * entry). Handlers: routes/flags-graduation.ts.
 */
import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  FLAGS_GRADUATION_REPORT_INPUT_SCHEMA,
  FLAGS_GRADUATION_REPORT_OUTPUT_SCHEMA,
} from './operator-contract-schemas-flags.js';

export const builtinGatewayFlagsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'flags.graduation.report',
    title: 'Feature Defaults Report',
    description:
      'Return the feature defaults report: every platform capability with its current default, default-disposition state (dark = default-off with no evidence, soaking = accumulating evidence, graduate-candidate = judged ready and awaiting a release decision, graduated = default on, blocked = held off with a dated reason), and its validation evidence. The daemon collects no validation readings, so every entry\'s evidence says "no evidence collected"; the only instrumentation, the permissions divergence simulation, runs in the terminal app with /security simulate-policy and reports there. releaseBlockers lists every graduate-candidate entry: capabilities judged ready that are neither on by default nor held with a dated reason.',
    category: 'flags',
    effects: ['config.read'],
    transport: ['ws'],
    inputSchema: FLAGS_GRADUATION_REPORT_INPUT_SCHEMA,
    outputSchema: FLAGS_GRADUATION_REPORT_OUTPUT_SCHEMA,
  }),
];
