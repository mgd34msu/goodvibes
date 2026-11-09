/** UNRUN: operator routing and keyboard ownership over actual native managers. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { registerTriggerSupervisorGatewayMethods } from '../platform/src/platform/control-plane/routes/trigger-supervisor.js';
import { TriggerManager, triggerOperatorStatus, type TriggerRecord } from '../platform/src/platform/triggers/index.js';
import { createTerminalCommandRegistry } from '../terminal-shell/src/command-registry.js';
import { registerTriggerSupervisorCommand } from '../terminal-shell/src/trigger-supervisor-command.js';
import type { OpenSelection } from '../terminal-shell/src/selection-modal.js';

const roots: string[] = [], managers: TriggerManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) { manager.shutdown(); await manager.join(); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const definition = { id: 'condition-one', label: 'Build readiness', createdAt: 1000,
  spec: { kind: 'condition', probe: { kind: 'file', path: '/private/probe-not-for-wire' }, extract: { kind: 'raw' }, rule: { kind: 'change' } }, action: { kind: 'agent-turn', prompt: 'private-action-not-for-wire' } } as const;
const record: TriggerRecord = { definition, state: 'idle', observations: [], runs: [], ruleState: {}, strikes: 0, backoffRung: 0, firedCount: 0, droppedLines: 0, updatedAt: 1000 };
function fixture() {
  const root = makeProjectTempDir('trigger-operator'); roots.push(root);
  const path = join(root, 'triggers-v2.json'), old = join(root, 'triggers.json');
  const body = { version: 1, daemonBootId: 'actual-older-boot', savedAt: 1000, triggers: [record], grants: [], eventLog: [] };
  // Reproduce only the real saved v1 representation. Fresh v2 writes have no hash.
  const bytes = JSON.stringify({ ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') }); writeFileSync(old, bytes);
  let actions = 0;
  const manager = new TriggerManager({ storePath: path, previousStorePath: old, config: { enabled: true }, now: () => 1000,
    actions: { async runAgentTurn() { actions++; return ''; }, async runGrant() { actions++; return ''; } } });
  managers.push(manager); return { root, path, old, bytes, manager, actions: () => actions };
}
const principal = { principalId: 'pairing:operator', principalKind: 'token', admin: true, scopes: ['read:watchers', 'write:watchers'] } as const;
function catalog(manager: TriggerManager) { const value = new GatewayMethodCatalog(); registerTriggerSupervisorGatewayMethods(value, manager); return value; }

test('operator status never claims an unstarted manager or publishes recovery state', () => {
  const f = fixture(), before = readFileSync(f.old, 'utf8'), view = triggerOperatorStatus(f.manager);
  expect(view.ownership).toBe('unclaimed'); expect(view.records).toEqual([{ id: 'condition-one', label: 'Build readiness', kind: 'condition', state: 'idle' }]);
  expect(JSON.stringify(view)).not.toContain('private-'); expect(f.manager.executionOwnership).toBe('unclaimed'); expect(existsSync(f.path)).toBe(false); expect(readFileSync(f.old, 'utf8')).toBe(before); expect(f.actions()).toBe(0);
});

test('real catalog migration requires an authorized explicit statement and reaches the same original supervisor', async () => {
  const f = fixture(); f.manager.start(); const api = catalog(f.manager);
  const status = await api.invoke('watchers.triggers.status', { context: principal }); expect(status).toMatchObject({ ownership: 'migration-required', migrationRequired: true });
  for (const body of [{}, { confirm: true }, { olderInstancesClosed: true }]) await expect(api.invoke('watchers.triggers.migrate', { context: principal, body })).rejects.toMatchObject({ status: 400 });
  await expect(api.invoke('watchers.triggers.migrate', { context: { ...principal, admin: false }, body: { confirm: true, olderInstancesClosed: true } })).rejects.toMatchObject({ status: 403 });
  await expect(api.invoke('watchers.triggers.migrate', { context: { ...principal, scopes: ['read:watchers'] }, body: { confirm: true, olderInstancesClosed: true } })).rejects.toMatchObject({ status: 403 });
  await expect(api.invoke('watchers.triggers.migrate', { context: { ...principal, metadata: { explicitUserRequest: false } }, body: { confirm: true, olderInstancesClosed: true } })).rejects.toMatchObject({ status: 403 });
  expect(existsSync(f.path)).toBe(false);
  const result = await api.invoke('watchers.triggers.migrate', { context: principal, body: { confirm: true, olderInstancesClosed: true }, isAuthorized: () => true });
  expect(result).toMatchObject({ migrated: true, status: { ownership: 'local', migrationRequired: false } });
  expect(f.manager.executionOwnership).toBe('local'); expect(existsSync(f.path)).toBe(true); expect(readFileSync(f.old, 'utf8')).toBe(f.bytes); expect(f.actions()).toBe(0);
});

test('read-only second owner status is actionable and cannot promote another process into execution', async () => {
  const f = fixture(); f.manager.start(); f.manager.migratePrevious({ olderInstancesClosed: true });
  const second = new TriggerManager({ storePath: f.path, previousStorePath: f.old, config: { enabled: true }, now: () => 1000,
    actions: { async runAgentTurn() { throw new Error('No second-owner execution'); }, async runGrant() { throw new Error('No second-owner execution'); } } }); managers.push(second); second.start();
  const before = readFileSync(f.path, 'utf8'), api = catalog(second);
  expect(await api.invoke('watchers.triggers.status', { context: principal })).toMatchObject({ ownership: 'other-process', migrationRequired: false });
  await expect(api.invoke('watchers.triggers.migrate', { context: principal, body: { confirm: true, olderInstancesClosed: true } })).rejects.toMatchObject({ code: 'TRIGGER_OTHER_PROCESS', status: 409 });
  expect(second.executionOwnership).toBe('other-process'); expect(readFileSync(f.path, 'utf8')).toBe(before);
});

test('actual unsupported or changed saved sources return typed operator recovery errors without repair/reset', async () => {
  const f = fixture(); f.manager.start(); const bytes = '{"version":99,"future":"preserve"}'; writeFileSync(f.old, bytes);
  const api = catalog(f.manager); await expect(api.invoke('watchers.triggers.status', { context: principal })).rejects.toMatchObject({ code: 'TRIGGER_FUTURE_VERSION', status: 409 });
  await expect(api.invoke('watchers.triggers.migrate', { context: principal, body: { confirm: true, olderInstancesClosed: true } })).rejects.toMatchObject({ code: 'TRIGGER_FUTURE_VERSION', status: 409 });
  expect(readFileSync(f.old, 'utf8')).toBe(bytes); expect(existsSync(f.path)).toBe(false);
});

interface Context { ops: { triggerSupervisor: TriggerManager }; print(message: string): void; renderRequest(): void; openSelection?: OpenSelection; invokedByModel?: boolean }
function terminal(manager: TriggerManager) {
  const factory = createTerminalCommandRegistry<Context>(), registry = new factory.CommandRegistry(), messages: string[] = [];
  const context: Context = { ops: { triggerSupervisor: manager }, print: message => messages.push(message), renderRequest() {} };
  registerTriggerSupervisorCommand(registry, { isOwner: ctx => factory.isDirectOwnerCommandContext(ctx, 'triggers') });
  return { registry, context, messages };
}
test('model/nested dispatch cannot acknowledge older instances, while actual typed owner statement can', async () => {
  const f = fixture(); f.manager.start(); const ui = terminal(f.manager);
  await ui.registry.execute('triggers', ['migrate', '--older-instances-closed'], ui.context);
  expect(f.manager.executionOwnership).toBe('migration-required'); expect(existsSync(f.path)).toBe(false);
  expect(ui.messages.join('\n')).toContain('directly in the owner terminal');
  await ui.registry.executeFromOwner('triggers', ['migrate', '--older-instances-closed'], ui.context, '/triggers migrate --older-instances-closed');
  expect(f.manager.executionOwnership).toBe('local'); expect(ui.messages.join('\n')).toContain('Migration completed');
});

test('owner picker defaults to stopped, Escape has no effect, and a changed supervisor cannot borrow its acknowledgement', async () => {
  const f = fixture(); f.manager.start(); const ui = terminal(f.manager); let choose: Parameters<OpenSelection>[3] | undefined;
  ui.context.openSelection = (_title, items, _options, callback) => { expect(items[0]?.id).toBe('keep'); choose = callback; };
  await ui.registry.executeFromOwner('triggers', ['migrate'], ui.context); expect(choose).toBeDefined(); const cancelled = choose!; cancelled(null);
  cancelled({ action: 'select', item: { id: 'migrate', label: 'stale acknowledgement' } });
  expect(existsSync(f.path)).toBe(false);
  await ui.registry.executeFromOwner('triggers', ['migrate'], ui.context); const other = fixture(); other.manager.start(); ui.context.ops.triggerSupervisor = other.manager;
  choose!({ action: 'select', item: { id: 'migrate', label: 'acknowledged' } });
  expect(existsSync(f.path)).toBe(false); expect(existsSync(other.path)).toBe(false);
});

test('delayed modal selection retains the original keyboard admission after shared dispatch returns', async () => {
  const f = fixture(); f.manager.start(); const ui = terminal(f.manager); let choose: Parameters<OpenSelection>[3] | undefined;
  ui.context.openSelection = (_title, _items, _options, callback) => { choose = callback; };
  await ui.registry.executeFromOwner('triggers', ['migrate'], ui.context);
  expect(existsSync(f.path)).toBe(false); expect(choose).toBeDefined();
  // The registry has already removed its transient dispatch mark. The actual
  // still-open original modal carries the admitted owner gesture through here.
  choose!({ action: 'select', item: { id: 'migrate', label: 'I closed older instances' } });
  expect(f.manager.executionOwnership).toBe('local'); expect(ui.messages.join('\n')).toContain('Migration completed');
});
