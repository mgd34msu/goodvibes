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
const METADATA_FILE = 'backup-metadata.json';
const ONE_HOUR_MS = 60 * 60 * 1000;

// ============================================================================
// METADATA TRACKING
// ============================================================================

interface BackupMetadata {
  lastBackupTimestamp: number;  // Unix timestamp in milliseconds
  version: number;
}

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
 * Gets the metadata file path
 */
function getMetadataPath(): string {
  return path.join(getBackupDir(), METADATA_FILE);
}

/**
 * Reads the backup metadata from disk
 * Returns null if metadata doesn't exist or is invalid
 */
async function readBackupMetadata(): Promise<BackupMetadata | null> {
  const metadataPath = getMetadataPath();
  if (!existsSync(metadataPath)) {
    return null;
  }
  
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const data = JSON.parse(content) as BackupMetadata;
    
    // Validate the structure
    if (typeof data.lastBackupTimestamp !== 'number' || typeof data.version !== 'number') {
      logger.debug('Invalid metadata structure, treating as first run');
      return null;
    }
    
    return data;
  } catch (error) {
    logger.debug('Failed to read backup metadata', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return null;
  }
}

/**
 * Writes the backup metadata to disk
 */
async function writeBackupMetadata(metadata: BackupMetadata): Promise<void> {
  const metadataPath = getMetadataPath();
  try {
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  } catch (error) {
    logger.error('Failed to write backup metadata', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
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
 * Determines if a file should be backed up based on timestamp and size
 * @param sourcePath Path to the source file
 * @param backupPath Path to the backup file
 * @param cutoffTime Timestamp (ms) before which files don't need backup (null = backup everything)
 * @returns true if file should be backed up
 */
function shouldBackup(sourcePath: string, backupPath: string, cutoffTime: number | null): boolean {
  // If no cutoff time (first run), backup everything
  if (cutoffTime === null) {
    return true;
  }
  
  // If backup doesn't exist, definitely backup
  if (!existsSync(backupPath)) {
    return true;
  }
  
  try {
    const sourceStats = statSync(sourcePath);
    
    // Backup if source was modified after cutoff time
    // (cutoff = last backup timestamp - 1 hour buffer)
    if (sourceStats.mtimeMs > cutoffTime) {
      return true;
    }
    
    // Also check if sizes differ (handles edge cases where mtime wasn't updated)
    const backupStats = statSync(backupPath);
    if (sourceStats.size !== backupStats.size) {
      return true;
    }
    
    return false;
  } catch {
    // If we can't check stats, backup to be safe
    return true;
  }
}

/**
 * Backs up a single session file
 * @param sourcePath Path to source file
 * @param backupDir Backup directory root
 * @param cutoffTime Timestamp cutoff for determining if backup is needed
 * @returns true if file was backed up, false if skipped
 */
function backupSessionFile(sourcePath: string, backupDir: string, cutoffTime: number | null): boolean {
  try {
    const relativePath = getRelativePath(sourcePath);
    const backupPath = path.join(backupDir, relativePath);

    // Check if backup is needed
    if (!shouldBackup(sourcePath, backupPath, cutoffTime)) {
      return false;
    }

    // Ensure the directory structure exists
    const backupFileDir = path.dirname(backupPath);
    if (!existsSync(backupFileDir)) {
      mkdirSync(backupFileDir, { recursive: true });
    }

    // Copy the file
    copyFileSync(sourcePath, backupPath);
    
    logger.debug('Backed up session file', { sourcePath, backupPath });

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

  // Read backup metadata
  const metadata = await readBackupMetadata();
  
  // Calculate cutoff time with 1-hour buffer
  // If no metadata (first run), cutoff is null which means backup everything
  const cutoffTime = metadata ? metadata.lastBackupTimestamp - ONE_HOUR_MS : null;
  
  if (metadata) {
    const cutoffDate = new Date(cutoffTime!);
    logger.info(`Backing up files modified after ${cutoffDate.toISOString()} (with 1-hour buffer)`);
  } else {
    logger.info('First backup run - backing up all session files');
  }

  // Find all session files
  const sessionFiles = await findSessionFiles(CLAUDE_PROJECTS_DIR);
  logger.info(`Found ${sessionFiles.length} session files to check`);

  // Record backup start time (before processing to ensure we don't miss files)
  const backupStartTime = Date.now();

  // Backup each file
  let backedUp = 0;
  for (const filePath of sessionFiles) {
    if (backupSessionFile(filePath, backupDir, cutoffTime)) {
      backedUp++;
    }
  }

  // Write updated metadata
  const newMetadata: BackupMetadata = {
    lastBackupTimestamp: backupStartTime,
    version: 1
  };
  await writeBackupMetadata(newMetadata);

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
