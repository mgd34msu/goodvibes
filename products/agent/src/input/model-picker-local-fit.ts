/**
 * Local-fit recommendation builder.
 *
 * When no provider credentials are configured, the model picker would show an
 * empty list. This module builds a small set of synthetic model entries that
 * represent common local model sizes so the picker opens with useful content.
 *
 * Rules:
 *   - These entries are purely informational, they are NOT installed models.
 *   - They must never appear when any real provider is configured.
 *   - Selecting one routes through the local-provider install/confirm path,
 *     never a silent model switch.
 *   - The provider sentinel 'local' is distinct from 'ollama', 'lm-studio',
 *     etc. so cloud-provider fit checks are never triggered.
 */

import type { ModelDefinition } from '@goodvibes/engine/platform/platform/providers';
import {
  estimateModelBytes,
  fitAssessment,
  fitVerdictLabel,
  readHardwareProfileSync,
} from '../core/hardware-profile.ts';
import type { FitVerdict, HardwareProfile } from '../core/hardware-profile.ts';

/** What a row may claim about this machine; `unknown` claims nothing. */
const FIT_CLAIMS: Readonly<Record<FitVerdict, string>> = {
  'fits-gpu': 'recommended for your hardware',
  'fits-ram': 'recommended for your hardware',
  tight: 'may run, tight',
  'too-big': 'too large for this machine',
  unknown: '',
};

/**
 * Sentinel provider ID used on synthetic local recommendation entries.
 * Must not collide with any real provider (ollama, lm-studio, etc.).
 */
export const LOCAL_REC_PROVIDER = 'local';

/**
 * Representative local model sizes to recommend.
 * Each entry: { id, displayName, params, sizeLabel }
 */
const LOCAL_REC_SIZES = [
  { id: 'local:3b', displayName: '3B model (small, fast)', params: 3_000_000_000, sizeLabel: '3B' },
  { id: 'local:7b', displayName: '7B model (balanced)', params: 7_000_000_000, sizeLabel: '7B' },
  { id: 'local:13b', displayName: '13B model (more capable)', params: 13_000_000_000, sizeLabel: '13B' },
] as const;

/**
 * Sentinel id used on the synthetic "Sign in to a provider" row that is
 * appended to the local-only list when no credentials are configured.
 */
export const SIGN_IN_ROW_ID = 'local:sign-in';

/**
 * Return true when a model entry is the synthetic sign-in affordance row.
 * This row must never be committed as an active model.
 */
export function isProviderSignInRow(model: ModelDefinition): boolean {
  return model.id === SIGN_IN_ROW_ID && model.provider === LOCAL_REC_PROVIDER;
}

/**
 * Return true when a model entry is a synthetic local fit recommendation
 * (i.e. not a real installed model).
 */
export function isLocalFitRecommendation(model: ModelDefinition): boolean {
  return (
    model.provider === LOCAL_REC_PROVIDER &&
    (model.description ?? '').includes('not yet installed')
  );
}

/**
 * Build the synthetic "Sign in to a provider" row for the local-only list.
 * Selecting this row routes to the provider picker; it must never be committed
 * as an active model.
 */
export function buildSignInRow(): ModelDefinition {
  return {
    id: SIGN_IN_ROW_ID,
    provider: LOCAL_REC_PROVIDER,
    registryKey: SIGN_IN_ROW_ID,
    displayName: 'Sign in to a provider →',
    description: 'Open the provider sign-in flow to connect a cloud or local provider.',
    capabilities: {
      toolCalling: false,
      codeEditing: false,
      reasoning: false,
      multimodal: false,
    },
    contextWindow: 0,
    selectable: true,
    tier: 'free',
  };
}

/**
 * Build synthetic local recommendation entries annotated with hardware fit
 * labels for the current machine.
 *
 * Pass a `profile` override for deterministic tests; omit to use the
 * process-level hardware probe (`readHardwareProfileSync`).
 */
export function buildLocalFitRecommendations(
  profileOverride?: HardwareProfile,
): ModelDefinition[] {
  const profile = profileOverride ?? readHardwareProfileSync();

  return LOCAL_REC_SIZES.map((spec) => {
    const sizeBytes = estimateModelBytes(spec.params);
    const verdict = fitAssessment(sizeBytes, profile);
    const fitHint = fitVerdictLabel(verdict, spec.sizeLabel, profile);
    // The claim follows the verdict, and the detail never implies the model is ready to use.
    const claim = FIT_CLAIMS[verdict];
    const detail = `${claim ? `${claim}, ` : ''}not yet installed${fitHint ? ` (${fitHint})` : ''}`;

    const model: ModelDefinition = {
      id: spec.id,
      provider: LOCAL_REC_PROVIDER,
      registryKey: spec.id,
      displayName: spec.displayName,
      description: detail,
      capabilities: {
        toolCalling: true,
        codeEditing: false,
        reasoning: false,
        multimodal: false,
      },
      contextWindow: 8192,
      selectable: true,
      tier: 'free',
    };
    return model;
  });
}
