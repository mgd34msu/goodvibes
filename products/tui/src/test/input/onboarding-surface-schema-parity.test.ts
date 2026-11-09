// Proves the onboarding channel field set is sourced from the platform setup schema
// (getBuiltinSetupSchema), not a hand-authored duplicate. For every generated
// surface: each non-extra field maps to a real platform field of the matching kind,
// and every platform field (bar the enabled toggle) is present. Two documented
// TUI-only extras the platform schema omits are allowed.
import { describe, expect, test } from 'bun:test';
import { getBuiltinSetupSchema } from '@goodvibes-jev/engine/platform/platform/channels';
import type { ChannelSetupFieldKind, ChannelSurface } from '@goodvibes-jev/engine/platform/platform/channels';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import { EXTERNAL_SURFACE_SPECS } from '../../input/onboarding/onboarding-wizard-external-surfaces.ts';

/** configKeys the onboarding exposes that the platform setup schema intentionally omits. */
const TUI_ONLY_EXTRA_CONFIG_KEYS = new Set<ConfigKey>(['surfaces.ntfy.defaultPriority', 'surfaces.webhook.timeoutMs']);

function engineSurfaceOf(enabledFieldId: string): ChannelSurface {
  return enabledFieldId.replace(/^external-services\./, '') as ChannelSurface;
}

function expectedOnboardingKind(engineKind: ChannelSetupFieldKind): 'text' | 'masked' | 'radio' {
  if (engineKind === 'secret') return 'masked';
  if (engineKind === 'select') return 'radio';
  return 'text';
}

describe('onboarding surface specs are derived from the platform setup schema', () => {
  for (const surface of EXTERNAL_SURFACE_SPECS) {
    const engineSurface = engineSurfaceOf(surface.enabledFieldId);
    const schema = getBuiltinSetupSchema(engineSurface);
    const engineByKey = new Map(schema.fields.filter((f) => f.configKey).map((f) => [f.configKey!, f]));

    test(`${surface.id}: every non-extra field maps to a real platform field of the matching kind`, () => {
      for (const field of surface.fields) {
        if (TUI_ONLY_EXTRA_CONFIG_KEYS.has(field.configKey)) continue;
        const engineField = engineByKey.get(field.configKey);
        expect(engineField, `${field.configKey} must exist in the platform schema`).toBeDefined();
        expect(field.kind).toBe(expectedOnboardingKind(engineField!.kind));
      }
    });

    test(`${surface.id}: every platform setup field (bar the enabled toggle) is present in onboarding`, () => {
      const onboardingKeys = new Set(surface.fields.map((f) => f.configKey));
      for (const engineField of schema.fields) {
        if (!engineField.configKey) continue;
        if (engineField.kind === 'boolean' || engineField.configKey.endsWith('.enabled')) continue;
        // engineField.configKey is the platform's plain `string`; onboardingKeys is
        // keyed by the TUI's narrower ConfigKey, this test's whole point is
        // checking that every platform key IS a real onboarding ConfigKey.
        expect(onboardingKeys.has(engineField.configKey as ConfigKey), `${engineField.configKey} missing from onboarding`).toBe(true);
      }
    });
  }

  test('the only TUI-only extras are the two documented numeric fields', () => {
    const extras = EXTERNAL_SURFACE_SPECS.flatMap((s) => {
      const engineKeys = new Set(getBuiltinSetupSchema(engineSurfaceOf(s.enabledFieldId)).fields.map((f) => f.configKey));
      return s.fields.filter((f) => !engineKeys.has(f.configKey)).map((f) => f.configKey);
    });
    expect(new Set(extras)).toEqual(TUI_ONLY_EXTRA_CONFIG_KEYS);
  });
});
