import { isIP } from 'node:net';
import { isLoopbackHostValue } from './onboarding-verification-helpers.ts';
import { deriveOnboardingStepState, type OnboardingStep1CapabilityItem, type OnboardingStepDerivationState } from '../../runtime/onboarding/index.ts';
import { DEFAULT_CAPABILITIES } from './onboarding-wizard-constants.ts';
import { EXTERNAL_SURFACE_SPECS, type ExternalSurfaceSetupFieldSpec, type ExternalSurfaceSpec } from './onboarding-wizard-external-surfaces.ts';
import type { OnboardingWizardAcknowledgementFieldDefinition, OnboardingWizardModelSelection, OnboardingWizardRuntimeHydration } from './onboarding-wizard-types.ts';
export {
  buildGoodVibesSecretKey,
  buildGoodVibesSecretRef,
  isMalformedGoodVibesSecretReferenceValue,
  isSecretReferenceValue,
  normalizeSecretKeyPart,
} from '../../config/secret-config.ts';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function countSelected(items: readonly OnboardingStep1CapabilityItem[]): number {
  return items.filter((item) => item.selected).length;
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

export function isValidHostValue(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) return false;
  if (/\s/.test(normalized)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return false;
  if (normalized.includes('/')) return false;
  if (normalized.includes(':')) {
    const unwrapped = normalized.startsWith('[') && normalized.endsWith(']')
      ? normalized.slice(1, -1)
      : normalized;
    if (isIP(unwrapped) === 0) return false;
  }
  return true;
}

export function isLoopbackAddress(value: string): boolean {
  return isLoopbackHostValue(value);
}

/**
 * The `daemon.connectedHost.url` value for a daemon adopted at host:port.
 * `scheme` is the one the connection already uses: the host and port are what
 * the person edits, so re-applying setup never turns an `https` daemon into `http`.
 */
export function adoptedDaemonUrl(host: string, port: number, scheme: 'http' | 'https' = 'http'): string {
  const bare = host.trim().replace(/^\[(.*)\]$/, '$1');
  return `${scheme}://${bare.includes(':') ? `[${bare}]` : bare}:${port}`;
}

export function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter((value) => value.length > 0))];
}

export function makeNotNeededAcknowledgement(detail: string): OnboardingWizardAcknowledgementFieldDefinition {
  return {
    kind: 'acknowledgement',
    id: 'ack.placeholder',
    label: 'Acknowledgement not required',
    hint: detail,
    defaultValue: false,
    required: false,
    reason: 'not-needed',
  };
}

export function buildDefaultDerivedState(): OnboardingStepDerivationState {
  return {
    step1Capabilities: DEFAULT_CAPABILITIES,
    step1_5NetworkMode: 'local-network-default',
    reopenEditAcknowledgements: {
      providers: {
        required: false,
        accepted: false,
        reason: 'not-needed',
        detail: 'No existing provider routing needs confirmation.',
      },
      subscriptions: {
        required: false,
        accepted: false,
        reason: 'not-needed',
        detail: 'No stored subscription sessions need confirmation.',
      },
      auth: {
        required: false,
        accepted: false,
        reason: 'not-needed',
        detail: 'No local auth state needs confirmation.',
      },
    },
  };
}

/** A secret shown as dots only: no character of it, and its length capped as the editor shows it. */
export function maskValue(value: string): string {
  if (value.length === 0) return 'unset';
  return '•'.repeat(Math.min(12, Math.max(4, value.length)));
}

export function areSelectionsEqual(
  left: OnboardingWizardModelSelection | undefined,
  right: OnboardingWizardModelSelection | undefined,
): boolean {
  return (left?.providerId ?? '') === (right?.providerId ?? '')
    && (left?.modelId ?? '') === (right?.modelId ?? '')
    && (left?.enabled ?? true) === (right?.enabled ?? true);
}

export function cloneSelection(selection: OnboardingWizardModelSelection): OnboardingWizardModelSelection {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    enabled: selection.enabled,
  };
}

export function modelSelectionLabel(selection: OnboardingWizardModelSelection | undefined): string {
  if (!selection) return 'Choose model';
  if (selection.enabled === false && selection.providerId.length === 0 && selection.modelId.length === 0) {
    return 'Disabled';
  }

  const provider = selection.providerId.length > 0 ? selection.providerId : 'provider';
  const model = selection.modelId.length > 0 ? selection.modelId : 'model';
  if (selection.enabled === false) return `Off (${provider}/${model})`;
  return `${provider}/${model}`;
}

export function getExternalSurfaceSetupFieldSpec(fieldId: string): ExternalSurfaceSetupFieldSpec | null {
  for (const surface of EXTERNAL_SURFACE_SPECS) {
    const field = surface.fields.find((entry) => entry.id === fieldId);
    if (field) return field;
  }
  return null;
}

export function getExternalSurfaceSpecByFieldId(fieldId: string): ExternalSurfaceSpec | null {
  for (const surface of EXTERNAL_SURFACE_SPECS) {
    if (surface.fields.some((entry) => entry.id === fieldId)) return surface;
  }
  return null;
}

export function getRuntimeDerivedState(hydration: OnboardingWizardRuntimeHydration): OnboardingStepDerivationState {
  if (hydration.derived) {
    const fallback = buildDefaultDerivedState();
    return {
      step1Capabilities: hydration.derived.step1Capabilities ?? fallback.step1Capabilities,
      step1_5NetworkMode: hydration.derived.step1_5NetworkMode ?? fallback.step1_5NetworkMode,
      reopenEditAcknowledgements: {
        providers: hydration.derived.reopenEditAcknowledgements?.providers ?? fallback.reopenEditAcknowledgements.providers,
        subscriptions: hydration.derived.reopenEditAcknowledgements?.subscriptions ?? fallback.reopenEditAcknowledgements.subscriptions,
        auth: hydration.derived.reopenEditAcknowledgements?.auth ?? fallback.reopenEditAcknowledgements.auth,
      },
    };
  }

  if (hydration.snapshot) return deriveOnboardingStepState(hydration.snapshot);
  return buildDefaultDerivedState();
}

export function getOnboardingWizardBodyRows(viewportHeight: number): number {
  return Math.max(6, viewportHeight - 5);
}

export function getOnboardingWizardVisibleFieldCount(viewportHeight: number): number {
  return Math.max(1, getOnboardingWizardBodyRows(viewportHeight) - 6);
}
