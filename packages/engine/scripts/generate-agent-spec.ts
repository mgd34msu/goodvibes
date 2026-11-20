#!/usr/bin/env bun
/**
 * generate-agent-spec.ts
 *
 * Writes the small, agent-facing slice of the operator contract: sessions,
 * tasks, contracts, approvals and the event stream, with schemas shared through
 * `components` instead of inlined 475 times, the real error body, the codes
 * each method's route declares, and a compact operation index. The full document stays the reference; this one is
 * what an agent reads first.
 *
 * It runs when asked (`bun run agent-spec:generate`); `contracts:check` compares it in
 * check mode and `refresh:contracts` writes it. `--check` exits 1 when the committed
 * files are stale, for use after a contract change.
 *
 * Outputs (committed):
 *   - docs/agent-api.openapi.json   the OpenAPI 3.1 slice
 *   - docs/agent-api-index.md       one line per operation, the events, the error codes
 *
 * Source: contracts/artifacts/operator-contract.json, the same input as the full document.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineErrorCodes } from '../errors/src/error-codes.ts';
import { GATEWAY_METHOD_INVOKE_PATH } from '../daemon-api/src/operator.ts';
import { DEFAULT_CONFIG } from '../platform/src/platform/config/schema.ts';
import type { ContractErrorCode, OperatorContractManifest, OperatorMethodContract, OperatorEventContract, JsonSchema } from '../contracts/src/types.ts';
import {
  buildParameters, errorBodySchema, hasRequestBody, INVOKE_ENVELOPE_SCHEMA, isOpaqueSchema, knownErrorCodes, pathParamNames, replayKey, requestBodySchema,
  REST_LAYER_CODES, SSE_METHODS, SSE_RESPONSE,
} from './openapi-shared.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const CONTRACT_PATH = resolve(ENGINE_ROOT, 'contracts/artifacts/operator-contract.json');
const SPEC_OUT = resolve(ENGINE_ROOT, 'docs/agent-api.openapi.json');
const INDEX_OUT = resolve(ENGINE_ROOT, 'docs/agent-api-index.md');

const FAMILIES = ['sessions', 'tasks', 'contracts', 'approvals'] as const;
const EVENT_METHODS = new Set(['control.events.stream', 'control.events.catalog']);
// The path the daemon serves (daemon-api/src/operator.ts), so the spec can never name another.
const INVOKE_PATH = GATEWAY_METHOD_INVOKE_PATH;

type Json = Record<string, unknown>;

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as OperatorContractManifest;
const methods = contract.operator.methods;
const selected = methods.filter((m) => (FAMILIES as readonly string[]).includes(m.category) || EVENT_METHODS.has(m.id));
const rest = selected.filter((m) => m.http);
const wsOnly = selected.filter((m) => !m.http);

/** Each code the selected methods' routes declare, once, with the REST layer's codes first. */
const declaredCodes: readonly ContractErrorCode[] = [
  ...new Map([...REST_LAYER_CODES, ...selected.flatMap((m) => m.errorCodes ?? [])].map((entry) => [entry.code, entry])).values(),
];
const codesWithStatus = (status: number): string => declaredCodes.filter((entry) => entry.status === status).map((entry) => entry.code).join(', ');

// ---------------------------------------------------------------------------
// Shared schema components
// ---------------------------------------------------------------------------

const canonical = (value: unknown): string => JSON.stringify(value);
const isPlain = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const MIN_SHARED_LENGTH = 240;

function isCandidate(node: unknown): node is Json {
  return isPlain(node) && node['type'] === 'object' && isPlain(node['properties'])
    && Object.keys(node['properties']).length >= 2 && canonical(node).length >= MIN_SHARED_LENGTH;
}

function children(node: unknown): Array<{ hint: string; value: unknown }> {
  if (Array.isArray(node)) return node.map((value) => ({ hint: '', value }));
  if (!isPlain(node)) return [];
  const out: Array<{ hint: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isPlain(value)) {
      for (const [name, child] of Object.entries(value)) out.push({ hint: name, value: child });
    } else {
      out.push({ hint: key === 'items' ? '*' : '', value });
    }
  }
  return out;
}

const pascal = (text: string): string => text.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _s, c: string) => c.toUpperCase());
const singular = (text: string): string => (text.endsWith('ies') ? `${text.slice(0, -3)}y` : text.endsWith('s') && !text.endsWith('ss') ? text.slice(0, -1) : text);

/** Count each distinct object shape; a shape already seen is not descended into again. */
function countShapes(roots: ReadonlyArray<{ hint: string; value: unknown }>): Map<string, { count: number; hint: string }> {
  const seen = new Map<string, { count: number; hint: string }>();
  const walk = (node: unknown, hint: string): void => {
    if (isCandidate(node)) {
      const key = canonical(node);
      const entry = seen.get(key);
      if (entry) { entry.count += 1; return; }
      seen.set(key, { count: 1, hint });
    }
    for (const child of children(node)) walk(child.value, child.hint === '*' ? hint : child.hint || hint);
  };
  for (const root of roots) walk(root.value, root.hint);
  return seen;
}

const componentSchemas: Record<string, Json> = {};
const sharedNames = new Map<string, string>();

function nameFor(hint: string, used: Set<string>): string {
  const base = pascal(singular(hint)) || 'Shared';
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}${n}`;
  used.add(name);
  return name;
}

function rewrite(node: unknown, isDefinition: boolean): unknown {
  if (!isDefinition && isCandidate(node)) {
    const name = sharedNames.get(canonical(node));
    if (name) return { $ref: `#/components/schemas/${name}` };
  }
  if (Array.isArray(node)) return node.map((item) => rewrite(item, false));
  if (!isPlain(node)) return node;
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, rewrite(value, false)]));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface RawSchemas { readonly input: JsonSchema | undefined; readonly output: JsonSchema | undefined }
const rawSchemas = new Map<string, RawSchemas>();
for (const method of rest) rawSchemas.set(method.id, { input: method.inputSchema, output: method.outputSchema });

const hintRoots: Array<{ hint: string; value: unknown }> = [];
for (const method of rest) {
  const raw = rawSchemas.get(method.id)!;
  const stem = method.id.split('.').slice(-2)[0] ?? method.category;
  if (raw.input && !isOpaqueSchema(raw.input)) hintRoots.push({ hint: `${stem}-${method.id.split('.').pop()}-request`, value: raw.input });
  if (raw.output && !isOpaqueSchema(raw.output)) hintRoots.push({ hint: `${stem}-${method.id.split('.').pop()}-response`, value: raw.output });
}
const shapeCounts = countShapes(hintRoots);
const usedNames = new Set<string>(['ErrorBody', 'MissingScopeBody']);
for (const [shape, info] of [...shapeCounts.entries()].filter(([, v]) => v.count >= 2)) {
  sharedNames.set(shape, nameFor(info.hint, usedNames));
}
// Component bodies are the shapes themselves, with the other shared shapes referenced.
for (const [shape, name] of sharedNames) componentSchemas[name] = rewrite(JSON.parse(shape), true) as Json;

function rewriteSchema(schema: JsonSchema | undefined): unknown {
  return schema === undefined ? undefined : rewrite(schema, false);
}

function errorResponses(method: OperatorMethodContract): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const http = method.http!;
  const hasInput = !isOpaqueSchema(method.inputSchema);
  if (hasInput || http.method !== 'GET') out['400'] = { $ref: '#/components/responses/BadRequest' };
  out['401'] = { $ref: '#/components/responses/Unauthorized' };
  if (method.scopes.length > 0) out['403'] = { $ref: '#/components/responses/MissingScope' };
  if (pathParamNames(http.path).length > 0) out['404'] = { $ref: '#/components/responses/NotFound' };
  if (http.method !== 'GET' && pathParamNames(http.path).length > 0) out['409'] = { $ref: '#/components/responses/Conflict' };
  out['default'] = { $ref: '#/components/responses/Error' };
  return out;
}

function operationFor(method: OperatorMethodContract): Json {
  const http = method.http!;
  const replay = replayKey(method);
  const params = buildParameters(method).map((param) => (isPlain(param['schema']) ? { ...param, schema: rewriteSchema(param['schema'] as JsonSchema) } : param));
  const op: Json = {
    operationId: method.id,
    summary: method.title,
    description: replay ? `${method.description}\n\n${replay.note}` : method.description,
    tags: [method.category === 'control-plane' ? 'events' : method.category],
    ...(params.length > 0 ? { parameters: params } : {}),
    responses: {
      '200': SSE_METHODS.has(method.id)
        ? { ...SSE_RESPONSE }
        : {
            description: 'Success',
            content: { 'application/json': { schema: isOpaqueSchema(method.outputSchema) ? { description: 'No declared output schema.' } : rewriteSchema(method.outputSchema) } },
          },
      ...errorResponses(method),
    },
    ...(method.scopes.length > 0 ? { 'x-scopes': method.scopes } : {}),
    ...(replay ? { 'x-replay-key': replay.extension } : {}),
    ...(method.errorCodes ? { 'x-error-codes': method.errorCodes } : {}),
  };
  if (hasRequestBody(method) && method.inputSchema) {
    const input = method.inputSchema;
    const body = requestBodySchema(method)!;
    op['requestBody'] = {
      required: http.method === 'DELETE' ? ((body.required ?? []) as readonly string[]).length > 0 : !isOpaqueSchema(input),
      content: { 'application/json': { schema: isOpaqueSchema(input) ? { description: 'No declared input schema.' } : rewriteSchema(body as JsonSchema) } },
    };
  }
  return op;
}

const paths: Record<string, Record<string, unknown>> = {};
for (const method of rest) {
  const { path, method: verb } = method.http!;
  (paths[path] ??= {})[verb.toLowerCase()] = operationFor(method);
}
paths[INVOKE_PATH] = {
  post: {
    operationId: 'gateway.invoke',
    summary: 'Invoke a method that has no REST route',
    description: 'The methods listed in `x-invoke-only-methods` are reachable only here (and over the WebSocket). The request body is an envelope: the method input goes in `body` (required; `{}` for a method that takes none) and any query parameters in `query`. A request without `body` is refused with 400. The response is the method output itself.',
    tags: ['gateway'],
    parameters: [{ name: 'methodId', in: 'path', required: true, schema: { type: 'string', enum: wsOnly.map((m) => m.id).sort() } }],
    requestBody: { required: true, content: { 'application/json': { schema: INVOKE_ENVELOPE_SCHEMA } } },
    responses: { '200': { description: 'The method output.', content: { 'application/json': { schema: {} } } }, '401': { $ref: '#/components/responses/Unauthorized' }, default: { $ref: '#/components/responses/Error' } },
    'x-invoke-only-methods': wsOnly.map((m) => m.id).sort(),
  },
};

const document = {
  openapi: '3.1.0',
  info: {
    title: 'GoodVibes Operator API: agent slice',
    version: contract.product.version,
    description:
      'Sessions, tasks, contracts, approvals and the event stream from the operator contract, for agents and scripts. '
      + 'Schemas repeated across operations are shared under components.schemas. The full document is '
      + '`contracts/artifacts/operator-openapi.json`; this one is generated from the same contract by '
      + '`bun run agent-spec:generate` and is not written by any build.',
  },
  servers: [{ url: 'http://127.0.0.1:{port}', variables: { port: { default: String(DEFAULT_CONFIG.controlPlane.port) } }, description: 'Local daemon (controlPlane.port)' }],
  security: [{ bearerAuth: [] }, { sessionCookie: [] }],
  tags: [...FAMILIES, 'events', 'gateway'].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Operator bearer token (Authorization: Bearer <token>).' },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: contract.auth.sessionCookie.name, description: 'Login-issued session cookie.' },
    },
    responses: {
      Error: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
      BadRequest: { description: `The request was malformed or failed validation; nothing was changed. Codes declared: ${codesWithStatus(400)}.`, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
      Unauthorized: { description: 'No valid bearer token or session cookie.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
      MissingScope: { description: 'The principal lacks a scope the operation requires; the body names the missing scopes.', content: { 'application/json': { schema: { $ref: '#/components/schemas/MissingScopeBody' } } } },
      NotFound: { description: 'The addressed record does not exist. For sessions `code` is SESSION_NOT_FOUND.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
      Conflict: { description: `The target is in a state that cannot take this action; the body names the state and what is allowed. Codes declared: ${codesWithStatus(409)}.`, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
    },
    schemas: {
      ErrorBody: errorBodySchema(knownErrorCodes(selected)),
      MissingScopeBody: {
        type: 'object',
        required: ['error', 'requiredScopes', 'grantedScopes', 'missingScopes'],
        properties: {
          error: { type: 'string' },
          requiredScopes: { type: 'array', items: { type: 'string' } },
          grantedScopes: { type: 'array', items: { type: 'string' } },
          missingScopes: { type: 'array', items: { type: 'string' } },
        },
      },
      ...componentSchemas,
    },
  },
  'x-event-domains': contract.operator.events.map((event: OperatorEventContract) => ({ id: event.id, ...(event.domains ? { domains: event.domains } : {}) })),
};

// ---------------------------------------------------------------------------
// Compact index
// ---------------------------------------------------------------------------

const oneLine = (text: string, max = 110): string => {
  const first = text.split(/(?<=[.!?])\s/)[0]!.replace(/\s+/g, ' ').trim();
  return (first.length > max ? `${first.slice(0, max - 1)}…` : first).replace(/\|/g, '/');
};

function indexMarkdown(): string {
  const lines: string[] = [
    '# Agent API index',
    '',
    `Generated from the operator contract (product ${contract.product.version}) by \`bun run agent-spec:generate\`. Spec: [agent-api.openapi.json](./agent-api.openapi.json). Everything not listed here is in the full document, \`contracts/artifacts/operator-openapi.json\`.`,
    '',
    'Auth: `Authorization: Bearer <token>` or the login session cookie. Errors are `{ error, state?, next?, hint?, code?, category?, requestId?, retryAfterMs? }`; a 403 for a missing scope also lists `requiredScopes`, `grantedScopes` and `missingScopes`.',
    '',
  ];
  for (const family of FAMILIES) {
    lines.push(`## ${family}`, '', '| Method id | Route | Scopes | Replay key | Does |', '| --- | --- | --- | --- | --- |');
    for (const method of selected.filter((m) => m.category === family).sort((a, b) => a.id.localeCompare(b.id))) {
      const route = method.http ? `${method.http.method} ${method.http.path}` : 'invoke / WebSocket only';
      const replay = replayKey(method);
      lines.push(`| \`${method.id}\` | ${method.http ? `\`${route}\`` : route} | ${method.scopes.join(', ') || 'none'} | ${replay ? `${replay.extension['in']} \`${replay.extension['name']}\`` : ''} | ${oneLine(method.description)} |`);
    }
    lines.push('');
  }
  lines.push('## events', '', `Stream: \`GET /api/control-plane/events?domains=<comma list>\` (\`text/event-stream\`), catalog at \`GET /api/control-plane/events/catalog\`. Methods: ${selected.filter((m) => EVENT_METHODS.has(m.id)).map((m) => `\`${m.id}\``).join(', ')}.`, '', '| Event id | Domains |', '| --- | --- |');
  for (const event of contract.operator.events) lines.push(`| \`${event.id}\` | ${(event.domains ?? []).join(', ') || 'control'} |`);
  lines.push('', '## Replay', '', 'These methods recognise a retry of the same request by a request header or a body field, and return the first result instead of acting twice:', '');
  for (const method of selected.concat(methods.filter((m) => m.id.startsWith('workLedger.'))).filter((m, i, all) => m.replay && all.indexOf(m) === i)) {
    const replay = replayKey(method)!;
    lines.push(`- \`${method.id}\`: ${replay.extension['in']} \`${replay.extension['name']}\`. ${replay.extension['behavior']}`);
  }
  lines.push('', '## Error codes', '', 'Declared by each method beside its route; every operation also lists its own under `x-error-codes`.', '', '| Code | Status | Meaning |', '| --- | --- | --- |');
  for (const entry of declaredCodes) lines.push(`| \`${entry.code}\` | ${entry.status} | ${entry.meaning.replace(/\|/g, '/')} |`);
  lines.push(`| ${[...Object.values(EngineErrorCodes)].map((code) => `\`${code}\``).join(', ')} | varies | The shared engine codes (\`@goodvibes-jev/engine/errors\`); the status is the route's. |`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

function writeIfChanged(path: string, content: string): boolean {
  let current: string | null = null;
  try { current = readFileSync(path, 'utf8'); } catch { current = null; }
  if (current === content) return false;
  if (CHECK_ONLY) { console.error(`[agent-spec] stale: ${path}`); return true; }
  writeFileSync(path, content, 'utf8');
  console.log(`[agent-spec] wrote: ${path}`);
  return true;
}

const specJson = `${JSON.stringify(document, null, 1)}\n`;
const stale = [writeIfChanged(SPEC_OUT, specJson), writeIfChanged(INDEX_OUT, `${indexMarkdown()}`)].some(Boolean);
if (CHECK_ONLY) {
  if (stale) { console.error('[agent-spec] run `bun run agent-spec:generate`'); process.exit(1); }
  console.log('[agent-spec] up to date');
} else {
  console.log(`[agent-spec] ${Object.keys(paths).length} paths, ${selected.length} methods, ${sharedNames.size} shared schemas, ${(specJson.length / 1024).toFixed(0)} KB`);
}
