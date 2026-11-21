/**
 * surface.ts, the TUI's single surface-root identifier.
 *
 * Every piece of the TUI's own on-disk state (sessions, the last-session
 * pointer, recovery snapshots, checkpoints) lives under `.goodvibes/tui/`. That scope
 * segment used to be spelled as a bare `'tui'` string literal at each call
 * site, which is how a writer and a reader ended up disagreeing about where
 * the last-session pointer lives: one call passed the scope, another omitted
 * it and silently resolved to the shared, unscoped `.goodvibes/` directory,
 * so `--continue` looked at an empty file forever.
 *
 * The name is written once, in the platform's goodvibes-home.ts (the daemon
 * credential records under the same root read it there), and re-exported here.
 * It feeds `createSessionSurface` in runtime/services.ts, which resolves every
 * session path once at startup into the `SessionSurface` handle threaded
 * through the rest of the runtime, and every other path under the TUI's own
 * root (config storage, keybindings, onboarding state, catalogs, journals)
 * names it too.
 */
export { GOODVIBES_TUI_SURFACE_ROOT } from '@goodvibes/engine/platform/platform/config/goodvibes-home';

/**
 * Which servers the terminal app's saved scan (`discovered-providers.json`)
 * registers in every composition: all of them, since each was found by the
 * owner's own /scan, which may reach the local network.
 */
export const TUI_TRUSTS_SAVED_SCANNED_SERVERS = (): boolean => true;
