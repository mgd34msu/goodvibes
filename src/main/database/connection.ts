// ============================================================================
// DATABASE CONNECTION - Shared database connection management
// ============================================================================
//
// This module provides the core database connection functionality.
// It is designed to have NO dependencies on other database modules to avoid
// circular imports. All database modules should import getDatabase() from here.
//
// ============================================================================

import Database from 'better-sqlite3';

let db: Database.Database | null = null;

/**
 * Set the database instance. Called by initDatabase() in index.ts.
 * This allows the connection to be initialized without creating circular dependencies.
 */
export function setDatabaseInstance(database: Database.Database): void {
  db = database;
}

/**
 * Get the database instance.
 * Throws if the database has not been initialized.
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

/**
 * Clear the database instance. Called by closeDatabase() in index.ts.
 */
export function clearDatabaseInstance(): void {
  db = null;
}

/**
 * Check if the database is initialized.
 */
export function isDatabaseInitialized(): boolean {
  return db !== null;
}
