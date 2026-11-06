export interface VoiceBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly enabled: boolean;
  readonly notes: readonly string[];
}
export function inspectVoiceBundle(bundle: VoiceBundle): string {
  return [
    'Voice Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  enabled: ${bundle.enabled ? 'yes' : 'no'}`,
    `  notes: ${bundle.notes.length}`,
  ].join('\n');
}
