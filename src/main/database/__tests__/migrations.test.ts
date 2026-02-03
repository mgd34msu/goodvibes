// ============================================================================
// DATABASE MIGRATIONS TESTS
// ============================================================================
//
// These tests verify the database migration system's correctness and safety.
// Migrations must be idempotent, reversible, and handle errors gracefully.
//
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  rollbackMigrations,
  getCurrentVersion,
  hasMigration,
  getPendingMigrations,
  getMigrationHistory,
  type Migration,
} from '../migrations.js';

// Mock the logger
vi.mock('../../services/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
  },
}));

// ============================================================================
// TEST SETUP
// ============================================================================

/**
 * Creates an in-memory database for testing
 */
function createTestDatabase(): Database.Database {
  return new Database(':memory:');
}

/**
 * Sample migrations for testing
 */
const testMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create users table',
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL
        )
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS users');
    },
  },
  {
    version: 2,
    description: 'Add age column to users',
    up: (db) => {
      db.exec('ALTER TABLE users ADD COLUMN age INTEGER');
    },
    down: (db) => {
      // SQLite doesn't support DROP COLUMN, so recreate table
      db.exec(`
        CREATE TABLE users_backup AS SELECT id, name, email FROM users;
        DROP TABLE users;
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL
        );
        INSERT INTO users SELECT * FROM users_backup;
        DROP TABLE users_backup;
      `);
    },
  },
  {
    version: 3,
    description: 'Create posts table',
    up: (db) => {
      db.exec(`
        CREATE TABLE posts (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS posts');
    },
  },
];

// ============================================================================
// getCurrentVersion TESTS
// ============================================================================

describe('getCurrentVersion', () => {
  it('returns 0 for new database', () => {
    const db = createTestDatabase();
    expect(getCurrentVersion(db)).toBe(0);
    db.close();
  });

  it('returns correct version after migrations', () => {
    const db = createTestDatabase();
    runMigrations(db, [testMigrations[0]]);
    expect(getCurrentVersion(db)).toBe(1);
    db.close();
  });

  it('creates schema_versions table if not exists', () => {
    const db = createTestDatabase();
    getCurrentVersion(db);
    
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'")
      .get();
    
    expect(tableExists).toBeDefined();
    db.close();
  });
});

// ============================================================================
// runMigrations TESTS
// ============================================================================

describe('runMigrations', () => {
  describe('should apply migrations in order', () => {
    it('applies single migration', () => {
      const db = createTestDatabase();
      const count = runMigrations(db, [testMigrations[0]]);
      
      expect(count).toBe(1);
      expect(getCurrentVersion(db)).toBe(1);
      
      // Verify table was created
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .get();
      expect(tableExists).toBeDefined();
      
      db.close();
    });

    it('applies multiple migrations in version order', () => {
      const db = createTestDatabase();
      const count = runMigrations(db, testMigrations);
      
      expect(count).toBe(3);
      expect(getCurrentVersion(db)).toBe(3);
      
      // Verify all tables were created
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('posts');
      expect(tableNames).toContain('schema_versions');
      
      db.close();
    });

    it('applies migrations out-of-order input correctly', () => {
      const db = createTestDatabase();
      const shuffled = [testMigrations[2], testMigrations[0], testMigrations[1]];
      const count = runMigrations(db, shuffled);
      
      expect(count).toBe(3);
      expect(getCurrentVersion(db)).toBe(3);
      db.close();
    });
  });

  describe('should be idempotent', () => {
    it('does not reapply already applied migrations', () => {
      const db = createTestDatabase();
      
      const count1 = runMigrations(db, [testMigrations[0]]);
      expect(count1).toBe(1);
      
      const count2 = runMigrations(db, [testMigrations[0]]);
      expect(count2).toBe(0);
      expect(getCurrentVersion(db)).toBe(1);
      
      db.close();
    });

    it('only applies pending migrations', () => {
      const db = createTestDatabase();
      
      runMigrations(db, [testMigrations[0], testMigrations[1]]);
      expect(getCurrentVersion(db)).toBe(2);
      
      const count = runMigrations(db, testMigrations);
      expect(count).toBe(1); // Only migration 3 should be applied
      expect(getCurrentVersion(db)).toBe(3);
      
      db.close();
    });
  });

  describe('should handle target versions', () => {
    it('applies migrations up to target version', () => {
      const db = createTestDatabase();
      const count = runMigrations(db, testMigrations, 2);
      
      expect(count).toBe(2);
      expect(getCurrentVersion(db)).toBe(2);
      
      // Verify only first two migrations applied
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'")
        .get();
      expect(tableExists).toBeUndefined();
      
      db.close();
    });

    it('does nothing when target version equals current version', () => {
      const db = createTestDatabase();
      runMigrations(db, testMigrations, 2);
      
      const count = runMigrations(db, testMigrations, 2);
      expect(count).toBe(0);
      expect(getCurrentVersion(db)).toBe(2);
      
      db.close();
    });

    it('does nothing when target version is less than current version', () => {
      const db = createTestDatabase();
      runMigrations(db, testMigrations, 3);
      
      const count = runMigrations(db, testMigrations, 1);
      expect(count).toBe(0);
      expect(getCurrentVersion(db)).toBe(3);
      
      db.close();
    });
  });

  describe('should handle errors', () => {
    it('throws error when migration fails', () => {
      const db = createTestDatabase();
      const badMigration: Migration = {
        version: 1,
        description: 'Bad migration',
        up: () => {
          throw new Error('Migration failed');
        },
      };
      
      expect(() => runMigrations(db, [badMigration])).toThrow('Migration 1 failed');
      expect(getCurrentVersion(db)).toBe(0); // Should not record failed migration
      
      db.close();
    });

    it('rolls back transaction on migration failure', () => {
      const db = createTestDatabase();
      const badMigration: Migration = {
        version: 1,
        description: 'Partially failing migration',
        up: (db) => {
          db.exec('CREATE TABLE temp_table (id INTEGER)');
          throw new Error('Intentional failure');
        },
      };
      
      expect(() => runMigrations(db, [badMigration])).toThrow();
      
      // Verify table was rolled back
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temp_table'")
        .get();
      expect(tableExists).toBeUndefined();
      
      db.close();
    });

    it('stops applying migrations after first failure', () => {
      const db = createTestDatabase();
      const badMigration: Migration = {
        version: 2,
        description: 'Bad migration',
        up: () => {
          throw new Error('Migration failed');
        },
      };
      
      const migrations = [testMigrations[0], badMigration, testMigrations[2]];
      
      expect(() => runMigrations(db, migrations)).toThrow();
      expect(getCurrentVersion(db)).toBe(1); // Only first migration succeeded
      
      db.close();
    });
  });

  describe('should handle edge cases', () => {
    it('handles empty migration list', () => {
      const db = createTestDatabase();
      const count = runMigrations(db, []);
      
      expect(count).toBe(0);
      expect(getCurrentVersion(db)).toBe(0);
      
      db.close();
    });

    it('records migration in schema_versions table', () => {
      const db = createTestDatabase();
      runMigrations(db, [testMigrations[0]]);
      
      const record = db
        .prepare('SELECT version, description FROM schema_versions WHERE version = 1')
        .get() as { version: number; description: string } | undefined;
      
      expect(record).toBeDefined();
      expect(record?.version).toBe(1);
      expect(record?.description).toBe('Create users table');
      
      db.close();
    });
  });
});

// ============================================================================
// rollbackMigrations TESTS
// ============================================================================

describe('rollbackMigrations', () => {
  describe('should roll back migrations correctly', () => {
    it('rolls back single migration', () => {
      const db = createTestDatabase();
      runMigrations(db, [testMigrations[0]]);
      expect(getCurrentVersion(db)).toBe(1);
      
      const count = rollbackMigrations(db, [testMigrations[0]], 0);
      expect(count).toBe(1);
      expect(getCurrentVersion(db)).toBe(0);
      
      // Verify table was dropped
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .get();
      expect(tableExists).toBeUndefined();
      
      db.close();
    });

    it('rolls back multiple migrations in reverse order', () => {
      const db = createTestDatabase();
      runMigrations(db, testMigrations);
      expect(getCurrentVersion(db)).toBe(3);
      
      const count = rollbackMigrations(db, testMigrations, 0);
      expect(count).toBe(3);
      expect(getCurrentVersion(db)).toBe(0);
      
      db.close();
    });

    it('rolls back to target version', () => {
      const db = createTestDatabase();
      runMigrations(db, testMigrations);
      expect(getCurrentVersion(db)).toBe(3);
      
      const count = rollbackMigrations(db, testMigrations, 1);
      expect(count).toBe(2); // Roll back migrations 3 and 2
      expect(getCurrentVersion(db)).toBe(1);
      
      // Verify posts table was dropped but users table remains
      const postsExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'")
        .get();
      const usersExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .get();
      
      expect(postsExists).toBeUndefined();
      expect(usersExists).toBeDefined();
      
      db.close();
    });
  });

  describe('should handle migrations without down functions', () => {
    it('skips migrations without down function', () => {
      const db = createTestDatabase();
      const migrationWithoutDown: Migration = {
        version: 1,
        description: 'No rollback',
        up: (db) => {
          db.exec('CREATE TABLE test (id INTEGER)');
        },
        // No down function
      };
      
      runMigrations(db, [migrationWithoutDown]);
      expect(getCurrentVersion(db)).toBe(1);
      
      const count = rollbackMigrations(db, [migrationWithoutDown], 0);
      expect(count).toBe(0); // No rollback performed
      expect(getCurrentVersion(db)).toBe(1); // Version unchanged
      
      db.close();
    });
  });

  describe('should handle edge cases', () => {
    it('does nothing when target version equals current version', () => {
      const db = createTestDatabase();
      runMigrations(db, testMigrations, 2);
      
      const count = rollbackMigrations(db, testMigrations, 2);
      expect(count).toBe(0);
      expect(getCurrentVersion(db)).toBe(2);
      
      db.close();
    });

    it('does nothing when target version is greater than current version', () => {
      const db = createTestDatabase();
      runMigrations(db, [testMigrations[0]]);
      
      const count = rollbackMigrations(db, testMigrations, 5);
      expect(count).toBe(0);
      expect(getCurrentVersion(db)).toBe(1);
      
      db.close();
    });

    it('removes migration records from schema_versions', () => {
      const db = createTestDatabase();
      runMigrations(db, [testMigrations[0]]);
      
      rollbackMigrations(db, [testMigrations[0]], 0);
      
      const record = db
        .prepare('SELECT * FROM schema_versions WHERE version = 1')
        .get();
      
      expect(record).toBeUndefined();
      
      db.close();
    });
  });

  describe('should handle errors during rollback', () => {
    it('throws error when rollback fails', () => {
      const db = createTestDatabase();
      const badRollback: Migration = {
        version: 1,
        description: 'Bad rollback',
        up: (db) => {
          db.exec('CREATE TABLE test (id INTEGER)');
        },
        down: () => {
          throw new Error('Rollback failed');
        },
      };
      
      runMigrations(db, [badRollback]);
      
      expect(() => rollbackMigrations(db, [badRollback], 0)).toThrow('Rollback of migration 1 failed');
      
      db.close();
    });

    it('maintains database consistency on rollback failure', () => {
      const db = createTestDatabase();
      const badRollback: Migration = {
        version: 1,
        description: 'Bad rollback',
        up: (db) => {
          db.exec('CREATE TABLE test (id INTEGER)');
        },
        down: () => {
          throw new Error('Rollback failed');
        },
      };
      
      runMigrations(db, [badRollback]);
      const versionBefore = getCurrentVersion(db);
      
      expect(() => rollbackMigrations(db, [badRollback], 0)).toThrow();
      
      // Version should be unchanged after failed rollback
      expect(getCurrentVersion(db)).toBe(versionBefore);
      
      db.close();
    });
  });
});

// ============================================================================
// hasMigration TESTS
// ============================================================================

describe('hasMigration', () => {
  it('returns false for unapplied migration', () => {
    const db = createTestDatabase();
    expect(hasMigration(db, 1)).toBe(false);
    db.close();
  });

  it('returns true for applied migration', () => {
    const db = createTestDatabase();
    runMigrations(db, [testMigrations[0]]);
    expect(hasMigration(db, 1)).toBe(true);
    db.close();
  });

  it('returns false for non-existent version', () => {
    const db = createTestDatabase();
    runMigrations(db, [testMigrations[0]]);
    expect(hasMigration(db, 999)).toBe(false);
    db.close();
  });
});

// ============================================================================
// getPendingMigrations TESTS
// ============================================================================

describe('getPendingMigrations', () => {
  it('returns all migrations for new database', () => {
    const db = createTestDatabase();
    const pending = getPendingMigrations(db, testMigrations);
    expect(pending).toHaveLength(3);
    expect(pending.map(m => m.version)).toEqual([1, 2, 3]);
    db.close();
  });

  it('returns only unapplied migrations', () => {
    const db = createTestDatabase();
    runMigrations(db, [testMigrations[0], testMigrations[1]]);
    
    const pending = getPendingMigrations(db, testMigrations);
    expect(pending).toHaveLength(1);
    expect(pending[0].version).toBe(3);
    db.close();
  });

  it('returns empty array when all migrations applied', () => {
    const db = createTestDatabase();
    runMigrations(db, testMigrations);
    
    const pending = getPendingMigrations(db, testMigrations);
    expect(pending).toHaveLength(0);
    db.close();
  });

  it('returns migrations in version order', () => {
    const db = createTestDatabase();
    const shuffled = [testMigrations[2], testMigrations[0], testMigrations[1]];
    
    const pending = getPendingMigrations(db, shuffled);
    expect(pending.map(m => m.version)).toEqual([1, 2, 3]);
    db.close();
  });
});

// ============================================================================
// getMigrationHistory TESTS
// ============================================================================

describe('getMigrationHistory', () => {
  it('returns empty array for new database', () => {
    const db = createTestDatabase();
    const history = getMigrationHistory(db);
    expect(history).toHaveLength(0);
    db.close();
  });

  it('returns history of applied migrations', () => {
    const db = createTestDatabase();
    runMigrations(db, testMigrations);
    
    const history = getMigrationHistory(db);
    expect(history).toHaveLength(3);
    expect(history[0].version).toBe(1);
    expect(history[1].version).toBe(2);
    expect(history[2].version).toBe(3);
    db.close();
  });

  it('includes timestamps and descriptions', () => {
    const db = createTestDatabase();
    runMigrations(db, [testMigrations[0]]);
    
    const history = getMigrationHistory(db);
    expect(history[0].description).toBe('Create users table');
    expect(history[0].applied_at).toBeDefined();
    expect(typeof history[0].applied_at).toBe('string');
    db.close();
  });

  it('returns migrations in version order', () => {
    const db = createTestDatabase();
    runMigrations(db, testMigrations);
    
    const history = getMigrationHistory(db);
    const versions = history.map(h => h.version);
    expect(versions).toEqual([1, 2, 3]);
    db.close();
  });
});
