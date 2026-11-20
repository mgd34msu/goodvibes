import { readDaemonOperatorBearer } from '@goodvibes/engine/platform/platform/runtime/operations';

/**
 * The bearer token this process's daemon serves with, read without creating anything.
 * `GOODVIBES_DAEMON_TOKEN` wins, as it does for the daemon itself; otherwise the shared
 * operator-tokens.json record. A missing or unreadable record is "no token", never a mint:
 * the reader runs when a status question is asked, and a status question must not change a credential.
 * The rule is the engine's one reader (platform/runtime/operator-token-cleanup.ts), shared with the TUI.
 */
export function readDaemonOperatorToken(homeDirectory: string): string | null {
  return readDaemonOperatorBearer(homeDirectory);
}
