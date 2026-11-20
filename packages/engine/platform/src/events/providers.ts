/**
 * ProviderEvent, discriminated union for provider registry and fallback events.
 */
export type ProviderEvent =
  /** The set of usable providers changed: the ids `added`, `removed` and `updated` (a key or sign-in changed). */
  | { type: 'PROVIDERS_CHANGED'; added: string[]; removed: string[]; updated: string[] }
  /** A provider problem worth showing, such as a custom provider file that could not be loaded; `message` says what. */
  | { type: 'PROVIDER_WARNING'; message: string }
  /** Every provider serving the synthetic model `from` was unavailable, so the request went to the free fallback model `to`, served by `provider`. */
  | { type: 'MODEL_FALLBACK'; from: string; to: string; provider: string }
  /** One billable voice call on a METERED provider (local engines emit nothing). */
  | {
      type: 'PROVIDER_VOICE_USAGE';
      provider: string;
      modelId?: string | undefined;
      kind: 'tts' | 'stt';
      billableUnits: number;
      unit: 'characters' | 'seconds';
    }
  /** The selected model changed to `registryKey` on `provider`; `previous` is the model before, when there was one. */
  | { type: 'MODEL_CHANGED'; registryKey: string; provider: string; previous?: { registryKey: string; provider: string } }
  /**
   * A daemon batch job reached its final state, so a surface can show the
   * result without polling. Read the job itself with batch.jobs.get.
   */
  | {
      type: 'BATCH_JOB_SETTLED';
      jobId: string;
      status: 'completed' | 'failed' | 'cancelled' | 'expired' | 'dead_lettered';
      provider: string;
      model: string;
      completedAt: number;
      providerBatchId?: string | undefined;
      errorCode?: string | undefined;
      errorMessage?: string | undefined;
    };

export type ProviderEventType = ProviderEvent['type'];
