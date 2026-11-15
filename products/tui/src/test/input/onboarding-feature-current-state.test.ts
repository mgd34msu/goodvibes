import { describe, expect, test } from 'bun:test';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { configGetStub } from '../helpers/config-manager-stub.ts';
import { featureEnablementWrite, isFeatureConfigEnabled } from '@goodvibes-jev/engine/terminal-shell';
import {
  applyFeatureUnitOperations,
  buildFeatureUnitSteps,
  featureEnableFieldId,
  getFeatureOnboardingFlagIds,
  isFeatureDefaultOn,
  recordFeatureEnablement,
} from '../../input/onboarding/onboarding-feature-units.ts';
import type { OnboardingWizardControllerLike } from '../../input/onboarding/onboarding-wizard-types.ts';

// A feature that is off in a stock configuration and can be switched on by one settings write,
// so "enabled in /settings" differs from the platform default.
function pickFlag(): string {
  for (const flagId of getFeatureOnboardingFlagIds()) {
    if (isFeatureDefaultOn(flagId)) continue;
    const write = featureEnablementWrite(flagId, true);
    if (write && isFeatureConfigEnabled({ get: configGetStub({ [write.key]: write.value }) }, flagId)) return flagId;
  }
  throw new Error('no default-off feature can be enabled by one write');
}
const FLAG = pickFlag();

function controllerWith(toggles: Map<string, boolean>): OnboardingWizardControllerLike {
  return {
    getBooleanFieldValue: (id: string, fallback: boolean) => toggles.get(id) ?? fallback,
    getStringFieldValue: (_id: string, fallback: string) => fallback,
  } as unknown as OnboardingWizardControllerLike;
}

function configWithFlagOn(): { get: ConfigManager['get'] } {
  const write = featureEnablementWrite(FLAG, true);
  if (!write) throw new Error('fixture feature has no enablement write');
  return { get: configGetStub({ [write.key]: write.value }) };
}

function checkboxDefault(controller: OnboardingWizardControllerLike): unknown {
  for (const step of buildFeatureUnitSteps(controller)) {
    const field = step.fields.find((candidate) => candidate.id === featureEnableFieldId(FLAG));
    if (field && field.kind === 'checklist') return field.defaultValue;
  }
  throw new Error('feature checkbox not found');
}

describe('guided feature steps start from the live setting', () => {
  test('a feature enabled outside the wizard shows as checked', () => {
    expect(isFeatureDefaultOn(FLAG)).toBe(false);
    const controller = controllerWith(new Map());
    expect(checkboxDefault(controller)).toBe(false);

    recordFeatureEnablement(controller, configWithFlagOn());

    expect(checkboxDefault(controller)).toBe(true);
  });

  test('unchecking a feature that is currently on writes a disabling override', () => {
    const toggles = new Map<string, boolean>([[featureEnableFieldId(FLAG), false]]);
    const controller = controllerWith(toggles);
    recordFeatureEnablement(controller, configWithFlagOn());
    const overrides = new Map<string, 'enabled' | 'disabled'>();

    applyFeatureUnitOperations(controller, () => {}, overrides);

    expect(overrides.get(FLAG)).toBe('disabled');
  });

  test('leaving a currently-on feature checked writes nothing for it', () => {
    const controller = controllerWith(new Map([[featureEnableFieldId(FLAG), true]]));
    recordFeatureEnablement(controller, configWithFlagOn());
    const overrides = new Map<string, 'enabled' | 'disabled'>();

    applyFeatureUnitOperations(controller, () => {}, overrides);

    expect(overrides.has(FLAG)).toBe(false);
  });
});
