/** One package-root marker shared by the overlay tool and release gates.
 * Older filenames are evidence to block/recover, never package aliases. */
export function engineOverlayMarkerPaths(enginePackage: string, configured?: string): readonly string[] {
  const root = `node_modules/${enginePackage}`;
  return [...new Set([
    `${root}/.local-engine-overlay.json`,
    ...(configured ? [configured] : []),
    '.engine-overlay-restore.json',
    `${root}/.local-sdk-overlay.json`,
    `${root}/sdk/.local-sdk-overlay.json`,
    `${root}/platform/.local-sdk-overlay.json`,
  ])];
}
