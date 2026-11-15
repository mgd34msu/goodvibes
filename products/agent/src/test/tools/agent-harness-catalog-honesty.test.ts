import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { EFFECT_ADMISSION_SENTENCE } from '../../tools/agent-harness-effect-admission.ts';
import { HARNESS_MODE_DESCRIPTORS } from '../../tools/agent-harness-mode-catalog.ts';
import { describeCommandPolicy, settingsPolicySummary } from '../../tools/agent-harness-metadata.ts';
import { describeHarnessNotificationTarget, listHarnessNotificationTargets } from '../../tools/agent-harness-notification-metadata.ts';
import { describeHarnessOperatorMethod, operatorMethodCatalogStatus, operatorMethodParameters } from '../../tools/agent-harness-operator-methods.ts';
import { createAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';

describe('settings policy summary', () => {
  test('names no key list for the model to treat as the confirmation rule', () => {
    // Nothing enforces a key list: a write is decided by the recorded admission for its exact effect.
    expect(Object.keys(settingsPolicySummary())).not.toContain('confirmationRequiredConfigKeys');
    expect(JSON.stringify(settingsPolicySummary())).not.toContain('controlPlane.');
  });
});

describe('command policies a model reads', () => {
  test('/qrcode is not a read-only display and says a model invocation is refused', () => {
    const policy = describeCommandPolicy('qrcode');
    expect(policy.effect).not.toBe('read-only');
    expect(policy.boundary).toContain('refused');
  });

  test('/calendar carries the outward-effect floor, not the local one, and names the owner-terminal verbs', () => {
    const policy = describeCommandPolicy('cal');
    expect(policy.effect).toBe('mixed');
    expect(policy.boundary).toContain('subscribe');
    expect(policy.boundary).toContain('connect');
  });
});

describe('operator method catalog', () => {
  const inert = {} as never;
  const catalogMethod = async (methodId: string) => {
    const result = await describeHarnessOperatorMethod({ methodId });
    if (result.status !== 'found') throw new Error(`expected ${methodId} to be found`);
    return result.method as { effect: string; confirmation: string; preferredModelTool: string; parameters?: unknown[]; parametersNote?: string };
  };

  test('a write method is described with the same effect name and admission rule the tool uses', async () => {
    const tool = createAgentOperatorMethodTool(inert, inert);
    const confirm = (tool.definition.parameters as { properties: { confirm: { description: string } } }).properties.confirm.description;
    expect(confirm).toContain('does not grant effect authority');
    const method = await catalogMethod('ci.watches.create');
    expect(method.effect).toBe('admitted-connected-host-state');
    expect(method.confirmation).toContain(EFFECT_ADMISSION_SENTENCE);
    expect(method.confirmation).not.toMatch(/requires confirm/i);
    expect(method.preferredModelTool).not.toContain('confirm:true');
  });

  test('an admin-access write method is named as an admin route, apart from an ordinary mutation', async () => {
    const method = await catalogMethod('approvals.approve');
    expect(method.effect).toBe('admitted-admin-connected-host-state');
    expect(method.confirmation).toContain('Admin route.');
    expect(method.confirmation).toContain(EFFECT_ADMISSION_SENTENCE);
  });

  test('a screenshot is read-only by default and the catalog names the destination-path exception', async () => {
    const method = await catalogMethod('browser.screenshot');
    expect(method.effect).toBe('read-only-network');
    expect(method.confirmation).toContain('destination path');
  });

  test('the catalog status counts and policy use the admission wording', () => {
    const status = operatorMethodCatalogStatus() as { policy: string; confirmedMethods: number };
    expect(status.policy).toContain(EFFECT_ADMISSION_SENTENCE);
    expect(status.confirmedMethods).toBeGreaterThan(0);
  });

  test('a schema outside the snapshot limits gives a note for that method only', async () => {
    const circular: Record<string, unknown> = { type: 'object', properties: {} };
    circular.self = circular;
    const odd = operatorMethodParameters({ id: 'odd.method', available: true, inputSchema: circular });
    expect(odd.parameters).toEqual([]);
    expect(odd.parametersNote).toContain('outside the size limits');
    const fine = operatorMethodParameters({ id: 'fine.method', available: true, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } });
    expect(fine.parameters).toEqual([{ name: 'id', required: true, type: 'string', enum: undefined }]);
    expect(operatorMethodParameters({ id: 'gone.method', available: false, inputSchema: circular }).parameters).toEqual([]);
    // Listing every method no longer reads any schema, so the catalog is not at the mercy of one.
    expect(((await catalogMethod('approvals.approve')).parameters ?? []).length).toBeGreaterThan(0);
  });
});

describe('notification target search', () => {
  const context = (urls: readonly string[]) => ({ platform: { configManager: { getCategory: () => ({ webhookUrls: urls }) } } }) as unknown as CommandContext;
  const urls = ['https://hooks.example.test/a', 'not a url'];

  test('"valid" selects only the valid target and "invalid" only the broken one', () => {
    const valid = listHarnessNotificationTargets(context(urls), { query: 'valid' }) as { returned: number; targets: { id: string }[] };
    expect(valid.targets.map((target) => target.id)).toEqual(['notification-target-1']);
    const invalid = listHarnessNotificationTargets(context(urls), { query: 'invalid' }) as { targets: { id: string }[] };
    expect(invalid.targets.map((target) => target.id)).toEqual(['notification-target-2']);
  });

  test('a lone broken target is not found for the query "valid"', () => {
    expect(describeHarnessNotificationTarget(context(['not a url']), { query: 'valid' }).status).toBe('missing_lookup');
  });
});

describe('keybinding mode parameters', () => {
  const byId = (id: string) => HARNESS_MODE_DESCRIPTORS.find((mode) => mode.id === id)!;

  test('run and set name the value argument their handlers read', () => {
    expect(byId('run_keybinding').parameters).toContain('value');
    expect(byId('set_keybinding').parameters).toEqual(expect.arrayContaining(['value', 'fields', 'key', 'target', 'query']));
    expect(byId('reset_keybinding').parameters).toEqual(expect.arrayContaining(['key', 'target', 'query']));
  });
});
