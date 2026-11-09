import { expect, test } from 'bun:test';
import { GATE_PRESETS } from '@goodvibes-jev/engine/platform/platform/gate';
import { describePermissionMode, describeConfiguredPermissions } from '../../permissions/configured-posture.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';

test('every mode displays the shared authoritative label and summary', () => {
  for (const preset of Object.values(GATE_PRESETS)) {
    expect(describePermissionMode(preset.mode)).toEqual({ label: preset.label, detail: preset.summary });
  }
});

test('legacy and unknown modes match the shared runtime normalization', () => {
  expect(describePermissionMode('allow-all')).toEqual(describePermissionMode('yolo'));
  expect(describePermissionMode('auto')).toEqual(describePermissionMode('safe-jev'));
  for (const mode of [undefined, false, 'unrecognized', 'prompt', 'custom', 'accept-edits']) {
    expect(describePermissionMode(mode)).toEqual(describePermissionMode('safe-owner'));
  }
});

test('configured posture reports the effective legacy auto-approve override', () => {
  const enabled = describeConfiguredPermissions({ get: configGetStub({ 'behavior.autoApprove': true, 'permissions.mode': 'safe-owner' }) });
  expect(enabled).toEqual(describePermissionMode('yolo'));
  const disabled = describeConfiguredPermissions({ get: configGetStub({ 'behavior.autoApprove': false, 'permissions.mode': 'safe-jev' }) });
  expect(disabled).toEqual(describePermissionMode('safe-jev'));
});
