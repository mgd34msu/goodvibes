/**
 * method-catalog-memory.ts, the MemoryGovernor observability verb.
 *
 * `ops.memory.get` serves the governor snapshot: current tier, budget, RSS/heap,
 * per-cache footprints, paused jobs, and tripwire state, so operators can see
 * the daemon defending its own footprint.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const CACHE_FOOTPRINT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  entries: NUMBER_SCHEMA,
  estimatedBytes: NUMBER_SCHEMA,
}, ['id', 'name', 'entries']);

const MEMORY_SNAPSHOT_SCHEMA = objectSchema({
  tier: { type: 'string', enum: ['normal', 'elevated', 'high', 'critical'] },
  budgetMb: NUMBER_SCHEMA,
  rssMb: NUMBER_SCHEMA,
  heapUsedMb: NUMBER_SCHEMA,
  heapTotalMb: NUMBER_SCHEMA,
  usedPct: NUMBER_SCHEMA,
  refusingExpensiveWork: BOOLEAN_SCHEMA,
  caches: { type: 'array', items: CACHE_FOOTPRINT_SCHEMA },
  pausedJobs: { type: 'array', items: STRING_SCHEMA },
  tripwire: objectSchema({
    armed: BOOLEAN_SCHEMA,
    sustainedSec: NUMBER_SCHEMA,
    rateMbPerSec: NUMBER_SCHEMA,
    thresholdMbPerSec: NUMBER_SCHEMA,
  }, ['armed', 'sustainedSec', 'rateMbPerSec']),
  thresholds: objectSchema({
    elevatedPct: NUMBER_SCHEMA,
    highPct: NUMBER_SCHEMA,
    criticalPct: NUMBER_SCHEMA,
  }, ['elevatedPct', 'highPct', 'criticalPct']),
  /** The hard limit in force, in MB and as a percent of the memory this machine can use. */
  hardLimit: objectSchema({
    pct: NUMBER_SCHEMA,
    mb: NUMBER_SCHEMA,
    ceilingMb: NUMBER_SCHEMA,
  }, ['pct', 'mb', 'ceilingMb']),
  /** Present when memory settings were refused: which ones and why; the budget, thresholds and hard limit are the values in force until the setting is fixed and the daemon restarts. */
  configFallback: objectSchema({
    settings: arraySchema(STRING_SCHEMA),
    reason: STRING_SCHEMA,
  }, ['settings', 'reason']),
}, [
  'tier', 'budgetMb', 'rssMb', 'heapUsedMb', 'usedPct',
  'refusingExpensiveWork', 'caches', 'pausedJobs', 'tripwire', 'thresholds', 'hardLimit',
]);

export const builtinGatewayMemoryMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'ops.memory.get',
    title: 'Get Memory Governance State',
    description:
      'The MemoryGovernor snapshot: the current memory-pressure tier and budget, resident set size and heap, the tier thresholds and hard limit in force, per-cache footprints the governor can shrink, which deferrable background jobs are paused, and the leak-tripwire state. When memory.budgetMb, memory.tier.* or memory.hardLimitPct were refused, `configFallback` names the settings and why; the shipped values shown are in force until the setting is fixed and the daemon restarts. Read-only observability so operators can see the daemon shedding memory before it approaches OOM.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/ops/memory' },
    inputSchema: objectSchema({}, []),
    outputSchema: MEMORY_SNAPSHOT_SCHEMA,
  }),
  methodDescriptor({
    id: 'memory.consolidation.decide',
    title: 'Decide a Memory Consolidation Proposal',
    description:
      'Answer one pending consolidation proposal (memory.consolidation.receipts lists them with their `id`). The actions each kind accepts, `first`/`second` being the proposal\'s ids in order: contradiction keep-first | keep-second | both-stand; cross-scope-duplicate keep-first | keep-second | keep-both; stale-delete delete | keep. Keeping one record marks the other stale (recoverable); delete removes the record; both-stand and keep-both mark the records reviewed and record the decision, so the proposal is not raised again. Answers decided:true with the records changed and removed, or decided:false with a refusal (code, state, reason, next) and nothing changed. ws-only invoke verb.',
    category: 'memory',
    transport: ['ws'],
    scopes: ['write:memory'],
    access: 'admin',
    inputSchema: objectSchema({
      proposalId: STRING_SCHEMA,
      action: { type: 'string', enum: ['keep-first', 'keep-second', 'both-stand', 'keep-both', 'delete', 'keep'] },
    }, ['proposalId', 'action']),
    outputSchema: objectSchema({
      decided: BOOLEAN_SCHEMA,
      proposalId: STRING_SCHEMA,
      action: STRING_SCHEMA,
      changed: arraySchema(STRING_SCHEMA),
      removed: arraySchema(STRING_SCHEMA),
      refusal: objectSchema({ code: STRING_SCHEMA, state: STRING_SCHEMA, reason: STRING_SCHEMA, next: arraySchema(STRING_SCHEMA) }, ['code', 'state', 'reason', 'next']),
    }, ['decided', 'proposalId']),
  }),
];
