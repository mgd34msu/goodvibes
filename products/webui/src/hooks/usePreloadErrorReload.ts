import { useEffect } from 'react';

/**
 * A lazily loaded chunk that fails to load almost always means this page runs
 * an older build than the daemon now serves (the service worker opened a cached
 * shell while the daemon was slow). One reload picks up the current shell.
 * A second failure inside the window is a real fault and is left to surface, so
 * a genuinely missing chunk can never reload in a loop. The record of the last
 * reload must survive the reload itself; when it cannot be stored (blocked site
 * data) no reload is attempted, because nothing would stop the next page from
 * reloading again.
 */
export const PRELOAD_RELOAD_KEY = 'goodvibes-preload-reload';
export const PRELOAD_RELOAD_WINDOW_MS = 30_000;

export interface PreloadReloadEnv {
  readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly now: () => number;
  readonly reload: () => void;
  readonly read: () => string | null;
  /** Returns false when the value could not be stored. */
  readonly write: (value: string) => boolean;
}

export function installPreloadErrorReload(env: PreloadReloadEnv): () => void {
  const onError = (event: Event): void => {
    const last = Number(env.read());
    if (Number.isFinite(last) && last > 0 && env.now() - last < PRELOAD_RELOAD_WINDOW_MS) return;
    // Stopping the default keeps the failed import from throwing into the page that is about to be replaced.
    if (!env.write(String(env.now()))) return;
    event.preventDefault();
    env.reload();
  };
  env.target.addEventListener('vite:preloadError', onError);
  return () => env.target.removeEventListener('vite:preloadError', onError);
}

export function usePreloadErrorReload(): void {
  useEffect(() => installPreloadErrorReload({
    target: window,
    now: Date.now,
    reload: () => window.location.reload(),
    read: () => { try { return window.sessionStorage.getItem(PRELOAD_RELOAD_KEY); } catch { return null; } },
    write: (value) => {
      try {
        window.sessionStorage.setItem(PRELOAD_RELOAD_KEY, value);
        return window.sessionStorage.getItem(PRELOAD_RELOAD_KEY) === value;
      } catch { return false; }
    },
  }), []);
}
