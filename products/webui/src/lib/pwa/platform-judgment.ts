export type InstallPlatform = 'ios-share-menu' | 'other';
export type PlatformResult = { readonly status: 'ready'; readonly platform: InstallPlatform; readonly isCurrent: () => boolean } | { readonly status: 'held' | 'unavailable' };
export interface InstallPlatformInput { readonly userAgent: string; readonly platform: string; readonly maxTouchPoints: number }

/** Installation instructions follow explicit browser platform tokens, including desktop-mode iPad. */
export async function readInstallPlatform(input: InstallPlatformInput, signal: AbortSignal): Promise<PlatformResult> {
  const { userAgent, platform, maxTouchPoints } = input;
  if (typeof userAgent !== 'string' || typeof platform !== 'string' || userAgent.length > 2048 || platform.length > 128
    || !Number.isSafeInteger(maxTouchPoints) || maxTouchPoints < 0 || signal.aborted) return { status: 'held' };
  const appleMobile = /\b(?:iPad|iPhone|iPod)\b/.test(userAgent) || /^(?:iPad|iPhone|iPod)$/.test(platform)
    || (platform === 'MacIntel' && maxTouchPoints > 1);
  const isCurrent = () => !signal.aborted && input.userAgent === userAgent && input.platform === platform && input.maxTouchPoints === maxTouchPoints;
  return { status: 'ready', platform: appleMobile ? 'ios-share-menu' : 'other', isCurrent };
}
