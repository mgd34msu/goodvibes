import { refusal, refusalErrorBody } from '@goodvibes/engine/errors';
import type { DaemonBatchManager } from '../../batch/index.js';
import { DaemonBatchError } from '../../batch/index.js';
import type { CreateDaemonBatchJobInput } from '../../batch/types.js';
import { readReasoningEffortLevel } from '../../providers/reasoning-effort.js';
import { decodePathSegment, readBoundedPositiveInteger } from './route-helpers.js';

export interface DaemonBatchRouteContext {
  readonly batchManager: DaemonBatchManager;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<Record<string, unknown> | null | Response>;
}

/**
 * The paths this sub-router serves.
 * Read by the capability-route reconcile, which cannot see a sub-router that is
 * dispatched ahead of the shared route table. `{param}` is one path segment.
 */
export const BATCH_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'GET', path: '/api/batch' },
  { method: 'GET', path: '/api/batch/config' },
  { method: 'GET', path: '/api/batch/runtime' },
  { method: 'GET', path: '/api/batch/jobs' },
  { method: 'POST', path: '/api/batch/jobs' },
  { method: 'GET', path: '/api/batch/jobs/{jobId}' },
  { method: 'POST', path: '/api/batch/jobs/{jobId}/cancel' },
  { method: 'POST', path: '/api/batch/provider-batches/{providerBatchId}/cancel' },
  { method: 'POST', path: '/api/batch/tick' },
];

export async function dispatchBatchRoutes(
  req: Request,
  context: DaemonBatchRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if ((pathname === '/api/batch' || pathname === '/api/batch/config' || pathname === '/api/batch/runtime') && req.method === 'GET') {
    return Response.json(await context.batchManager.describeRuntime());
  }

  if (pathname === '/api/batch/jobs' && req.method === 'GET') {
    const limit = readBoundedPositiveInteger(url.searchParams.get('limit'), 100, 1_000);
    return Response.json({ jobs: await context.batchManager.listJobs(limit) });
  }

  if (pathname === '/api/batch/jobs' && req.method === 'POST') {
    const bodyOrErr = await context.parseJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleBatchError(async () => {
      const job = await context.batchManager.createJob(parseCreateJobInput(bodyOrErr));
      return Response.json({ job }, { status: 202 });
    });
  }

  const jobMatch = pathname.match(/^\/api\/batch\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === 'GET') {
    const jobId = decodePathSegment(jobMatch[1]!);
    if (jobId === null) return Response.json({ error: 'Malformed batch job id in path', code: 'INVALID_BATCH_REQUEST' }, { status: 400 });
    const job = await context.batchManager.getJob(jobId);
    if (!job) return Response.json({ error: 'Batch job not found', code: 'BATCH_JOB_NOT_FOUND' }, { status: 404 });
    return Response.json({ job });
  }

  const cancelMatch = pathname.match(/^\/api\/batch\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const jobId = decodePathSegment(cancelMatch[1]!);
    if (jobId === null) return Response.json({ error: 'Malformed batch job id in path', code: 'INVALID_BATCH_REQUEST' }, { status: 400 });
    return handleBatchError(async () => {
      const job = await context.batchManager.cancelJob(jobId);
      return Response.json({ job });
    });
  }

  const providerBatchCancelMatch = pathname.match(/^\/api\/batch\/provider-batches\/([^/]+)\/cancel$/);
  if (providerBatchCancelMatch && req.method === 'POST') {
    const providerBatchId = decodePathSegment(providerBatchCancelMatch[1]!);
    if (providerBatchId === null) return Response.json({ error: 'Malformed provider batch id in path', code: 'INVALID_BATCH_REQUEST' }, { status: 400 });
    return handleBatchError(async () => Response.json(await context.batchManager.cancelProviderBatch(providerBatchId)));
  }

  if (pathname === '/api/batch/tick' && req.method === 'POST') {
    const bodyOrErr = await context.parseOptionalJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    const body = bodyOrErr ?? {};
    return handleBatchError(async () => {
      const result = await context.batchManager.tick({ forceSubmit: body['force'] === true });
      return Response.json(result);
    });
  }

  return null;
}

async function handleBatchError(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof DaemonBatchError) {
      // A refusal that says what state it leaves and what to do next carries both on the wire.
      if (error.state !== undefined) {
        return Response.json(refusalErrorBody(refusal({
          code: error.code,
          state: error.state,
          reason: error.message,
          next: error.next ?? [],
          status: error.status,
        })), { status: error.status });
      }
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: 'BATCH_ERROR' }, { status: 500 });
  }
}

function parseCreateJobInput(body: Record<string, unknown>): CreateDaemonBatchJobInput {
  const request = toRecord(body['request']);
  const source = toRecord(body['source']);
  const metadata = toStringRecord(body['metadata']);
  const reasoningEffort = readReasoningEffortLevel(request['reasoningEffort']);
  const input: CreateDaemonBatchJobInput = {
    ...(typeof body['provider'] === 'string' ? { provider: body['provider'] } : {}),
    ...(typeof body['model'] === 'string' ? { model: body['model'] } : {}),
    request: {
      messages: parseMessages(request['messages']),
      ...(Array.isArray(request['tools']) ? { tools: parseTools(request['tools']) } : {}),
      ...(typeof request['systemPrompt'] === 'string' ? { systemPrompt: request['systemPrompt'] } : {}),
      ...(typeof request['maxTokens'] === 'number' ? { maxTokens: request['maxTokens'] } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(typeof request['reasoningSummary'] === 'boolean' ? { reasoningSummary: request['reasoningSummary'] } : {}),
    },
    ...(body['executionMode'] === 'batch' || body['executionMode'] === 'live' ? { executionMode: body['executionMode'] } : {}),
    ...(Object.keys(source).length > 0
      ? {
          source: {
            kind: parseSourceKind(source['kind']),
            ...(typeof source['id'] === 'string' ? { id: source['id'] } : {}),
          },
        }
      : {}),
    ...(metadata ? { metadata } : {}),
    ...(typeof body['flush'] === 'boolean' ? { flush: body['flush'] } : {}),
  };
  return input;
}

function invalidBatchRequest(message: string): DaemonBatchError {
  return new DaemonBatchError(message, 'INVALID_BATCH_REQUEST', 400);
}

type BatchMessages = CreateDaemonBatchJobInput['request']['messages'];
type BatchTools = NonNullable<CreateDaemonBatchJobInput['request']['tools']>;

// A job is queued and only runs at a later provider tick, so a message or tool
// the provider can never accept must be refused here, not accepted with a job id.
function parseMessages(value: unknown): BatchMessages {
  if (!Array.isArray(value)) return [];
  value.forEach((entry, index) => {
    const message = toRecord(entry);
    const where = `request.messages[${index}]`;
    const role = message['role'];
    const content = message['content'];
    if (role === 'user') {
      if (typeof content !== 'string' && !Array.isArray(content)) throw invalidBatchRequest(`${where}.content must be a string or an array of content parts.`);
    } else if (role === 'assistant') {
      if (typeof content !== 'string') throw invalidBatchRequest(`${where}.content must be a string.`);
    } else if (role === 'tool') {
      if (typeof content !== 'string' || typeof message['callId'] !== 'string') throw invalidBatchRequest(`${where} needs a string content and a string callId.`);
    } else {
      throw invalidBatchRequest(`${where}.role must be "user", "assistant" or "tool".`);
    }
  });
  return value as BatchMessages;
}

function parseTools(value: readonly unknown[]): BatchTools {
  value.forEach((entry, index) => {
    const tool = toRecord(entry);
    if (typeof tool['name'] !== 'string' || tool['name'].length === 0 || typeof tool['description'] !== 'string' || !isPlainRecord(tool['parameters'])) {
      throw invalidBatchRequest(`request.tools[${index}] needs a name, a description and a parameters object.`);
    }
  });
  return value as BatchTools;
}

function isPlainRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSourceKind(value: unknown): NonNullable<CreateDaemonBatchJobInput['source']>['kind'] {
  if (
    value === 'daemon-api' ||
    value === 'cloudflare-worker' ||
    value === 'cloudflare-queue' ||
    value === 'automation' ||
    value === 'client'
  ) {
    return value;
  }
  return 'daemon-api';
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  const record = toRecord(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
