import type {
  WakeArtifactStatus,
  WakeProvisionResult,
  WakeProvisionStatus,
  WakeRuntimeSettings,
} from '@goodvibes-jev/engine/sdk/platform/voice';
export const SYNTHETIC_WAKE_RECALL_NOTE =
  '  the published recall figures for this model are measured on synthesised speech only; no human recording of the phrase exists behind them.';
export function describeWakeBlockers(settings: Pick<WakeRuntimeSettings, 'blockers'>): string[] {
  return settings.blockers.map((row) => `  ${row.key}: ${row.detail}`);
}
export function describeWakeLimitations(settings: Pick<WakeRuntimeSettings, 'limitations'>): string[] {
  return settings.limitations.map((row) => `  ${row.key}: ${row.detail}`);
}
export function createWakeProvisionPresentation(policy: {
  readonly surface: 'tui' | 'agent';
  readonly noun: string;
  readonly formatBytes: (bytes: number) => string;
  readonly corruptSuffix: string;
  readonly artifacts: (status: WakeProvisionStatus, line: (label: string, artifact: WakeArtifactStatus) => string) => string[];
  readonly download: (status: WakeProvisionStatus) => string[];
  readonly extraSettings: (status: WakeProvisionStatus, settings: WakeRuntimeSettings) => string[];
  readonly receiptHeader: (result: WakeProvisionResult) => string[];
  readonly failureSeparator: string;
  readonly embeddingNotice: boolean;
}) {
  function wakeArtifactLine(label: string, artifact: WakeArtifactStatus): string {
    if (artifact.verified) return `  ${label}: verified (${policy.formatBytes(artifact.bytes)})`;
    if (artifact.corrupt)
      return `  ${label}: PRESENT BUT FAILS VERIFICATION (${policy.formatBytes(artifact.bytes)})${policy.corruptSuffix}`;
    return `  ${label}: missing`;
  }
  function wakeStatusLines(status: WakeProvisionStatus, settings: WakeRuntimeSettings): string[] {
    const lines = [
      `  feature: voice.wake.enabled=${settings.enabled ? 'on' : 'off'}, voice.wake.surfaces.${policy.surface}=${settings.surfaceEnabled ? 'on' : 'off'}`,
      `  listening on this ${policy.noun}: ${settings.active ? 'yes, when the models are provisioned' : 'no'}`,
      `  models provisioned: ${status.ready ? 'yes' : `no (${status.reason ?? 'not-provisioned'})`}`,
      `  model version: ${status.modelVersion ?? 'unpinned'}`,
      ...policy.artifacts(status, wakeArtifactLine),
    ];
    if (!status.ready) lines.push(...policy.download(status));
    lines.push(
      `  wake models configured: ${settings.modelIds.length > 0 ? settings.modelIds.join(', ') : 'none (voice.wake.models is empty, so nothing is scored)'}`,
      `  recorder: voice.wake.captureCommand=${settings.capture.backend}, device=${settings.capture.device.trim().length > 0 ? settings.capture.device : 'system default'}`,
      ...policy.extraSettings(status, settings),
      `  after a wake: ${settings.autoSubmit ? 'the transcript is submitted as a turn' : 'the transcript is placed in the composer'}`,
      `  indicator: voice.wake.indicator=${settings.indicator}, activation sound=${settings.activationSound.kind}`,
      `  retained audio: voice.wake.retainAudio=${settings.retainAudio}`,
    );
    if (status.recallIsSyntheticOnly) lines.push(SYNTHETIC_WAKE_RECALL_NOTE);
    const blockers = describeWakeBlockers(settings);
    if (blockers.length) lines.push('  rows blocking startup:', ...blockers);
    const limitations = describeWakeLimitations(settings);
    if (limitations.length) lines.push('  rows not in force:', ...limitations);
    return lines;
  }
  function wakeProvisionReceiptLines(result: WakeProvisionResult): string[] {
    const lines = [
      `  ready: ${result.ready ? 'yes' : 'no'}`,
      `  model version: ${result.modelVersion ?? 'unpinned'}`,
      ...policy.receiptHeader(result),
    ];
    for (const outcome of result.outcomes) {
      const detail =
        outcome.state === 'failed'
          ? policy.failureSeparator + (outcome.error ?? 'no reason reported')
          : outcome.bytes !== undefined
            ? ` (${policy.formatBytes(outcome.bytes)})`
            : '';
      lines.push(`  ${outcome.component}: ${outcome.state}${detail}`, `    ${outcome.path}`);
    }
    if (result.noticePath !== null) lines.push(`  attribution NOTICE (travels with the classifier): ${result.noticePath}`);
    if (policy.embeddingNotice && result.embeddingNoticePath !== null)
      lines.push(`  attribution NOTICE (travels with the front end): ${result.embeddingNoticePath}`);
    if (result.recallIsSyntheticOnly) lines.push(SYNTHETIC_WAKE_RECALL_NOTE);
    return lines;
  }
  return { wakeArtifactLine, wakeStatusLines, wakeProvisionReceiptLines, describeWakeBlockers, describeWakeLimitations };
}
