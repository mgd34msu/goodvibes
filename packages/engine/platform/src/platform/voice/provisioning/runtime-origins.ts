/**
 * Where the pinned voice runtime assets are hosted. The canonical repository's
 * `voice-runtimes-v1` release is tried first; the former repository's release,
 * which holds the same bytes, is the fallback. Both are checked against the
 * same pinned size and sha256, so a missing or retired origin costs one failed
 * request instead of breaking provisioning, and a wrong origin cannot change
 * what is installed.
 */
import type { VerifiedDownloadSpec } from './download-verified.js';

export const VOICE_RUNTIMES_ORIGINS: readonly string[] = [
  'https://github.com/mgd34msu/goodvibes/releases/download/voice-runtimes-v1',
  'https://github.com/mgd34msu/goodvibes-sdk/releases/download/voice-runtimes-v1',
];

/** The `url` and `fallbackUrls` of one hosted asset, in origin order. */
export function voiceRuntimesAsset(name: string): Pick<VerifiedDownloadSpec, 'url' | 'fallbackUrls'> {
  const [primary, ...rest] = VOICE_RUNTIMES_ORIGINS.map((origin) => `${origin}/${name}`);
  return { url: primary!, fallbackUrls: rest };
}
