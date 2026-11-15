export interface VoiceBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly enabled: boolean;
  readonly notes: readonly string[];
}
function readVoiceBundle(value: unknown): VoiceBundle | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  if (b['version'] !== 1 || typeof b['exportedAt'] !== 'number' || Number.isNaN(new Date(b['exportedAt']).getTime())) return null;
  if (typeof b['enabled'] !== 'boolean' || !Array.isArray(b['notes'])) return null;
  return value as VoiceBundle;
}
export function inspectVoiceBundle(value: unknown): string {
  const bundle = readVoiceBundle(value);
  if (!bundle) return 'That file is not a voice bundle (expected version 1 with exportedAt, enabled and notes).';
  return [
    'Voice Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  enabled: ${bundle.enabled ? 'yes' : 'no'}`,
    `  notes: ${bundle.notes.length}`,
  ].join('\n');
}
