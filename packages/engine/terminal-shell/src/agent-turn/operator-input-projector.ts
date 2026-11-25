import { GatewayMethodCatalog } from '@goodvibes/engine/platform/platform/control-plane';
import { captureStrictJudgmentJson } from '@goodvibes/engine/platform/platform/gate';
import { assertProjectionExecution, ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import type { ToolInputProjector } from '@goodvibes/engine/platform/platform/tools';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { isDeepStrictEqual } from 'node:util';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { operatorMethodIsReadOnly, resolveOperatorContractMethod } from './operator-contract-routes.js';
import { getOperatorActions, isOperatorActionId, targetValue } from './operator-actions.js';
import { captureOperatorConnection } from './operator-connection-owner.js';
import { captureOperatorAutomationTarget, type OperatorAutomationTarget } from './operator-automation-target.js';
import { captureOperatorRequestPolicy } from './operator-request-policy.js';

// The method descriptors state whether a method sends something outward; built once, on first use.
let builtinMethods: GatewayMethodCatalog | undefined;

/** True when the method dispatches messages, remote commands or metered work (its descriptor's `effect`). */
export function operatorMethodIsOutward(methodId: string): boolean {
  builtinMethods ??= new GatewayMethodCatalog();
  return builtinMethods.get(methodId)?.effect === 'outward';
}

/** True when a model never calls the method (its descriptor's `modelRefused`): the Agent never calls it. */
export function operatorMethodIsOwnerOnly(methodId: string): boolean {
  builtinMethods ??= new GatewayMethodCatalog();
  return builtinMethods.get(methodId)?.modelRefused === true;
}

type CapturedConnection = ReturnType<typeof captureOperatorConnection>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const contexts = new WeakMap<object, { readonly connection: CapturedConnection | undefined; readonly assertCurrent: () => void;
  readonly automation: OperatorAutomationTarget; readonly requestPolicy: ReturnType<typeof captureOperatorRequestPolicy> | undefined;
  readonly shellPaths: ShellPathService; readonly reader: AgentConnectedHostConfigReader; readonly kind: 'method' | 'action';
  readonly secrets: readonly SecretInputLeaf[] }>();

/** One secret value of a nested method call: where it goes in the method's input, what the call shows there instead, and the value. */
export interface SecretInputLeaf {
  readonly path: readonly string[];
  readonly shown: string;
  readonly value: string;
}

/**
 * Secret values of nested calls capability_run is about to make, by the call id
 * it gives the nested call (never one a model chooses). The call itself carries
 * each value hidden, so its ask, its approval record and every frame show the
 * hidden form; the value is put back only into the request this exact call sends.
 */
const heldSecretLeaves = new Map<string, readonly SecretInputLeaf[]>();

/** Hold the secret values of the nested method call `callId` until its projection takes them (once). */
export function holdNestedSecretInputs(callId: string, leaves: readonly SecretInputLeaf[]): void {
  if (leaves.length > 0) heldSecretLeaves.set(callId, leaves);
}

/** Forget what a nested call that never ran was holding. */
export function dropNestedSecretInputs(callId: string): void {
  heldSecretLeaves.delete(callId);
}

function leafAt(value: unknown, path: readonly string[]): unknown {
  let node = value;
  for (const part of path) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

function withLeaves(payload: Record<string, unknown>, leaves: readonly SecretInputLeaf[]): Record<string, unknown> {
  if (leaves.length === 0) return payload;
  const copy = structuredClone(payload);
  for (const leaf of leaves) {
    let node: Record<string, unknown> = copy;
    for (const part of leaf.path.slice(0, -1)) {
      const next = node[part];
      if (!isRecord(next)) throw new ToolInputProjectionError('binding-changed');
      node = next;
    }
    const last = leaf.path.at(-1)!;
    // The request carries the hidden form exactly where the value goes, or nothing is sent.
    if (node[last] !== leaf.shown) throw new ToolInputProjectionError('binding-changed');
    node[last] = leaf.value;
  }
  return copy;
}

/** Capture connection authority before any repair or admission reading. */
export function createOperatorInputProjector(shellPaths: ShellPathService, reader: AgentConnectedHostConfigReader,
  kind: 'method' | 'action', inProcess?: AgentInProcessHost): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    const args = captureStrictJudgmentJson(request.args);
    const id = kind === 'method' ? args.methodId : args.action;
    if (typeof id !== 'string' || !id.trim()) throw new ToolInputProjectionError('held');
    const method = resolveOperatorContractMethod(id.trim());
    if (!method) throw new ToolInputProjectionError('held');
    const snapshot = captureStrictJudgmentJson(method);
    const descriptor = kind === 'action' && isOperatorActionId(id) ? getOperatorActions()[id] : undefined;
    if (kind === 'action' && !descriptor) throw new ToolInputProjectionError('held');
    const preview = kind === 'method' && args.dryRun === true;
    const requestPolicy = !preview && (kind === 'action' || !operatorMethodIsReadOnly(snapshot, args.input) || operatorMethodIsOutward(snapshot.id))
      ? captureOperatorRequestPolicy() : undefined;
    // The contract and the action table are fixed for the life of the process, so the method and
    // descriptor read above stay what they are; only the call itself and the request policy can change.
    const assertSource = () => {
      request.signal?.throwIfAborted();
      requestPolicy?.assertCurrent();
    };
    const connection = preview ? undefined : captureOperatorConnection(shellPaths, reader, assertSource, inProcess);
    let automation: OperatorAutomationTarget = { wireFields: {} };
    if (connection) {
      const input = kind === 'method' ? args.input : args;
      const parameters = isRecord(input) ? captureStrictJudgmentJson(input) : {};
      const targetInput = descriptor ? { ...parameters, [descriptor.targetField]: targetValue(parameters, descriptor) } : parameters;
      automation = await captureOperatorAutomationTarget(snapshot.id, targetInput, connection,
        { signal: request.signal, assertCurrent: () => { request.assertCurrent(); assertSource(); } });
    }
    const secrets = kind === 'method' ? heldSecretLeaves.get(request.callId) ?? [] : [];
    heldSecretLeaves.delete(request.callId);
    for (const leaf of secrets) if (leafAt(args.input, leaf.path) !== leaf.shown) throw new ToolInputProjectionError('binding-changed');
    const context = Object.freeze({}); let released = false;
    const assertCurrent = () => {
      if (released) throw new ToolInputProjectionError('released');
      assertSource(); connection?.assertCurrent();
    };
    const assertPrepared = () => { request.assertCurrent(); assertCurrent(); request.assertCurrent(); };
    contexts.set(context, { connection, assertCurrent, automation, requestPolicy, shellPaths, reader, kind, secrets }); assertPrepared();
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent: assertPrepared,
      ...(preview || (operatorMethodIsReadOnly(snapshot, args.input) && !operatorMethodIsOutward(snapshot.id)) ? { resultPublication: 'read-only' } : {}),
      assertRepairedArgs(repaired) {
        if (!isDeepStrictEqual(captureStrictJudgmentJson(repaired), args)) throw new ToolInputProjectionError('binding-changed');
        assertPrepared();
      },
      async release() { released = true; contexts.delete(context); },
    };
  } };
}

/** An actual registered execution alone can retrieve its pre-admission connection. */
export function operatorExecutionConnection(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  shellPaths: ShellPathService, reader: AgentConnectedHostConfigReader, kind: 'method' | 'action'): CapturedConnection | undefined {
  const context = options?.inputProjectionContext;
  if (!context) return undefined;
  const binding = contexts.get(context);
  if (!binding || binding.shellPaths !== shellPaths || binding.reader !== reader || binding.kind !== kind) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertCurrent();
  return binding.connection;
}

/** Apply only private native fields retained by this exact registered owner. */
export function operatorExecutionWireInput(input: Record<string, unknown>, args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  shellPaths: ShellPathService, reader: AgentConnectedHostConfigReader, kind: 'method' | 'action'): Record<string, unknown> {
  const context = options?.inputProjectionContext;
  if (!context) return input;
  const binding = contexts.get(context);
  if (!binding || binding.shellPaths !== shellPaths || binding.reader !== reader || binding.kind !== kind) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertCurrent();
  return withLeaves({ ...input, ...binding.automation.wireFields }, binding.secrets);
}

export function operatorExecutionRequestPolicy(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  shellPaths: ShellPathService, reader: AgentConnectedHostConfigReader, kind: 'method' | 'action') {
  const context = options?.inputProjectionContext;
  if (!context) return undefined;
  const binding = contexts.get(context);
  if (!binding || binding.shellPaths !== shellPaths || binding.reader !== reader || binding.kind !== kind) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertCurrent();
  return binding.requestPolicy;
}
