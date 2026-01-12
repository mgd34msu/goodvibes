// ============================================================================
// SESSION BACKUP SERVICE
// ============================================================================
// Backs up Claude session files on app startup to preserve session history.
// Sessions are copied from ~/.claude/projects/ to the app's session-data folder.

import { app } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { Logger } from './logger';

const logger = new Logger('SessionBackup');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const BACKUP_FOLDER_NAME = 'session-data';

// ============================================================================
// SESSION BACKUP SERVICE
// ============================================================================

/**
 * Gets the backup directory path in the app's user data folder
 */
function getBackupDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, BACKUP_FOLDER_NAME);
}

/**
 * Recursively finds all .jsonl session files in a directory
 */
async function findSessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await findSessionFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    logger.debug('Could not read directory', {
      dir,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }

  return files;
}

/**
 * Gets the relative path from the Claude projects directory
 */
function getRelativePath(filePath: string): string {
  return path.relative(CLAUDE_PROJECTS_DIR, filePath);
}

/**
 * Checks if a backup already exists and is up-to-date
 */
function backupExists(sourcePath: string, backupPath: string): boolean {
  if (!existsSync(backupPath)) {
    return false;
  }

  try {
    const sourceStats = statSync(sourcePath);
    const backupStats = statSync(backupPath);

    // Consider backup current if it has the same size and modification time
    // (or backup is newer, in case of timezone issues)
    return backupStats.size === sourceStats.size &&
           backupStats.mtimeMs >= sourceStats.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Backs up a single session file
 */
function backupSessionFile(sourcePath: string, backupDir: string): boolean {
  try {
    const relativePath = getRelativePath(sourcePath);
    const backupPath = path.join(backupDir, relativePath);

    // Skip if backup already exists and is current
    if (backupExists(sourcePath, backupPath)) {
      return false;
    }

    // Ensure the directory structure exists
    const backupFileDir = path.dirname(backupPath);
    if (!existsSync(backupFileDir)) {
      mkdirSync(backupFileDir, { recursive: true });
    }

    // Copy the file
    copyFileSync(sourcePath, backupPath);

    // Preserve the original modification time
    const sourceStats = statSync(sourcePath);
    fs.utimes(backupPath, sourceStats.atime, sourceStats.mtime).catch((error) => {
      logger.debug('Failed to preserve timestamps', {
        backupPath,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    });

    return true;
  } catch (error) {
    logger.error('Failed to backup session file', {
      sourcePath,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return false;
  }
}

/**
 * Runs the session backup process
 * Returns the number of new sessions backed up
 */
export async function backupSessions(): Promise<{ backed: number; total: number }> {
  logger.info('Starting session backup...');

  // Ensure Claude projects directory exists
  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    logger.info('Claude projects directory not found, skipping backup');
    return { backed: 0, total: 0 };
  }

  // Ensure backup directory exists
  const backupDir = getBackupDir();
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
    logger.info(`Created backup directory: ${backupDir}`);
  }

  // Find all session files
  const sessionFiles = await findSessionFiles(CLAUDE_PROJECTS_DIR);
  logger.info(`Found ${sessionFiles.length} session files to check`);

  // Backup each file
  let backedUp = 0;
  for (const filePath of sessionFiles) {
    if (backupSessionFile(filePath, backupDir)) {
      backedUp++;
    }
  }

  if (backedUp > 0) {
    logger.info(`Backed up ${backedUp} new/updated session files`);
  } else {
    logger.info('All sessions already backed up');
  }

  return { backed: backedUp, total: sessionFiles.length };
}

/**
 * Gets the backup directory path (for display in UI)
 */
export function getBackupDirectory(): string {
  return getBackupDir();
}

/**
 * Gets backup statistics
 */
export async function getBackupStats(): Promise<{
  backupDir: string;
  totalFiles: number;
  totalSizeBytes: number;
}> {
  const backupDir = getBackupDir();

  if (!existsSync(backupDir)) {
    return { backupDir, totalFiles: 0, totalSizeBytes: 0 };
  }

  const files = await findSessionFiles(backupDir);
  let totalSize = 0;

  for (const file of files) {
    try {
      const stats = statSync(file);
      totalSize += stats.size;
    } catch {
      // Ignore errors
    }
  }

  return {
    backupDir,
    totalFiles: files.length,
    totalSizeBytes: totalSize
  };
}
