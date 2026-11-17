/**
 * operator-token-cleanup.ts, where a surface's operator token lives, and the
 * workspace-scoped locations an older install may have left one in.
 *
 * The canonical location is `<daemonHomeDir>/operator-tokens.json`. Earlier
 * releases wrote workspace-scoped copies instead;
 * `workspaceOperatorTokenCandidates` enumerates those so a boot can prune them
 * from one list rather than each caller guessing. Adding a location: append to
 * that function and it is inspected on the next boot.
 *
 * `resolveDaemonCompanionToken` is the read side: which token this process
 * authenticates to its daemon with, honoring a per-process override.
 * `readDaemonOperatorBearer` is the same rule without creating anything.
 */

import { join } from 'node:path';
import { getOrCreateCompanionToken, readCompanionTokenValue } from '../pairing/companion-token.js';
import type { CompanionPairingResult } from '../pairing/companion-token.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';

/**
 * The absolute operator-tokens.json paths a workspace may hold from an older
 * install: the unscoped `.goodvibes/` one and the surface-scoped one under
 * `.goodvibes/<surfaceRoot>/`.
 *
 * The canonical, current location is `<daemonHomeDir>/operator-tokens.json`;
 * this list is strictly the pruning candidates.
 */
export function workspaceOperatorTokenCandidates(
  workingDirectory: string,
  surfaceRoot: string,
): readonly string[] {
  return [
    join(workingDirectory, '.goodvibes', 'operator-tokens.json'),
    join(workingDirectory, '.goodvibes', surfaceRoot, 'operator-tokens.json'),
  ];
}

/**
 * Resolve the operator/companion token this process authenticates to its
 * daemon with: the home's own record (`getOrCreateCompanionToken`, minted on
 * first use), or `GOODVIBES_DAEMON_TOKEN` when set.
 *
 * `GOODVIBES_DAEMON_TOKEN` is the same env var the daemon honors for its own
 * bearer token, so one variable configures both sides of an adopted-daemon
 * setup. It applies to this process only: the home's record is never rewritten
 * with it, so a run pointed once at another daemon leaves the local daemon and
 * every other surface on their own token. A token that should be remembered
 * for a daemon elsewhere is saved by the "connect to an existing daemon" action,
 * beside that daemon's address (the terminal's connected-daemon credentials).
 *
 * @param daemonHomeDir - The daemon home whose token record is read.
 * @param peerName - The companion peer name minted under when the home has no
 * record yet; the calling product's own name, so two products sharing a home
 * mint distinguishable peers.
 */
export function resolveDaemonCompanionToken(
  daemonHomeDir: string,
  peerName: string,
): CompanionPairingResult {
  const own = getOrCreateCompanionToken(peerName, { daemonHomeDir });
  const override = process.env.GOODVIBES_DAEMON_TOKEN?.trim();
  return override ? { ...own, token: override } : own;
}

/**
 * The bearer the daemon on this machine serves with, read without creating
 * anything: `GOODVIBES_DAEMON_TOKEN` when set (the daemon honors the same
 * variable), otherwise the token in the home's operator-tokens.json. Null when
 * neither holds one. A status question runs this, so it never mints, moves or
 * repairs a credential. The one rule both terminal products read it with.
 */
export function readDaemonOperatorBearer(homeDirectory: string): string | null {
  const override = process.env.GOODVIBES_DAEMON_TOKEN?.trim();
  if (override) return override;
  try {
    return readCompanionTokenValue(resolveGoodVibesDaemonHome(homeDirectory));
  } catch {
    return null; // an unreadable record is no token here; the daemon's own boot repairs it
  }
}
