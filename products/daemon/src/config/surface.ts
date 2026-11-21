/**
 * surface.ts, the daemon's single surface-root identifier.
 *
 * Every piece of the daemon's own on-disk state (sessions, recovery snapshots,
 * checkpoints, watchers, triggers, control-plane stores)
 * lives under `.goodvibes/<surface root>/`. The segment used to be spelled as a
 * bare string literal at each call site, which is how a writer and a reader
 * ended up disagreeing about where the last-session pointer lives.
 *
 * ── Why the daemon's state root is still `tui` ──────────────────────────────
 *
 * Because that is where the running daemon's state already is. Every store
 * this daemon has written on every installed machine, sessions, approvals,
 * watchers, devices, channel policies, the code index, sits under
 * `.goodvibes/tui/`. Renaming the segment here would not move that state; it
 * would make the daemon stop finding it, silently, on machines that have been
 * running for months.
 *
 * The rename is a migration, not a constant edit: it needs a copy-forward pass
 * with a receipt, the same shape the platform already performs for the unscoped →
 * scoped move, plus the live-install rehearsal that goes with it. Until then
 * this constant carries the reason so nobody "tidies" it. The daemon's
 * settings do not live here: see GOODVIBES_DAEMON_SETTINGS_ROOT below.
 *
 * The value is the engine's DAEMON_STATE_SURFACE_ROOT, so a terminal app
 * waiting for this daemon finds its lifecycle marker where it is written.
 */
import { DAEMON_STATE_SURFACE_ROOT } from '@goodvibes/engine/platform/platform/daemon/lifecycle-marker';

export const GOODVIBES_DAEMON_SURFACE_ROOT = DAEMON_STATE_SURFACE_ROOT;

/**
 * Where the daemon keeps its own value of every client-scoped setting
 * (`~/.goodvibes/daemon-host/settings.json` and the project's
 * `.goodvibes/daemon-host/settings.json`). The terminal app's settings file is
 * the terminal app's: a preference chosen there, such as `permissions.mode`,
 * does not become the posture of the daemon's own sessions (channels, the web
 * UI, hosted Agent turns). Daemon-owned settings live in the daemon tier
 * either way (config-ownership.ts). Only the settings move; the state above
 * stays where it is.
 */
export const GOODVIBES_DAEMON_SETTINGS_ROOT = 'daemon-host';
