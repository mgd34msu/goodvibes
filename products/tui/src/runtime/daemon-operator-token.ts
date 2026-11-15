import { existsSync, readFileSync } from 'node:fs';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { operatorTokenPath } from '@goodvibes-jev/engine/platform/platform/workspace';

/**
 * The bearer token this process's daemon serves with, read without creating anything.
 * `GOODVIBES_DAEMON_TOKEN` wins, as it does for the daemon itself; otherwise the shared
 * operator-tokens.json record. A missing or unreadable record is "no token", never a mint:
 * the reader runs when a status question is asked, and a status question must not change a credential.
 */
export function readDaemonOperatorToken(homeDirectory: string): string | null {
  const override = process.env.GOODVIBES_DAEMON_TOKEN?.trim();
  if (override) return override;
  const path = operatorTokenPath(resolveGoodVibesDaemonHome(homeDirectory));
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { token?: unknown } | null;
    return typeof parsed?.token === 'string' && parsed.token.trim() ? parsed.token : null;
  } catch {
    return null;
  }
}
