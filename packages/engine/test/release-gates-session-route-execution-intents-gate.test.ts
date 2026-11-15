import { describe, expect, test } from 'bun:test';
import {
  SHARED_SESSION_INPUT_RECORD_SCHEMA,
  SHARED_SESSION_ROUTING_INTENT_SCHEMA,
} from '@goodvibes-jev/engine/platform/platform/control-plane';
import {
  AUTOMATION_RUN_SCHEMA,
  ROUTE_BINDING_SCHEMA,
} from '@goodvibes-jev/engine/platform/platform/control-plane';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.ts';

function property(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = ((schema.properties ?? {}) as Record<string, Record<string, unknown> | undefined>)[name];
  if (!found) throw new Error(`schema declares no "${name}" property`);
  return found;
}

/** What the wire contract does with a value: undefined means it is accepted. */
function verdict(schema: Record<string, unknown>, name: string, value: unknown): 'accepted' | 'refused' {
  return firstJsonSchemaFailure(property(schema, name), value) === undefined ? 'accepted' : 'refused';
}

describe('session, route, and execution intent gate', () => {
  const executionIntent = property(SHARED_SESSION_ROUTING_INTENT_SCHEMA, 'executionIntent');

  test('a session routing intent accepts each declared policy and refuses an undeclared one', () => {
    for (const riskClass of ['safe', 'elevated', 'dangerous']) expect(verdict(executionIntent, 'riskClass', riskClass)).toBe('accepted');
    for (const networkPolicy of ['inherit', 'allow', 'deny', 'scoped']) expect(verdict(executionIntent, 'networkPolicy', networkPolicy)).toBe('accepted');
    for (const filesystemPolicy of ['inherit', 'workspace-write', 'read-only', 'isolated']) expect(verdict(executionIntent, 'filesystemPolicy', filesystemPolicy)).toBe('accepted');

    expect(verdict(executionIntent, 'riskClass', 'catastrophic')).toBe('refused');
    expect(verdict(executionIntent, 'networkPolicy', 'everything')).toBe('refused');
    expect(verdict(executionIntent, 'filesystemPolicy', 'read-write-all')).toBe('refused');
    expect(verdict(executionIntent, 'requiresApproval', true)).toBe('accepted');
    expect(verdict(executionIntent, 'requiresApproval', 'yes')).toBe('refused');
  });

  test('session input records carry correlation and causation ids as strings only', () => {
    for (const field of ['correlationId', 'causationId']) {
      expect(verdict(SHARED_SESSION_INPUT_RECORD_SCHEMA, field, 'abc')).toBe('accepted');
      expect(verdict(SHARED_SESSION_INPUT_RECORD_SCHEMA, field, 7)).toBe('refused');
    }
  });

  test('route bindings accept each declared delivery policy and refuse an undeclared one', () => {
    for (const sessionPolicy of ['create-or-bind', 'continue-existing', 'require-existing']) expect(verdict(ROUTE_BINDING_SCHEMA, 'sessionPolicy', sessionPolicy)).toBe('accepted');
    for (const threadPolicy of ['preserve', 'replace', 'detached']) expect(verdict(ROUTE_BINDING_SCHEMA, 'threadPolicy', threadPolicy)).toBe('accepted');
    for (const deliveryGuarantee of ['best-effort', 'at-least-once']) expect(verdict(ROUTE_BINDING_SCHEMA, 'deliveryGuarantee', deliveryGuarantee)).toBe('accepted');

    expect(verdict(ROUTE_BINDING_SCHEMA, 'sessionPolicy', 'always-new')).toBe('refused');
    expect(verdict(ROUTE_BINDING_SCHEMA, 'threadPolicy', 'merge')).toBe('refused');
    expect(verdict(ROUTE_BINDING_SCHEMA, 'deliveryGuarantee', 'exactly-once')).toBe('refused');
  });

  test('automation runs need an execution intent naming its mode and target, and refuse a bare string', () => {
    expect(verdict(AUTOMATION_RUN_SCHEMA, 'executionIntent', { mode: 'spawn', targetKind: 'isolated' })).toBe('accepted');
    expect(verdict(AUTOMATION_RUN_SCHEMA, 'executionIntent', { mode: 'spawn' })).toBe('refused');
    expect(verdict(AUTOMATION_RUN_SCHEMA, 'executionIntent', 'inline')).toBe('refused');
  });
});
