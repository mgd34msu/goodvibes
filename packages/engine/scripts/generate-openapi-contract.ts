#!/usr/bin/env bun
/**
 * generate-openapi-contract.ts
 *
 * Generates the published OpenAPI 3.1 document for the operator contract from
 * the committed contract artifact (the generated-artifact idiom: deterministic
 * output, committed, with a --check drift mode wired into `contracts:check`).
 *
 * Source of truth:
 *   - contracts/artifacts/operator-contract.json  (methods, IO schemas,
 *     REST bindings, replay keys, error codes, auth scheme, transports)
 *
 * Outputs:
 *   - contracts/artifacts/operator-openapi.json  (committed; package-exported,
 *     prepare-engine-package copies the artifacts dir into the engine dist).
 *     It is the only tracked copy: docs link to it rather than carrying a
 *     second byte-identical 6.5 MB file.
 *   - docs/openapi-contract.md                   (the counts paragraph only)
 *
 * Usage:
 *   bun scripts/generate-openapi-contract.ts          # regenerate
 *   bun scripts/generate-openapi-contract.ts --check  # exit 1 on drift
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperatorContractManifest, OperatorMethodContract } from '../contracts/src/types.ts';
import { GATEWAY_METHOD_INVOKE_PATH } from '../daemon-api/src/operator.ts';
import { buildParameters, errorBodySchema, hasRequestBody, isOpaqueSchema, knownErrorCodes, replayKey, requestBodySchema, SSE_METHODS, SSE_RESPONSE } from './openapi-shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const CONTRACT_PATH = resolve(ENGINE_ROOT, 'contracts/artifacts/operator-contract.json');
const ARTIFACT_OUT = resolve(ENGINE_ROOT, 'contracts/artifacts/operator-openapi.json');

// The path the daemon serves (daemon-api/src/operator.ts), so the spec can never name another.
const INVOKE_PATH = GATEWAY_METHOD_INVOKE_PATH;

interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security?: Record<string, string[]>[];
  parameters?: Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  responses: Record<string, unknown>;
  [extension: `x-${string}`]: unknown;
}

function securityFor(method: OperatorMethodContract): Record<string, string[]>[] | undefined {
  // 'public' methods opt out of the document-level security requirement.
  if (method.access === 'public') return [];
  return undefined;
}

function buildOperation(method: OperatorMethodContract): OpenApiOperation {
  const opaqueIn = isOpaqueSchema(method.inputSchema);
  const opaqueOut = isOpaqueSchema(method.outputSchema);
  const notes: string[] = [method.description];
  const replay = replayKey(method);
  if (replay) notes.push(replay.note);
  const op: OpenApiOperation = {
    operationId: method.id,
    summary: method.title,
    description: notes.join('\n\n'),
    tags: [method.category],
    responses: {
      '200': SSE_METHODS.has(method.id)
        ? { ...SSE_RESPONSE }
        : {
            description: 'Success',
            content: {
              'application/json': {
                schema: opaqueOut
                  ? { description: 'Schema-less response (no declared output schema).', 'x-schema-coverage': 'schema-less' }
                  : method.outputSchema,
              },
            },
          },
      default: { $ref: '#/components/responses/Error' },
    },
    'x-access': method.access,
    'x-transport': method.transport,
    ...(method.scopes.length > 0 ? { 'x-scopes': method.scopes } : {}),
    ...(method.dangerous !== undefined ? { 'x-dangerous': method.dangerous } : {}),
    ...(method.effect !== undefined ? { 'x-effect': method.effect } : {}),
    ...(method.ownerOnly !== undefined ? { 'x-owner-only': method.ownerOnly } : {}),
    ...(method.idempotent !== undefined ? { 'x-idempotent': method.idempotent } : {}),
    ...(replay ? { 'x-replay-key': replay.extension } : {}),
    ...(method.errorCodes ? { 'x-error-codes': method.errorCodes } : {}),
  };
  const security = securityFor(method);
  if (security) op.security = security;
  const parameters = buildParameters(method);
  if (parameters.length > 0) op.parameters = parameters;
  if (hasRequestBody(method)) {
    const bodySchema = requestBodySchema(method);
    op.requestBody = {
      required: method.http!.method === 'DELETE' ? ((bodySchema?.required ?? []) as readonly string[]).length > 0 : !opaqueIn,
      content: {
        'application/json': {
          schema: opaqueIn
            ? { description: 'Schema-less request (no declared input schema).', 'x-schema-coverage': 'schema-less' }
            : bodySchema,
        },
      },
    };
  }
  return op;
}

function buildInvokeOperation(invokeOnly: readonly OperatorMethodContract[]): OpenApiOperation {
  return {
    operationId: 'gateway.invoke',
    summary: 'Invoke a cataloged operator method by id',
    description:
      'The generic invoke endpoint. Every invokable cataloged method is reachable here by ' +
      'its method id; methods WITHOUT a dedicated REST binding (listed in `x-invoke-only-methods`) ' +
      'are reachable ONLY here. Per-method request/response schemas are the same as the ' +
      'per-method entries in `x-operator-methods`.',
    tags: ['gateway'],
    parameters: [{ name: 'methodId', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: { type: 'object', description: 'The method-specific input (see the method\'s inputSchema).' },
        },
      },
    },
    responses: {
      '200': {
        description: 'Method-specific response (see the method\'s outputSchema).',
        content: { 'application/json': { schema: {} } },
      },
      default: { $ref: '#/components/responses/Error' },
    },
    'x-invoke-only-methods': invokeOnly.map((m) => m.id).sort(),
  };
}

function buildDocument(contract: OperatorContractManifest): Record<string, unknown> {
  const methods = contract.operator.methods;
  const withHttp = methods.filter((m) => m.http);
  const invokeOnly = methods.filter((m) => !m.http);

  const paths: Record<string, Record<string, unknown>> = {};
  for (const method of withHttp) {
    const { path, method: verb } = method.http!;
    paths[path] ??= {};
    paths[path]![verb.toLowerCase()] = buildOperation(method);
  }
  paths[INVOKE_PATH] = { post: buildInvokeOperation(invokeOnly) };

  // Every method, REST-bound or invoke-only, appears in this index with its
  // schema coverage.
  const methodIndex = methods.map((m) => ({
    id: m.id,
    category: m.category,
    access: m.access,
    rest: m.http ? `${m.http.method} ${m.http.path}` : null,
    inputSchemaCoverage: isOpaqueSchema(m.inputSchema) ? 'schema-less' : 'typed',
    outputSchemaCoverage: isOpaqueSchema(m.outputSchema) ? 'schema-less' : 'typed',
  }));

  return {
    openapi: '3.1.0',
    info: {
      title: 'GoodVibes Operator API',
      version: contract.product.version,
      description:
        // The committed artifact names the contract by its goodvibes path; kept so the artifact is unchanged.
        'Generated from the operator contract (packages/contracts/artifacts/operator-contract.json). ' +
        `${methods.length} cataloged methods: ${withHttp.length} with dedicated REST bindings, ` +
        `${invokeOnly.length} reachable only through the generic invoke endpoint. ` +
        'Regenerate with `bun run openapi:generate`; drift fails `contracts:check`.',
    },
    servers: [{ url: 'http://127.0.0.1:{port}', variables: { port: { default: '4483' } }, description: 'Local daemon' }],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Operator bearer token (Authorization: Bearer <token>).',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: contract.auth.sessionCookie.name,
          description: 'Login-issued session cookie (see the contract auth.login route).',
        },
      },
      responses: {
        Error: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
        },
      },
      schemas: {
        ErrorBody: errorBodySchema(knownErrorCodes(methods)),
      },
    },
    'x-auth-contract': contract.auth,
    'x-operator-methods': methodIndex,
  };
}

function writeIfChanged(path: string, content: string): boolean {
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    console.error(`[openapi] drift: ${path}`);
    return true;
  }
  writeFileSync(path, content, 'utf8');
  console.log(`[openapi] wrote: ${path}`);
  return true;
}

const DOC_COUNTS_PATH = resolve(ENGINE_ROOT, 'docs/openapi-contract.md');
const DOC_COUNTS_START = '<!-- openapi-counts:start -->';
const DOC_COUNTS_END = '<!-- openapi-counts:end -->';

/** The counts paragraph of docs/openapi-contract.md, so the prose cannot drift from the document. */
function countsParagraph(contract: OperatorContractManifest): string {
  const methods = contract.operator.methods;
  const rest = methods.filter((m) => m.http).length;
  const invokeOnly = methods.length - rest;
  return [
    `  Methods with a dedicated REST binding appear as path operations (${rest} operations, one per`,
    `  method's declared HTTP verb and path); methods without one are reachable only through the`,
    `  generic invoke endpoint (\`POST ${INVOKE_PATH}\`, operation ${rest + 1},`,
    `  ${invokeOnly} methods) and are listed on it under \`x-invoke-only-methods\`.`,
    `  \`x-operator-methods\` is a flat index of all ${methods.length} cataloged methods, REST-bound`,
    `  or invoke-only, each with its category, access level, resolved REST route (or`,
    `  \`null\` for invoke-only), and schema coverage.`,
  ].join('\n');
}

function docWithCounts(current: string, contract: OperatorContractManifest): string {
  const start = current.indexOf(DOC_COUNTS_START);
  const end = current.indexOf(DOC_COUNTS_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`[openapi] ${DOC_COUNTS_PATH} is missing the ${DOC_COUNTS_START} ... ${DOC_COUNTS_END} markers`);
  }
  return `${current.slice(0, start + DOC_COUNTS_START.length)}\n${countsParagraph(contract)}\n  ${current.slice(end)}`;
}

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as OperatorContractManifest;
const document = buildDocument(contract);
const json = `${JSON.stringify(document, null, 2)}\n`;

let drifted = false;
drifted = writeIfChanged(ARTIFACT_OUT, json) || drifted;
drifted = writeIfChanged(DOC_COUNTS_PATH, docWithCounts(readFileSync(DOC_COUNTS_PATH, 'utf8'), contract)) || drifted;

if (CHECK_ONLY && drifted) {
  console.error('[openapi] drift detected, run `bun run openapi:generate`');
  process.exit(1);
}
if (!CHECK_ONLY) {
  const paths = Object.keys(document.paths as Record<string, unknown>).length;
  console.log(`[openapi] ${paths} paths, ${contract.operator.methods.length} methods`);
}
if (CHECK_ONLY && !drifted) console.log('[openapi] artifacts up-to-date');
