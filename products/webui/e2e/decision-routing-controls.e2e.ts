/** Real config dispatcher/disk behind browser interception; catalog and model answers remain synthetic. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DEFAULT_DECISION_ROUTER_SETTINGS } from '@goodvibes-jev/engine/sdk/browser/decision-router';
import { expectNoHorizontalScroll, openSettings } from './support/app';
import { installTerminalThemeDaemon } from './support/terminal-theme-fixture';

async function choose(page: Page, control: Locator, label: string): Promise<void> {
  await control.click(); await page.getByRole('option', { name: label, exact: true }).click();
}
async function scalar(field: Locator, name: string, value: string): Promise<void> {
  const input = field.getByRole('textbox', { name, exact: true });
  await input.fill(value); await input.press('Tab');
}

/** Enter through the same visible Settings page list the user uses. */
async function settingsPage(page: Page, label: 'Models and providers' | 'Permissions'): Promise<Locator> {
  const dialog = await openSettings(page, 'general');
  await dialog.getByRole('navigation', { name: 'Settings sections', exact: true })
    .getByRole('button', { name: label, exact: true }).click();
  return dialog;
}
async function cleanupConfig(page: Page, host: { cleanup(): void }): Promise<void> {
  try { if (!page.isClosed()) await page.unroute('**/config'); } finally { host.cleanup(); }
}

// Deliberately synthetic discovery. These levels prove the controls retain an
// advertised choice, not that a real answering provider accepted an effort.
const catalog = { providers: [{ id: 'synthetic-answer', name: 'Synthetic answer', models: [
  { id: 'careful-fixture', registryKey: 'synthetic-answer:careful-fixture', displayName: 'Careful fixture', selectable: true,
    reasoningOptions: { levels: ['high', 'xhigh', 'max'], source: 'explicit synthetic fixture' } },
  { id: 'fast-fixture', registryKey: 'synthetic-answer:fast-fixture', displayName: 'Fast fixture', selectable: true,
    reasoningOptions: { levels: ['high', 'xhigh', 'max'], source: 'explicit synthetic fixture' } },
] }], secretsResolutionSkipped: false };

test('every decision policy saves independently of safe, YOLO and planning execution modes', async ({ page }) => {
  const { host } = await installTerminalThemeDaemon(page);
  try {
    for (const selected of ['Preferred', 'Classic - Off', 'Default - On'] as const) {
      let dialog = await settingsPage(page, 'Models and providers');
      await choose(page, dialog.getByRole('combobox', { name: 'judgment.policy', exact: true }), selected);
      await expect.poll(() => host.manager.get('judgment.policy')).toBe(selected);
      dialog = await settingsPage(page, 'Permissions');
      const execution = dialog.getByRole('combobox', { name: 'permissions.mode', exact: true });
      for (const mode of ['yolo', 'plan', 'safe-jev', 'safe-owner'] as const) {
        await choose(page, execution, mode);
        await expect.poll(() => host.manager.get('permissions.mode')).toBe(mode);
        expect(host.manager.get('judgment.policy')).toBe(selected);
      }
    }
    host.reload();
    let dialog = await settingsPage(page, 'Models and providers');
    await expect(dialog.getByRole('combobox', { name: 'judgment.policy', exact: true })).toContainText('Default - On');
    dialog = await settingsPage(page, 'Permissions');
    await expect(dialog.getByRole('combobox', { name: 'permissions.mode', exact: true })).toContainText('safe-owner');
    expect(host.requests.filter(request => request.method === 'POST').every(request => request.status === 200)).toBe(true);
    await expectNoHorizontalScroll(page);
  } finally { await cleanupConfig(page, host); }
});

test('router category/provider/model/effort and bounded context controls persist without selecting an answer model', async ({ page }) => {
  const daemon = await installTerminalThemeDaemon(page), { host } = daemon;
  await page.route('**/api/models', route => route.fulfill({ json: catalog }));
  try {
    const originalModel = host.manager.get('provider.model');
    let dialog = await settingsPage(page, 'Models and providers');
    let field = dialog.locator('[data-config-key="provider.decisionRouter"]');
    await expect(field.locator('fieldset')).toHaveCount(10);
    await expect(field).toContainText('Empty categories use General');
    for (const category of Object.values(DEFAULT_DECISION_ROUTER_SETTINGS.categories)) {
      await expect(field.getByRole('textbox', { name: `${category.label} description`, exact: true })).toHaveValue(category.description);
    }
    await choose(page, field.getByRole('combobox', { name: 'General provider', exact: true }), 'Synthetic answer');
    await field.getByLabel('General model', { exact: true }).fill('careful-fixture');
    await choose(page, field.getByRole('combobox', { name: 'General effort', exact: true }), 'xhigh');
    await choose(page, field.getByRole('combobox', { name: 'Coding / implementation provider', exact: true }), 'Synthetic answer');
    await field.getByLabel('Coding / implementation model', { exact: true }).fill('fast-fixture');
    await choose(page, field.getByRole('combobox', { name: 'Coding / implementation effort', exact: true }), 'max');
    await field.getByRole('textbox', { name: 'Custom category id', exact: true }).fill('release-notes');
    await field.getByRole('button', { name: 'Add category', exact: true }).click();
    await field.getByRole('textbox', { name: 'release-notes description', exact: true }).fill('Draft user-facing release notes.');
    await field.getByRole('spinbutton', { name: 'Initial routing context (characters)', exact: true }).fill('512');
    await field.getByRole('spinbutton', { name: 'Expanded routing context (characters)', exact: true }).fill('1024');
    await field.getByRole('button', { name: 'Save routing', exact: true }).click();
    await expect.poll(() => host.manager.get('provider.decisionRouter').initialContextChars).toBe(512);
    expect(host.manager.get('provider.decisionRouter')).toMatchObject({ expandedContextChars: 1024, categories: {
      general: { target: { provider: 'synthetic-answer', model: 'careful-fixture', effort: 'xhigh' } },
      'coding-implementation': { target: { provider: 'synthetic-answer', model: 'fast-fixture', effort: 'max' } },
      research: { target: null }, 'release-notes': { description: 'Draft user-facing release notes.', target: null },
    } });
    expect(host.manager.get('provider.model')).toBe(originalModel);
    expect(daemon.requests.filter(request => request.method === 'PATCH' && request.path === '/api/models/current')).toEqual([]);
    host.reload(); dialog = await openSettings(page, 'models'); field = dialog.locator('[data-config-key="provider.decisionRouter"]');
    await expect(field.locator('fieldset')).toHaveCount(11);
    await expect(field.getByRole('combobox', { name: 'General effort', exact: true })).toContainText('xhigh');
    await expect(field.getByRole('combobox', { name: 'Coding / implementation effort', exact: true })).toContainText('max');
    await expect(field.getByRole('combobox', { name: 'release-notes provider', exact: true })).toContainText('Use General');
    await expect(field.getByRole('spinbutton', { name: 'Expanded routing context (characters)', exact: true })).toHaveValue('1024');
    await expectNoHorizontalScroll(page);
  } finally { await cleanupConfig(page, host); }
});

test('call-volume controls refuse enabled empty budgets and persist explicit enable and disable', async ({ page }) => {
  const { host } = await installTerminalThemeDaemon(page);
  try {
    let dialog = await openSettings(page, 'models');
    let field = dialog.locator('[data-config-key="judgment.volumeMonitor"]');
    let editor = field.getByRole('textbox', { name: 'judgment.volumeMonitor', exact: true });
    await expect(editor).toBeVisible(); expect(host.manager.get('judgment.volumeMonitor').enabled).toBe(false);
    await editor.fill(JSON.stringify({ enabled: true, budgets: [] }));
    await field.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(field.getByRole('alert')).toBeVisible();
    expect(host.manager.get('judgment.volumeMonitor').enabled).toBe(false);
    const enabled = { enabled: true, budgets: [{ name: 'All decisions', maxLogicalDecisions: 100, maxWireAttempts: 200 }],
      intervalMs: 2000, windowMs: 60_000, limit: 25 };
    await editor.fill(JSON.stringify(enabled));
    await field.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => host.manager.get('judgment.volumeMonitor')).toEqual(enabled);
    host.reload(); dialog = await openSettings(page, 'models'); field = dialog.locator('[data-config-key="judgment.volumeMonitor"]');
    editor = field.getByRole('textbox', { name: 'judgment.volumeMonitor', exact: true });
    await expect.poll(async () => JSON.parse(await editor.inputValue()) as unknown).toEqual(enabled);
    await editor.fill(JSON.stringify({ ...enabled, enabled: false }));
    await field.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => host.manager.get('judgment.volumeMonitor').enabled).toBe(false);
    host.reload(); expect(host.manager.get('judgment.volumeMonitor')).toEqual({ ...enabled, enabled: false });
    await expectNoHorizontalScroll(page);
  } finally { await cleanupConfig(page, host); }
});

test('all primary decision protocols and endpoint credential references remain explicit and separate from chat selection', async ({ page }) => {
  const { host } = await installTerminalThemeDaemon(page);
  try {
    const originalModel = host.manager.get('provider.model');
    host.manager.set('judgment.keySource', 'env');
    let dialog = await openSettings(page, 'models');
    for (const [adapter, label] of [
      ['cloudflare-workers-ai', 'Cloudflare Workers AI — Clef / Clef-flash'],
      ['system-one', 'System One — Jev, DiffusionGemma Jev, Kev-9B'], ['laya', 'Laya'],
    ] as const) {
      await choose(page, dialog.getByRole('combobox', { name: 'Decision provider', exact: true }), label);
      await expect.poll(() => host.manager.get('judgment.backend').adapter).toBe(adapter);
      expect(host.manager.get('judgment.keySource')).toBe('none');
      await choose(page, dialog.getByRole('combobox', { name: 'judgment.keySource', exact: true }), 'env');
      await expect.poll(() => host.manager.get('judgment.keySource')).toBe('env');
    }
    await scalar(dialog.locator('[data-config-key="judgment.endpoint"]'), 'judgment.endpoint', 'http://127.0.0.1:4321');
    await expect.poll(() => host.manager.get('judgment.endpoint')).toBe('http://127.0.0.1:4321');
    expect(host.manager.get('judgment.keySource')).toBe('none');
    await scalar(dialog.locator('[data-config-key="judgment.keyName"]'), 'judgment.keyName', 'SYNTHETIC_DECISION_KEY');
    await expect.poll(() => host.manager.get('judgment.keyName')).toBe('SYNTHETIC_DECISION_KEY');
    await choose(page, dialog.getByRole('combobox', { name: 'judgment.keySource', exact: true }), 'env');
    await expect.poll(() => host.manager.get('judgment.keySource')).toBe('env');
    expect(host.manager.get('provider.model')).toBe(originalModel);
    host.reload(); dialog = await openSettings(page, 'models');
    await expect(dialog.getByRole('textbox', { name: 'judgment.endpoint', exact: true })).toHaveValue('http://127.0.0.1:4321');
    await expect(dialog.getByRole('textbox', { name: 'judgment.keyName', exact: true })).toHaveValue('SYNTHETIC_DECISION_KEY');
    await expect(dialog.getByRole('combobox', { name: 'judgment.keySource', exact: true })).toContainText('env');
    await expectNoHorizontalScroll(page);
  } finally { await cleanupConfig(page, host); }
});
