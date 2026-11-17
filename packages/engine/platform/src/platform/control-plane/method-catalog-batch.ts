/**
 * method-catalog-batch.ts, the daemon's batch job queue.
 *
 * The routes in platform/daemon/http/batch-routes.ts have been served for a
 * long time; the Cloudflare worker and the clients call them by path. They are
 * described here so a generated client and the route reconcile can see them
 * like any other family. Listing and reading are open to every authenticated
 * caller; creating, cancelling and running a pass spend provider budget and
 * need an admin, the same rule the router enforces.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  bodyEnvelopeSchema,
  methodDescriptor,
  objectSchema,
  stringEnumSchema,
} from './method-catalog-shared.js';

const OPEN_OBJECT_SCHEMA = objectSchema({}, [], { additionalProperties: true });
const JOB_STATUS_SCHEMA = stringEnumSchema(['queued', 'submitted', 'running', 'completed', 'failed', 'cancelled', 'expired', 'dead_lettered']);
const BATCH_MODE_SCHEMA = stringEnumSchema(['off', 'explicit', 'eligible-by-default']);

/** One job as the daemon stores it. `request`, `result` and any `error.raw` carry provider-shaped data, so they stay open. */
export const BATCH_JOB_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  model: STRING_SCHEMA,
  status: JOB_STATUS_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  request: OPEN_OBJECT_SCHEMA,
  source: objectSchema({ kind: STRING_SCHEMA, id: STRING_SCHEMA }, ['kind']),
  metadata: objectSchema({}, [], { additionalProperties: true }),
  attempts: NUMBER_SCHEMA,
  providerBatchId: STRING_SCHEMA,
  providerBatchStatus: STRING_SCHEMA,
  submittedAt: NUMBER_SCHEMA,
  completedAt: NUMBER_SCHEMA,
  result: OPEN_OBJECT_SCHEMA,
  error: objectSchema({ message: STRING_SCHEMA, code: STRING_SCHEMA }, ['message'], { additionalProperties: true }),
}, ['id', 'provider', 'model', 'status', 'createdAt', 'updatedAt', 'request', 'attempts']);

const BATCH_JOB_ENVELOPE_SCHEMA = objectSchema({ job: BATCH_JOB_SCHEMA }, ['job']);

const BATCH_RUNTIME_SCHEMA = objectSchema({
  mode: BATCH_MODE_SCHEMA,
  fallback: stringEnumSchema(['live', 'fail']),
  queueBackend: stringEnumSchema(['local', 'cloudflare']),
  cloudflare: objectSchema({
    enabled: BOOLEAN_SCHEMA,
    freeTierMode: BOOLEAN_SCHEMA,
    accountId: STRING_SCHEMA,
    workerName: STRING_SCHEMA,
    workerBaseUrl: STRING_SCHEMA,
    daemonBaseUrl: STRING_SCHEMA,
    queueName: STRING_SCHEMA,
    deadLetterQueueName: STRING_SCHEMA,
    maxQueueOpsPerDay: NUMBER_SCHEMA,
  }, ['enabled', 'freeTierMode', 'accountId', 'workerName', 'workerBaseUrl', 'daemonBaseUrl', 'queueName', 'deadLetterQueueName', 'maxQueueOpsPerDay']),
  limits: objectSchema({
    tickIntervalMs: NUMBER_SCHEMA,
    maxDelayMs: NUMBER_SCHEMA,
    maxJobsPerProviderBatch: NUMBER_SCHEMA,
    maxQueuePayloadBytes: NUMBER_SCHEMA,
    maxQueueMessagesPerDay: NUMBER_SCHEMA,
  }, ['tickIntervalMs', 'maxDelayMs', 'maxJobsPerProviderBatch', 'maxQueuePayloadBytes', 'maxQueueMessagesPerDay']),
  supportedProviders: arraySchema(STRING_SCHEMA),
}, ['mode', 'fallback', 'queueBackend', 'cloudflare', 'limits', 'supportedProviders']);

const BATCH_RUN_RESULT_SCHEMA = objectSchema({
  submittedProviderBatches: NUMBER_SCHEMA,
  submittedJobs: NUMBER_SCHEMA,
  polledProviderBatches: NUMBER_SCHEMA,
  completedJobs: NUMBER_SCHEMA,
  failedJobs: NUMBER_SCHEMA,
}, ['submittedProviderBatches', 'submittedJobs', 'polledProviderBatches', 'completedJobs', 'failedJobs']);

export const builtinGatewayBatchMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'batch.runtime.get',
    title: 'Batch Runtime',
    description: 'The batch queue\'s current mode (`off`: nothing is queued; `explicit`: the job API is open and a non-streaming OpenAI-compatible chat completion is queued when it sends `x-goodvibes-execution: batch`; `eligible-by-default`: every such completion is queued unless it sends `x-goodvibes-execution: live`), what happens to a job whose provider cannot batch (`fallback`: `live` runs it at once on the live path and answers it finished, `fail` refuses it), which queue backend holds jobs, the Cloudflare settings it would use, its limits, and the providers that can batch. `GET /api/batch` and `GET /api/batch/config` return the same document.',
    category: 'batch',
    scopes: ['read:batch'],
    http: { method: 'GET', path: '/api/batch/runtime' },
    inputSchema: objectSchema({}, []),
    outputSchema: BATCH_RUNTIME_SCHEMA,
  }),
  methodDescriptor({
    id: 'batch.jobs.list',
    title: 'List Batch Jobs',
    description: 'Batch jobs, newest first. `limit` defaults to 100 and is capped at 1000.',
    category: 'batch',
    scopes: ['read:batch'],
    http: { method: 'GET', path: '/api/batch/jobs' },
    inputSchema: objectSchema({ limit: NUMBER_SCHEMA }, []),
    outputSchema: objectSchema({ jobs: arraySchema(BATCH_JOB_SCHEMA) }, ['jobs']),
  }),
  methodDescriptor({
    id: 'batch.jobs.get',
    title: 'Get Batch Job',
    description: 'One batch job with its status and, once finished, its result or error. An unknown id is a 404 with code BATCH_JOB_NOT_FOUND.',
    category: 'batch',
    scopes: ['read:batch'],
    http: { method: 'GET', path: '/api/batch/jobs/{jobId}' },
    inputSchema: objectSchema({ jobId: STRING_SCHEMA }, ['jobId']),
    outputSchema: BATCH_JOB_ENVELOPE_SCHEMA,
  }),
  methodDescriptor({
    id: 'batch.jobs.create',
    title: 'Create Batch Job',
    description: 'Queue one chat request to run later as part of a provider batch, answered 202 with the queued job. A message or tool the provider could never accept is refused here with INVALID_BATCH_REQUEST rather than accepted with a job id. `flush: true` submits it right away instead of waiting for the next pass, and the response then carries the job as that pass left it. When the provider cannot batch (no batch API, or not configured for it) and `batch.fallback` is `live`, the request runs at once on the live path and the job comes back finished: `completed` with its result, or `failed` with code LIVE_FALLBACK_FAILED, marked `metadata["goodvibes.execution"] = "live-fallback"`; with `fallback: fail` it is refused with BATCH_PROVIDER_UNSUPPORTED or BATCH_PROVIDER_NOT_CONFIGURED (409). Refused with BATCH_DISABLED (409) while the mode is `off`, LIVE_REQUEST_NOT_ACCEPTED (400) for `executionMode: "live"`, and BATCH_REQUEST_TOO_LARGE (413) above the request size limit. Spends provider budget, so it needs an admin.',
    category: 'batch',
    scopes: ['write:batch'],
    access: 'admin',
    dangerous: true,
    effect: 'outward',
    http: { method: 'POST', path: '/api/batch/jobs' },
    inputSchema: bodyEnvelopeSchema({
      provider: STRING_SCHEMA,
      model: STRING_SCHEMA,
      request: bodyEnvelopeSchema({
        messages: arraySchema(OPEN_OBJECT_SCHEMA),
        tools: arraySchema(OPEN_OBJECT_SCHEMA),
        systemPrompt: STRING_SCHEMA,
        maxTokens: NUMBER_SCHEMA,
        reasoningEffort: STRING_SCHEMA,
        reasoningSummary: BOOLEAN_SCHEMA,
      }, ['messages']),
      executionMode: STRING_SCHEMA,
      source: objectSchema({
        kind: stringEnumSchema(['daemon-api', 'cloudflare-worker', 'cloudflare-queue', 'automation', 'client']),
        id: STRING_SCHEMA,
      }, []),
      metadata: objectSchema({}, [], { additionalProperties: true }),
      flush: BOOLEAN_SCHEMA,
    }, ['request']),
    outputSchema: BATCH_JOB_ENVELOPE_SCHEMA,
  }),
  methodDescriptor({
    id: 'batch.jobs.cancel',
    title: 'Cancel Batch Job',
    description: 'Cancel a queued job. A job already in a terminal state is returned unchanged; a job already submitted to the provider is refused with 409, because provider batches cancel as a whole. Needs an admin.',
    category: 'batch',
    scopes: ['write:batch'],
    access: 'admin',
    http: { method: 'POST', path: '/api/batch/jobs/{jobId}/cancel' },
    inputSchema: objectSchema({ jobId: STRING_SCHEMA }, ['jobId']),
    outputSchema: BATCH_JOB_ENVELOPE_SCHEMA,
  }),
  methodDescriptor({
    id: 'batch.run',
    title: 'Run Batch Pass',
    description: 'Run one submit-and-poll pass over the queue now instead of waiting for the timer. `force: true` submits queued jobs even before their delay has elapsed. Returns the counts for this pass, all zero when the mode is `off`. Spends provider budget, so it needs an admin.',
    category: 'batch',
    scopes: ['write:batch'],
    access: 'admin',
    dangerous: true,
    effect: 'outward',
    http: { method: 'POST', path: '/api/batch/tick' },
    inputSchema: bodyEnvelopeSchema({ force: BOOLEAN_SCHEMA }, []),
    outputSchema: BATCH_RUN_RESULT_SCHEMA,
  }),
];

