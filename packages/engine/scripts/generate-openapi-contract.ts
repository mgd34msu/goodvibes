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
 *     REST bindings, auth scheme, transports)
 *   - contracts/src/generated/foundation-client-types.ts +
 *     operator-method-ids.ts (the typed-client-IO ratchet inputs), used to mark
 *     the untyped methods HONESTLY: every method whose engine client IO resolves to
 *     `unknown` carries `x-typed-client-io: false`. They are never omitted.
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
import { parseMapKeys, parseMethodIds, untypedMethodIds } from './foundation-io-coverage-rule.ts';
import type { OperatorContractManifest, OperatorMethodContract } from '../contracts/src/types.ts';
import { buildParameters, hasDeleteBody, isOpaqueSchema, pathParamNames, replayKey, SSE_METHODS, SSE_RESPONSE } from './openapi-shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const CONTRACT_PATH = resolve(ENGINE_ROOT, 'contracts/artifacts/operator-contract.json');
const FOUNDATION_TYPES_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/foundation-client-types.ts');
const METHOD_IDS_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/operator-method-ids.ts');
const ARTIFACT_OUT = resolve(ENGINE_ROOT, 'contracts/artifacts/operator-openapi.json');

const INVOKE_PATH = '/api/control/gateway-methods/{methodId}/invoke';

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

function loadUntypedSet(): Set<string> {
  const foundationText = readFileSync(FOUNDATION_TYPES_PATH, 'utf8');
  const idsText = readFileSync(METHOD_IDS_PATH, 'utf8');
  const methodIds = parseMethodIds(idsText);
  const inputKeys = parseMapKeys(foundationText, 'OperatorMethodInputMap');
  const outputKeys = parseMapKeys(foundationText, 'OperatorMethodOutputMap');
  return new Set(untypedMethodIds(methodIds, inputKeys, outputKeys));
}

function securityFor(method: OperatorMethodContract): Record<string, string[]>[] | undefined {
  // 'public' methods opt out of the document-level security requirement.
  if (method.access === 'public') return [];
  return undefined;
}

function buildOperation(method: OperatorMethodContract, untyped: Set<string>): OpenApiOperation {
  const http = method.http!;
  const isUntyped = untyped.has(method.id);
  const opaqueIn = isOpaqueSchema(method.inputSchema);
  const opaqueOut = isOpaqueSchema(method.outputSchema);
  const notes: string[] = [method.description];
  const replay = replayKey(method.id);
  if (replay) notes.push(replay.note);
  if (isUntyped) {
    notes.push(
      'NOTE: this method has no typed engine client IO. Request/response resolve to `unknown` in the typed client (see `x-typed-client-io`).',
    );
  }
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
    'x-typed-client-io': !isUntyped,
    'x-access': method.access,
    'x-transport': method.transport,
    ...(method.scopes.length > 0 ? { 'x-scopes': method.scopes } : {}),
    ...(method.dangerous !== undefined ? { 'x-dangerous': method.dangerous } : {}),
    ...(method.idempotent !== undefined ? { 'x-idempotent': method.idempotent } : {}),
    ...(replay ? { 'x-replay-key': replay.extension } : {}),
  };
  const security = securityFor(method);
  if (security) op.security = security;
  const parameters = buildParameters(method);
  if (parameters.length > 0) op.parameters = parameters;
  if (http.method === 'POST' || http.method === 'PATCH' || (http.method === 'DELETE' && hasDeleteBody(method))) {
    // The expected-turn route's URL is canonical, and its typed engine removes
    // path keys from the wire body. Keep this new route's REST schema honest
    // without migrating the legacy body contracts of unrelated endpoints.
    const inputProperties = (method.inputSchema?.properties ?? {}) as Record<string, unknown>;
    const requiredInputKeys = Array.isArray(method.inputSchema?.required) ? method.inputSchema.required as readonly string[] : [];
    const bodySchema = method.id === 'sessions.turns.cancel' || http.method === 'DELETE'
      ? { ...method.inputSchema,
          properties: Object.fromEntries(Object.entries(inputProperties).filter(([key]) => !pathParamNames(http.path).includes(key))),
          required: requiredInputKeys.filter((key) => !pathParamNames(http.path).includes(key)),
        }
      : method.inputSchema;
    op.requestBody = {
      required: http.method === 'DELETE' ? requiredInputKeys.some((key) => !pathParamNames(http.path).includes(key)) : !opaqueIn,
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

function buildDocument(contract: OperatorContractManifest, untyped: Set<string>): Record<string, unknown> {
  const methods = contract.operator.methods;
  const withHttp = methods.filter((m) => m.http);
  const invokeOnly = methods.filter((m) => !m.http);

  const paths: Record<string, Record<string, unknown>> = {};
  for (const method of withHttp) {
    const { path, method: verb } = method.http!;
    paths[path] ??= {};
    paths[path]![verb.toLowerCase()] = buildOperation(method, untyped);
  }
  paths[INVOKE_PATH] = { post: buildInvokeOperation(invokeOnly) };

  // Every method, REST-bound or invoke-only, appears in this index with its
  // honest coverage marking; any untyped ids are visible, not omitted. The
  // typed-IO ratchet is pinned at zero untyped methods today, and this marking
  // is what keeps a future regression visible rather than silent.
  const methodIndex = methods.map((m) => ({
    id: m.id,
    category: m.category,
    access: m.access,
    rest: m.http ? `${m.http.method} ${m.http.path}` : null,
    typedClientIo: !untyped.has(m.id),
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
        `${untyped.size} methods lack typed engine client IO and are marked with ` +
        '`x-typed-client-io: false`. They are represented honestly, never omitted. ' +
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
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
        },
      },
      schemas: {
        ErrorEnvelope: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            kind: { type: 'string' },
            details: { type: 'object' },
          },
          required: ['error'],
        },
      },
    },
    'x-auth-contract': contract.auth,
    'x-untyped-client-io-count': untyped.size,
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
    `  \`null\` for invoke-only), and schema/typed-IO coverage.`,
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
const untyped = loadUntypedSet();
const document = buildDocument(contract, untyped);
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
  console.log(`[openapi] ${paths} paths, ${contract.operator.methods.length} methods, ${untyped.size} marked untyped-client-io`);
}
if (CHECK_ONLY && !drifted) console.log('[openapi] artifacts up-to-date');
