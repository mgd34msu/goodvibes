/**
 * Onboarding wizard: adopting an existing daemon survives Apply, the adopt
 * fields are validated, secrets are not kept after an apply or written to the
 * saved progress, and the listener follows the inbound surfaces.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import { saveWizardProgressForHandler } from '../../input/handler-onboarding.ts';
import type { InputHandler } from '../../input/handler.ts';
import { getWizardProgressPath } from '../../runtime/onboarding/index.ts';
import { makeOnboardingSnapshot } from '../helpers/onboarding-snapshot.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function setConfigValues(wizard: OnboardingWizardController, key: string): unknown[] {
  return wizard.buildApplyRequest().operations
    .filter((operation) => operation.kind === 'set-config' && operation.key === key)
    .map((operation) => (operation as { value: unknown }).value);
}

describe('adopting an existing daemon', () => {
  function adoptingWizard(host: string, port: string): OnboardingWizardController {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('network.daemon-source', 'adopt');
    wizard.setFieldValue('network.adopt-daemon-host', host);
    wizard.setFieldValue('network.adopt-daemon-port', port);
    return wizard;
  }

  test('Apply keeps the adopted host, port and mode instead of this machine\'s own bind values', () => {
    const wizard = adoptingWizard('10.0.0.5', '4000');
    expect(setConfigValues(wizard, 'controlPlane.host')).toEqual(['10.0.0.5']);
    expect(setConfigValues(wizard, 'controlPlane.port')).toEqual([4000]);
    expect(setConfigValues(wizard, 'controlPlane.hostMode')).toEqual(['custom']);
  });

  test('Apply with no local servers chosen keeps the adopted remote daemon as the target', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.selectLocalTuiOnly();
    expect(wizard.hasServerCapabilitiesSelected()).toBe(false);
    wizard.setFieldValue('network.daemon-source', 'adopt');
    wizard.setFieldValue('network.adopt-daemon-host', '10.0.0.5');
    wizard.setFieldValue('network.adopt-daemon-port', '4000');
    expect(setConfigValues(wizard, 'controlPlane.host')).toEqual(['10.0.0.5']);
    expect(setConfigValues(wizard, 'controlPlane.port')).toEqual([4000]);
    expect(setConfigValues(wizard, 'controlPlane.hostMode')).toEqual(['custom']);
  });

  test('adopting a loopback daemon stays local', () => {
    const wizard = adoptingWizard('127.0.0.1', '4000');
    expect(setConfigValues(wizard, 'controlPlane.hostMode')).toEqual(['local']);
  });

  test('starting a new daemon still writes the wizard\'s own network values', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    expect(setConfigValues(wizard, 'controlPlane.host')).not.toEqual(['10.0.0.5']);
    expect(setConfigValues(wizard, 'controlPlane.port')).toEqual([3421]);
  });

  test('a port above 65535 or a URL as host blocks Apply with a message naming the field', () => {
    const wizard = adoptingWizard('http://h', '99999');
    const blockers = wizard.getBlockingFieldLabels();
    expect(blockers.some((label) => label.includes('Existing daemon port') && label.includes('1 to 65535'))).toBe(true);
    expect(blockers.some((label) => label.includes('Existing daemon host'))).toBe(true);

    const valid = adoptingWizard('10.0.0.5', '4000');
    expect(valid.getBlockingFieldLabels().filter((label) => label.includes('Existing daemon'))).toEqual([]);
  });
});

describe('cloudflare queue budget', () => {
  test('a value that is not a whole number of at least 1 blocks Apply', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.max-queue-ops-per-day', 'abc');
    expect(wizard.getBlockingFieldLabels().some((label) => label.includes('Max queue ops per day'))).toBe(true);
    wizard.setFieldValue('cloudflare.max-queue-ops-per-day', '0');
    expect(wizard.getBlockingFieldLabels().some((label) => label.includes('Max queue ops per day'))).toBe(true);
    wizard.setFieldValue('cloudflare.max-queue-ops-per-day', '2500');
    expect(wizard.getBlockingFieldLabels().some((label) => label.includes('Max queue ops per day'))).toBe(false);
  });

  test('a tunnel from an earlier setup is called out while the tunnel component is off, and not when it is on', () => {
    const base = makeOnboardingSnapshot();
    const snapshot = makeOnboardingSnapshot({
      config: { ...base.config, cloudflare: { ...base.config.cloudflare, enabled: false, tunnelId: 'tunnel-from-before' } },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.enabled', true);
    wizard.setFieldValue('cloudflare.component.zeroTrustTunnel', false);
    const lines = () => wizard.steps.find((step) => step.id === 'cloudflare')?.summaryLines ?? [];
    expect(lines().some((line) => line.includes('earlier setup'))).toBe(true);

    wizard.setFieldValue('cloudflare.component.zeroTrustTunnel', true);
    expect(lines().some((line) => line.includes('earlier setup'))).toBe(false);
  });
});

describe('telephony', () => {
  test('an auto-started telephony surface turns on the HTTP listener its inbound webhook needs', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.telephony', true);
    wizard.setFieldValue('external-services.telephony.auto-start', 'yes');
    expect(setConfigValues(wizard, 'danger.httpListener')).toEqual([true]);
  });
});

describe('secrets after an apply', () => {
  test('a typed admin password is not re-sent by a later apply or kept in the captured state', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot: makeOnboardingSnapshot() }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('accounts.admin-username', 'owner');
    wizard.setFieldValue('accounts.admin-password', 'correct horse battery');
    const before = wizard.buildApplyRequest().operations.find((operation) => operation.kind === 'ensure-auth-user');
    expect(before).toMatchObject({ kind: 'ensure-auth-user', password: 'correct horse battery' });

    wizard.markApplied();

    expect(wizard.getStringFieldValue('accounts.admin-password', '')).toBe('');
    const after = wizard.buildApplyRequest().operations.find((operation) => operation.kind === 'ensure-auth-user');
    expect(after === undefined || (after as { password: string }).password === '').toBe(true);
    expect(JSON.stringify([...wizard.textState.entries()])).not.toContain('correct horse battery');
  });
});

describe('OpenAI sign-in callback code', () => {
  let root: string;
  beforeEach(() => { root = makeProjectTempDir('gv-callback-code'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('is hidden and never written to the saved wizard progress', () => {
    const snapshot = makeOnboardingSnapshot({
      subscriptions: {
        active: [],
        pending: [{ provider: 'openai', state: 'state', verifier: 'verifier', redirectUri: 'http://127.0.0.1/callback', createdAt: 1 }],
        activeProviderIds: [],
        pendingProviderIds: ['openai'],
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    const field = wizard.steps.flatMap((step) => step.fields).find((candidate) => candidate.id === 'providers.openai-callback-code');
    expect(field?.kind).toBe('masked');

    const code = 'http://127.0.0.1/callback?code=single-use-code&state=state';
    wizard.setFieldValue('providers.openai-callback-code', code);
    const shellPaths = createShellPathService({ workingDirectory: join(root, 'workspace'), homeDirectory: join(root, 'home') });
    saveWizardProgressForHandler({ onboardingWizard: wizard, uiServices: { environment: { shellPaths } } } as unknown as InputHandler);

    const saved = readFileSync(getWizardProgressPath(shellPaths), 'utf-8');
    expect(saved).not.toContain('single-use-code');
  });
});
