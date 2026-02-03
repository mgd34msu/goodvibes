// ============================================================================
// DATABASE MIGRATION SYSTEM
// ============================================================================

import type Database from 'better-sqlite3';
import { Logger } from '../services/logger.js';

const logger = new Logger('DatabaseMigrations');

// ============================================================================
// MIGRATION TYPES
// ============================================================================

/**
 * Represents a database migration
 */
export interface Migration {
  /** Unique version number for the migration */
  version: number;
  /** Human-readable description of what the migration does */
  description: string;
  /** Function to apply the migration (upgrade) */
  up: (db: Database.Database) => void;
  /** Function to revert the migration (downgrade) - optional */
  down?: (db: Database.Database) => void;
}

/**
 * Schema version record from the database
 */
interface SchemaVersionRow {
  version: number;
  applied_at: string;
  description: string;
}

// ============================================================================
// SCHEMA VERSION TABLE
// ============================================================================

/**
 * Creates the schema_versions table if it doesn't exist
 * This table tracks which migrations have been applied
 */
function ensureSchemaVersionsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    )
  `);
}

/**
 * Gets the current schema version from the database
 * @param db - The database instance
 * @returns The current version number, or 0 if no migrations have been applied
 */
export function getCurrentVersion(db: Database.Database): number {
  ensureSchemaVersionsTable(db);

  const row = db.prepare(`
    SELECT MAX(version) as version FROM schema_versions
  `).get() as { version: number | null } | undefined;

  return row?.version ?? 0;
}

/**
 * Records that a migration has been applied
 * @param db - The database instance
 * @param version - The migration version
 * @param description - Description of the migration
 */
function recordMigration(db: Database.Database, version: number, description: string): void {
  db.prepare(`
    INSERT INTO schema_versions (version, description)
    VALUES (?, ?)
  `).run(version, description);
}

/**
 * Removes a migration record (for rollback)
 * @param db - The database instance
 * @param version - The migration version to remove
 */
function removeMigrationRecord(db: Database.Database, version: number): void {
  db.prepare(`
    DELETE FROM schema_versions WHERE version = ?
  `).run(version);
}

// ============================================================================
// MIGRATION RUNNER
// ============================================================================

/**
 * Runs all pending migrations up to the target version
 * @param db - The database instance
 * @param migrations - Array of migrations to consider
 * @param targetVersion - Optional target version (defaults to latest)
 * @returns The number of migrations applied
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[],
  targetVersion?: number
): number {
  ensureSchemaVersionsTable(db);

  const currentVersion = getCurrentVersion(db);
  const maxVersion = targetVersion ?? Math.max(...migrations.map(m => m.version), 0);

  if (currentVersion >= maxVersion) {
    logger.info(`Database is up to date (version ${currentVersion})`);
    return 0;
  }

  // Sort migrations by version
  const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);

  // Filter to pending migrations
  const pendingMigrations = sortedMigrations.filter(
    m => m.version > currentVersion && m.version <= maxVersion
  );

  if (pendingMigrations.length === 0) {
    logger.info('No pending migrations');
    return 0;
  }

  logger.info(`Running ${pendingMigrations.length} migrations (${currentVersion} -> ${maxVersion})`);

  let appliedCount = 0;

  for (const migration of pendingMigrations) {
    logger.info(`Applying migration ${migration.version}: ${migration.description}`);

    try {
      // Run migration in a transaction
      const runMigration = db.transaction(() => {
        migration.up(db);
        recordMigration(db, migration.version, migration.description);
      });

      runMigration();
      appliedCount++;
      logger.info(`Migration ${migration.version} applied successfully`);
    } catch (error) {
      logger.error(`Migration ${migration.version} failed`, error);
      throw new Error(
        `Migration ${migration.version} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  logger.info(`Applied ${appliedCount} migrations successfully`);
  return appliedCount;
}

/**
 * Rolls back migrations to a target version
 * @param db - The database instance
 * @param migrations - Array of migrations to consider
 * @param targetVersion - The version to roll back to
 * @returns The number of migrations rolled back
 */
export function rollbackMigrations(
  db: Database.Database,
  migrations: Migration[],
  targetVersion: number
): number {
  const currentVersion = getCurrentVersion(db);

  if (currentVersion <= targetVersion) {
    logger.info(`Database is already at or below version ${targetVersion}`);
    return 0;
  }

  // Sort migrations by version descending for rollback
  const sortedMigrations = [...migrations].sort((a, b) => b.version - a.version);

  // Filter to migrations that need rollback
  const migrationsToRollback = sortedMigrations.filter(
    m => m.version > targetVersion && m.version <= currentVersion && m.down
  );

  if (migrationsToRollback.length === 0) {
    logger.warn('No reversible migrations found for rollback');
    return 0;
  }

  logger.info(`Rolling back ${migrationsToRollback.length} migrations (${currentVersion} -> ${targetVersion})`);

  let rolledBackCount = 0;

  for (const migration of migrationsToRollback) {
    if (!migration.down) {
      logger.warn(`Migration ${migration.version} has no rollback function, skipping`);
      continue;
    }

    logger.info(`Rolling back migration ${migration.version}: ${migration.description}`);

    try {
      const rollbackFn = migration.down;
      if (!rollbackFn) {
        throw new Error(`Migration ${migration.version} has no rollback function`);
      }
      const runRollback = db.transaction(() => {
        rollbackFn(db);
        removeMigrationRecord(db, migration.version);
      });

      runRollback();
      rolledBackCount++;
      logger.info(`Migration ${migration.version} rolled back successfully`);
    } catch (error) {
      logger.error(`Rollback of migration ${migration.version} failed`, error);
      throw new Error(
        `Rollback of migration ${migration.version} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  logger.info(`Rolled back ${rolledBackCount} migrations`);
  return rolledBackCount;
}

/**
 * Gets the migration history from the database
 * @param db - The database instance
 * @returns Array of applied migrations with their timestamps
 */
export function getMigrationHistory(db: Database.Database): SchemaVersionRow[] {
  ensureSchemaVersionsTable(db);

  const rows = db.prepare(`
    SELECT version, applied_at, description
    FROM schema_versions
    ORDER BY version ASC
  `).all() as SchemaVersionRow[];

  return rows;
}

// ============================================================================
// AVAILABLE MIGRATIONS
// ============================================================================

/**
 * All available database migrations
 * Add new migrations here as the schema evolves
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Add hook_type and prompt columns to hooks table',
    up: (db) => {
      // Add hook_type column with default 'command'
      db.exec(`ALTER TABLE hooks ADD COLUMN hook_type TEXT DEFAULT 'command'`);
      // Add prompt column for prompt-type hooks
      db.exec(`ALTER TABLE hooks ADD COLUMN prompt TEXT`);
    },
    down: (db) => {
      // SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
      // This is a simplified rollback - in production you'd want to preserve data
      db.exec(`
        CREATE TABLE hooks_backup AS SELECT
          id, name, event_type, matcher, command, timeout, enabled, scope,
          project_path, execution_count, last_executed, last_result, created_at, updated_at
        FROM hooks
      `);
      db.exec(`DROP TABLE hooks`);
      db.exec(`
        CREATE TABLE hooks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          event_type TEXT NOT NULL,
          matcher TEXT,
          command TEXT NOT NULL,
          timeout INTEGER DEFAULT 30000,
          enabled INTEGER DEFAULT 1,
          scope TEXT DEFAULT 'user',
          project_path TEXT,
          execution_count INTEGER DEFAULT 0,
          last_executed TEXT,
          last_result TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`INSERT INTO hooks SELECT * FROM hooks_backup`);
      db.exec(`DROP TABLE hooks_backup`);
    },
  },
  {
    version: 2,
    description: 'Expand tag system with effects, aliases, suggestions, templates, and analytics',
    up: (db) => {
      // Extend tags table with new columns
      db.exec(`ALTER TABLE tags ADD COLUMN effect TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE tags ADD COLUMN alias_of INTEGER DEFAULT NULL`);
      db.exec(`ALTER TABLE tags ADD COLUMN description TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE tags ADD COLUMN is_pinned INTEGER DEFAULT 0`);
      db.exec(`ALTER TABLE tags ADD COLUMN usage_count INTEGER DEFAULT 0`);
      db.exec(`ALTER TABLE tags ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP`);

      // Recreate session_tags with added_by column
      db.exec(`DROP TABLE IF EXISTS session_tags`);
      db.exec(`
        CREATE TABLE session_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          tag_id INTEGER NOT NULL,
          added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          added_by TEXT DEFAULT 'user',
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
          UNIQUE(session_id, tag_id)
        )
      `);

      // Create tag_suggestions table
      db.exec(`
        CREATE TABLE tag_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          tag_name TEXT NOT NULL,
          confidence REAL NOT NULL,
          category TEXT,
          reasoning TEXT,
          status TEXT DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          reviewed_at TEXT DEFAULT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);

      // Create suggestion_feedback table
      db.exec(`
        CREATE TABLE suggestion_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tag_name TEXT NOT NULL,
          context_hash TEXT,
          accepted_count INTEGER DEFAULT 0,
          rejected_count INTEGER DEFAULT 0,
          last_feedback_at TEXT,
          UNIQUE(tag_name, context_hash)
        )
      `);

      // Create tag_templates table
      db.exec(`
        CREATE TABLE tag_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          tag_ids TEXT NOT NULL,
          is_system INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create recent_tags table
      db.exec(`
        CREATE TABLE recent_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tag_id INTEGER NOT NULL,
          used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        )
      `);

      // Extend sessions table
      db.exec(`ALTER TABLE sessions ADD COLUMN suggestion_scan_status TEXT DEFAULT 'pending'`);
      db.exec(`ALTER TABLE sessions ADD COLUMN suggestion_scanned_at TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE sessions ADD COLUMN suggestion_scan_depth TEXT DEFAULT NULL`);

      // Create indexes
      db.exec(`CREATE INDEX idx_tags_pinned ON tags(is_pinned)`);
      db.exec(`CREATE INDEX idx_tags_usage ON tags(usage_count DESC)`);
      db.exec(`CREATE INDEX idx_session_tags_session ON session_tags(session_id)`);
      db.exec(`CREATE INDEX idx_session_tags_tag ON session_tags(tag_id)`);
      db.exec(`CREATE INDEX idx_suggestions_session ON tag_suggestions(session_id)`);
      db.exec(`CREATE INDEX idx_suggestions_status ON tag_suggestions(status)`);
      db.exec(`CREATE INDEX idx_sessions_scan_status ON sessions(suggestion_scan_status)`);

      // Calculate initial usage_count
      db.exec(`
        UPDATE tags SET usage_count = (
          SELECT COUNT(*) FROM session_tags WHERE session_tags.tag_id = tags.id
        )
      `);
    },
  },
  {
    version: 3,
    description: 'Add per-tool token/cost attribution and deduplication support to tool_usage_detailed',
    up: (db) => {
      // Add token tracking columns
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN input_tokens INTEGER DEFAULT 0`);
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN output_tokens INTEGER DEFAULT 0`);
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN cache_write_tokens INTEGER DEFAULT 0`);
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`);
      
      // Add cost tracking
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN cost_usd REAL DEFAULT 0`);
      
      // Add metadata columns
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN message_id TEXT`);
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN request_id TEXT`);
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN entry_hash TEXT`);
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN tool_index INTEGER DEFAULT 0`);
      db.exec(`ALTER TABLE tool_usage_detailed ADD COLUMN model TEXT`);

      // Create unique index for deduplication
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_usage_detailed_dedup 
        ON tool_usage_detailed(session_id, entry_hash, tool_index)
      `);

      // Create index for efficient message queries
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tool_usage_detailed_message 
        ON tool_usage_detailed(session_id, message_id)
      `);
    },
    down: (db) => {
      // Drop indexes
      db.exec(`DROP INDEX IF EXISTS idx_tool_usage_detailed_dedup`);
      db.exec(`DROP INDEX IF EXISTS idx_tool_usage_detailed_message`);
      
      // SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
      db.exec(`
        CREATE TABLE tool_usage_detailed_backup AS SELECT
          id, session_id, tool_name, tool_input, tool_result_preview,
          success, duration_ms, token_cost, timestamp
        FROM tool_usage_detailed
      `);
      db.exec(`DROP TABLE tool_usage_detailed`);
      db.exec(`
        CREATE TABLE tool_usage_detailed (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          tool_name TEXT NOT NULL,
          tool_input TEXT,
          tool_result_preview TEXT,
          success INTEGER,
          duration_ms INTEGER,
          token_cost INTEGER,
          timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);
      db.exec(`INSERT INTO tool_usage_detailed SELECT * FROM tool_usage_detailed_backup`);
      db.exec(`DROP TABLE tool_usage_detailed_backup`);
      
      // Recreate original indexes
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_usage_detailed_session ON tool_usage_detailed(session_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_usage_detailed_tool ON tool_usage_detailed(tool_name)`);
    },
  },
];

// ============================================================================
// MIGRATION HELPERS
// ============================================================================

/**
 * Checks if a specific migration has been applied
 * @param db - The database instance
 * @param version - The migration version to check
 * @returns true if the migration has been applied
 */
export function hasMigration(db: Database.Database, version: number): boolean {
  ensureSchemaVersionsTable(db);

  const row = db.prepare(`
    SELECT 1 FROM schema_versions WHERE version = ?
  `).get(version);

  return row !== undefined;
}

/**
 * Gets information about pending migrations
 * @param db - The database instance
 * @param migrations - Array of available migrations
 * @returns Array of migrations that haven't been applied yet
 */
export function getPendingMigrations(
  db: Database.Database,
  migrations: Migration[]
): Migration[] {
  const currentVersion = getCurrentVersion(db);
  return migrations.filter(m => m.version > currentVersion).sort((a, b) => a.version - b.version);
}
