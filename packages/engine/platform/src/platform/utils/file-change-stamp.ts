/**
 * file-change-stamp.ts, how a file read earlier tells that it was edited since:
 * its modification time and size, or 'absent'. One stat, no read and no
 * watcher; the hooks file and the MCP config files compare it before they are
 * used (hooks/workbench.ts, mcp/registry.ts).
 */
import { statSync } from 'node:fs';

/** The file's modification time and size, or 'absent' when there is none. */
export function fileChangeStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}
