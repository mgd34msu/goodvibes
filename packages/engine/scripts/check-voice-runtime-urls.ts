#!/usr/bin/env bun
/**
 * check-voice-runtime-urls.ts
 *
 * Sends a HEAD request to every pinned voice runtime URL (whisper bundle,
 * wake-word, speech-embedding and VAD assets, and the fallback origins) and
 * fails when an asset is served by no origin. An origin missing an asset it
 * should mirror is reported but fails only with `--require-all-origins`, which
 * is the check to run once the canonical release has been published.
 *
 * Network access is required, so this is a release-time check and is not part
 * of `bun run validate`.
 */
import { WAKE_VAD_MODEL, WAKE_WORD_FRONT_END, WAKE_WORD_MODELS } from '../platform/src/platform/voice/provisioning/wake-word-manifest.ts';
import { WHISPER_ENGINES } from '../platform/src/platform/voice/provisioning/manifest.ts';
import type { VerifiedDownloadSpec } from '../platform/src/platform/voice/provisioning/download-verified.ts';

export interface PinnedVoiceUrl {
  readonly asset: string;
  readonly origins: readonly string[];
}

export interface VoiceRuntimeUrlReport {
  /** Assets that no origin serves: provisioning cannot download them. */
  readonly unavailable: readonly string[];
  /** `<asset> @ <url>` for an origin that does not serve an asset another origin does. */
  readonly missingFromOrigin: readonly string[];
}

function specOrigins(spec: Pick<VerifiedDownloadSpec, 'url' | 'fallbackUrls'>): readonly string[] {
  return [spec.url, ...(spec.fallbackUrls ?? [])];
}

export function pinnedVoiceUrls(): readonly PinnedVoiceUrl[] {
  const specs: VerifiedDownloadSpec[] = [
    WAKE_WORD_FRONT_END.embedding.notice,
    WAKE_WORD_FRONT_END.embedding.download,
    WAKE_VAD_MODEL.notice,
    WAKE_VAD_MODEL.onnx,
    WAKE_VAD_MODEL.tflite,
    ...Object.values(WAKE_WORD_MODELS).flatMap((model) => [model.notice, model.onnx, model.tflite]),
  ];
  const pinned: PinnedVoiceUrl[] = specs.map((spec) => ({ asset: spec.url.split('/').pop() ?? spec.url, origins: specOrigins(spec) }));
  for (const engine of Object.values(WHISPER_ENGINES)) {
    if (engine?.bundle.url) pinned.push({ asset: engine.bundle.url.split('/').pop() ?? engine.bundle.url, origins: specOrigins(engine.bundle as { url: string; fallbackUrls?: readonly string[] }) });
  }
  return pinned;
}

export async function checkVoiceRuntimeUrls(
  pinned: readonly PinnedVoiceUrl[],
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceRuntimeUrlReport> {
  const unavailable: string[] = [];
  const missingFromOrigin: string[] = [];
  for (const { asset, origins } of pinned) {
    const served: boolean[] = [];
    for (const url of origins) {
      let ok = false;
      try {
        ok = (await fetchImpl(url, { method: 'HEAD', redirect: 'follow' })).ok;
      } catch {
        ok = false;
      }
      served.push(ok);
    }
    if (!served.some(Boolean)) unavailable.push(asset);
    else origins.forEach((url, i) => { if (!served[i]) missingFromOrigin.push(`${asset} @ ${url}`); });
  }
  return { unavailable, missingFromOrigin };
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--require-all-origins');
  const report = await checkVoiceRuntimeUrls(pinnedVoiceUrls());
  for (const asset of report.unavailable) console.error(`UNAVAILABLE: ${asset} is served by no origin`);
  for (const entry of report.missingFromOrigin) console.error(`${strict ? 'MISSING' : 'warning'}: ${entry}`);
  if (report.unavailable.length > 0 || (strict && report.missingFromOrigin.length > 0)) process.exit(1);
  console.log('Every pinned voice runtime asset is served.');
}

if (import.meta.main) await main();
