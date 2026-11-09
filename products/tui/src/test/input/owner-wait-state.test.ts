import { expect, test } from 'bun:test';
import { InfiniteBuffer, SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InputHandler } from '../../input/handler.ts';
import { ChangesModal } from '../../input/changes-modal.ts';
import { confirmThrough } from '../../input/confirm-dialog.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

async function handler() {
  const history = new InfiniteBuffer();
  return new InputHandler(() => {}, new SelectionManager(), () => 0, () => 20, () => history,
    () => {}, () => {}, (await createDefaultUiRuntimeServices()));
}

test('native owner wait distinguishes real confirmations from settings and picker navigation', async () => {
  const input = (await handler());
  expect(input.waitingForOwner).toBe(false);
  input.settingsModal.active = true;
  expect(input.waitingForOwner).toBe(false);
  for (const name of ['mcpAllowAllConfirmationTarget', 'subscriptionLogoutConfirmationTarget'] as const) {
    input.settingsModal[name] = 'synthetic-target';
    expect(input.waitingForOwner).toBe(true);
    input.settingsModal[name] = null;
  }
  input.settingsModal.resetCategoryConfirm = { subject: 'display' };
  expect(input.waitingForOwner).toBe(true);
  input.settingsModal.resetCategoryConfirm = null;
  input.settingsModal.resetAllConfirm = { subject: 'all' };
  expect(input.waitingForOwner).toBe(true);
  input.settingsModal.resetAllConfirm = null;
  input.settingsModal.active = false;
  for (const modal of [input.sessionPickerModal, input.profilePickerModal]) {
    modal.active = true;
    expect(input.waitingForOwner).toBe(false);
    modal.deleteConfirmationTarget = 'synthetic-target';
    expect(input.waitingForOwner).toBe(true);
    modal.active = false;
    expect(input.waitingForOwner).toBe(false);
    modal.deleteConfirmationTarget = null;
  }
  input.configModal.open({ name: 'synthetic', title: 'Fixture',
    buildView: () => ({ title: 'Fixture', tabs: [{ id: 'tab', label: 'Tab', rows: [] }] }),
    actions: [{ id: 'delete', key: 'd', label: 'delete', confirm: true }], onAction: () => {} });
  expect(input.waitingForOwner).toBe(false);
  input.configModal.fireAction('d', { print: () => {} });
  expect(input.waitingForOwner).toBe(true);
  input.configModal.cancelPendingConfirm();
  expect(input.waitingForOwner).toBe(false);
});

test('surface confirmation and preview questions remain explicit until answered or closed', async () => {
  const input = (await handler());
  const confirmation = confirmThrough(input.surfaceModals, { title: 'Synthetic question', body: 'Fixture', confirmLabel: 'Continue' });
  expect(input.waitingForOwner).toBe(true);
  input.surfaceModals.escape();
  expect(await confirmation).toBe(false);
  expect(input.waitingForOwner).toBe(false);
  const changes = new ChangesModal({ workingDirectory: '/synthetic', getSessionFiles: () => [], requestRender: () => {} }, 'preview');
  input.surfaceModals.push(changes);
  expect(input.waitingForOwner).toBe(false);
  const question = changes.ask({ text: 'Synthetic question', confirmLabel: 'Apply' });
  expect(input.waitingForOwner).toBe(true);
  input.surfaceModals.escape();
  expect(await question).toBe(false);
  expect(input.waitingForOwner).toBe(false);
});
