import { access, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export interface LockedBrowserDbCopy {
  readonly copiedDbPath: string;
  readonly tempDir: string;
  cleanup(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function copyLockedBrowserSqlite(sourcePath: string): Promise<LockedBrowserDbCopy> {
  if (!(await exists(sourcePath))) {
    throw new Error(`Browser SQLite file does not exist: ${sourcePath}`);
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'goodvibes-browser-db-'));
  const baseName = basename(sourcePath);
  const copiedDbPath = join(tempDir, baseName);
  try {
    // The journal files go first: a browser that checkpoints between the copies
    // then leaves a main file newer than its journal, which SQLite tolerates,
    // instead of a journal newer than the main file.
    for (const suffix of ['-wal', '-shm']) {
      const source = `${sourcePath}${suffix}`;
      if (await exists(source)) {
        await copyFile(source, join(tempDir, `${baseName}${suffix}`));
      }
    }
    await copyFile(sourcePath, copiedDbPath);
  } catch (error) {
    // The directory holds a partial copy of the user's browsing history.
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  return {
    copiedDbPath,
    tempDir,
    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
