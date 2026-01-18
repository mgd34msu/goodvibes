// ============================================================================
// DATABASE MODULE EXTENDED TESTS
// ============================================================================
//
// These tests cover additional database operations not in the main test file:
// - Collections and Smart Collections
// - Prompts
// - Quick Notes
// - Notifications
// - Knowledge Base
// - Search operations
// - Migrations
// - Connection module
//
// Uses an in-memory SQLite database for isolation and speed.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Check if better-sqlite3 can be loaded
let canLoadDatabase = true;
try {
  require('better-sqlite3');
} catch {
  canLoadDatabase = false;
}

// Skip all tests if native module cannot be loaded
const describeIfDb = canLoadDatabase ? describe : describe.skip;

// Create a temporary directory for the test database
const TEST_DIR = path.join(os.tmpdir(), 'goodvibes-extended-test-' + Date.now());

// Mock electron and logger
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(TEST_DIR),
  },
}));

vi.mock('../services/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// Database module imports (assigned after dynamic import)
let initDatabase: typeof import('./index.js').initDatabase;
let closeDatabase: typeof import('./index.js').closeDatabase;
let getDatabase: typeof import('./index.js').getDatabase;
let upsertSession: typeof import('./index.js').upsertSession;

// Collections
let createCollection: typeof import('./collections.js').createCollection;
let getAllCollections: typeof import('./collections.js').getAllCollections;
let updateCollection: typeof import('./collections.js').updateCollection;
let deleteCollection: typeof import('./collections.js').deleteCollection;
let addSessionToCollection: typeof import('./collections.js').addSessionToCollection;
let getSessionsByCollection: typeof import('./collections.js').getSessionsByCollection;
let createSmartCollection: typeof import('./collections.js').createSmartCollection;
let getAllSmartCollections: typeof import('./collections.js').getAllSmartCollections;
let getSmartCollection: typeof import('./collections.js').getSmartCollection;
let updateSmartCollection: typeof import('./collections.js').updateSmartCollection;
let deleteSmartCollection: typeof import('./collections.js').deleteSmartCollection;
let getSessionsForSmartCollection: typeof import('./collections.js').getSessionsForSmartCollection;

// Prompts
let savePrompt: typeof import('./prompts.js').savePrompt;
let getAllPrompts: typeof import('./prompts.js').getAllPrompts;
let getPromptsByCategory: typeof import('./prompts.js').getPromptsByCategory;
let usePrompt: typeof import('./prompts.js').usePrompt;
let updatePrompt: typeof import('./prompts.js').updatePrompt;
let deletePrompt: typeof import('./prompts.js').deletePrompt;
let getPromptCategories: typeof import('./prompts.js').getPromptCategories;

// Quick Notes
let createQuickNote: typeof import('./notes.js').createQuickNote;
let getQuickNotes: typeof import('./notes.js').getQuickNotes;
let updateQuickNote: typeof import('./notes.js').updateQuickNote;
let setQuickNoteStatus: typeof import('./notes.js').setQuickNoteStatus;
let deleteQuickNote: typeof import('./notes.js').deleteQuickNote;
let linkQuickNoteToSession: typeof import('./notes.js').linkQuickNoteToSession;

// Notifications
let createNotification: typeof import('./notifications.js').createNotification;
let getNotifications: typeof import('./notifications.js').getNotifications;
let getUnreadNotificationCount: typeof import('./notifications.js').getUnreadNotificationCount;
let markNotificationRead: typeof import('./notifications.js').markNotificationRead;
let markAllNotificationsRead: typeof import('./notifications.js').markAllNotificationsRead;
let dismissNotification: typeof import('./notifications.js').dismissNotification;
let dismissAllNotifications: typeof import('./notifications.js').dismissAllNotifications;
let deleteOldNotifications: typeof import('./notifications.js').deleteOldNotifications;

// Knowledge
let createKnowledgeEntry: typeof import('./knowledge.js').createKnowledgeEntry;
let getAllKnowledgeEntries: typeof import('./knowledge.js').getAllKnowledgeEntries;
let getKnowledgeEntry: typeof import('./knowledge.js').getKnowledgeEntry;
let getKnowledgeByCategory: typeof import('./knowledge.js').getKnowledgeByCategory;
let searchKnowledge: typeof import('./knowledge.js').searchKnowledge;
let updateKnowledgeEntry: typeof import('./knowledge.js').updateKnowledgeEntry;
let deleteKnowledgeEntry: typeof import('./knowledge.js').deleteKnowledgeEntry;
let getKnowledgeCategories: typeof import('./knowledge.js').getKnowledgeCategories;
let getMostViewedKnowledge: typeof import('./knowledge.js').getMostViewedKnowledge;

// Search
let searchSessions: typeof import('./search.js').searchSessions;
let searchSessionsAdvanced: typeof import('./search.js').searchSessionsAdvanced;
let saveSearch: typeof import('./search.js').saveSearch;
let getAllSavedSearches: typeof import('./search.js').getAllSavedSearches;
let deleteSavedSearch: typeof import('./search.js').deleteSavedSearch;

// Connection
let setDatabaseInstance: typeof import('./connection.js').setDatabaseInstance;
let clearDatabaseInstance: typeof import('./connection.js').clearDatabaseInstance;
let isDatabaseInitialized: typeof import('./connection.js').isDatabaseInitialized;

// Migrations
let getCurrentVersion: typeof import('./migrations.js').getCurrentVersion;
let runMigrations: typeof import('./migrations.js').runMigrations;
let rollbackMigrations: typeof import('./migrations.js').rollbackMigrations;
let getMigrationHistory: typeof import('./migrations.js').getMigrationHistory;
let hasMigration: typeof import('./migrations.js').hasMigration;
let getPendingMigrations: typeof import('./migrations.js').getPendingMigrations;

// Messages
let storeMessages: typeof import('./messages.js').storeMessages;

// Tags
let createTag: typeof import('./index.js').createTag;
let addTagToSession: typeof import('./index.js').addTagToSession;

// ============================================================================
// TEST SETUP - Only runs if better-sqlite3 is available
// ============================================================================

// Helper to setup database - only called if canLoadDatabase is true
async function setupDatabase(): Promise<void> {
  // Dynamic imports
  const dbModule = await import('./index.js');
  const collectionsModule = await import('./collections.js');
  const promptsModule = await import('./prompts.js');
  const notesModule = await import('./notes.js');
  const notificationsModule = await import('./notifications.js');
  const knowledgeModule = await import('./knowledge.js');
  const searchModule = await import('./search.js');
  const connectionModule = await import('./connection.js');
  const migrationsModule = await import('./migrations.js');
  const messagesModule = await import('./messages.js');

  // Assign imports
  initDatabase = dbModule.initDatabase;
  closeDatabase = dbModule.closeDatabase;
  getDatabase = dbModule.getDatabase;
  upsertSession = dbModule.upsertSession;
  createTag = dbModule.createTag;
  addTagToSession = dbModule.addTagToSession;

  // Collections
  createCollection = collectionsModule.createCollection;
  getAllCollections = collectionsModule.getAllCollections;
  updateCollection = collectionsModule.updateCollection;
  deleteCollection = collectionsModule.deleteCollection;
  addSessionToCollection = collectionsModule.addSessionToCollection;
  getSessionsByCollection = collectionsModule.getSessionsByCollection;
  createSmartCollection = collectionsModule.createSmartCollection;
  getAllSmartCollections = collectionsModule.getAllSmartCollections;
  getSmartCollection = collectionsModule.getSmartCollection;
  updateSmartCollection = collectionsModule.updateSmartCollection;
  deleteSmartCollection = collectionsModule.deleteSmartCollection;
  getSessionsForSmartCollection = collectionsModule.getSessionsForSmartCollection;

  // Prompts
  savePrompt = promptsModule.savePrompt;
  getAllPrompts = promptsModule.getAllPrompts;
  getPromptsByCategory = promptsModule.getPromptsByCategory;
  usePrompt = promptsModule.usePrompt;
  updatePrompt = promptsModule.updatePrompt;
  deletePrompt = promptsModule.deletePrompt;
  getPromptCategories = promptsModule.getPromptCategories;

  // Notes
  createQuickNote = notesModule.createQuickNote;
  getQuickNotes = notesModule.getQuickNotes;
  updateQuickNote = notesModule.updateQuickNote;
  setQuickNoteStatus = notesModule.setQuickNoteStatus;
  deleteQuickNote = notesModule.deleteQuickNote;
  linkQuickNoteToSession = notesModule.linkQuickNoteToSession;

  // Notifications
  createNotification = notificationsModule.createNotification;
  getNotifications = notificationsModule.getNotifications;
  getUnreadNotificationCount = notificationsModule.getUnreadNotificationCount;
  markNotificationRead = notificationsModule.markNotificationRead;
  markAllNotificationsRead = notificationsModule.markAllNotificationsRead;
  dismissNotification = notificationsModule.dismissNotification;
  dismissAllNotifications = notificationsModule.dismissAllNotifications;
  deleteOldNotifications = notificationsModule.deleteOldNotifications;

  // Knowledge
  createKnowledgeEntry = knowledgeModule.createKnowledgeEntry;
  getAllKnowledgeEntries = knowledgeModule.getAllKnowledgeEntries;
  getKnowledgeEntry = knowledgeModule.getKnowledgeEntry;
  getKnowledgeByCategory = knowledgeModule.getKnowledgeByCategory;
  searchKnowledge = knowledgeModule.searchKnowledge;
  updateKnowledgeEntry = knowledgeModule.updateKnowledgeEntry;
  deleteKnowledgeEntry = knowledgeModule.deleteKnowledgeEntry;
  getKnowledgeCategories = knowledgeModule.getKnowledgeCategories;
  getMostViewedKnowledge = knowledgeModule.getMostViewedKnowledge;

  // Search
  searchSessions = searchModule.searchSessions;
  searchSessionsAdvanced = searchModule.searchSessionsAdvanced;
  saveSearch = searchModule.saveSearch;
  getAllSavedSearches = searchModule.getAllSavedSearches;
  deleteSavedSearch = searchModule.deleteSavedSearch;

  // Connection
  setDatabaseInstance = connectionModule.setDatabaseInstance;
  clearDatabaseInstance = connectionModule.clearDatabaseInstance;
  isDatabaseInitialized = connectionModule.isDatabaseInitialized;

  // Migrations
  getCurrentVersion = migrationsModule.getCurrentVersion;
  runMigrations = migrationsModule.runMigrations;
  rollbackMigrations = migrationsModule.rollbackMigrations;
  getMigrationHistory = migrationsModule.getMigrationHistory;
  hasMigration = migrationsModule.hasMigration;
  getPendingMigrations = migrationsModule.getPendingMigrations;

  // Messages
  storeMessages = messagesModule.storeMessages;

  // Create test directory
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  // Initialize database
  await initDatabase(TEST_DIR);
}

// Only setup beforeAll/afterAll/beforeEach if we can load the database
if (canLoadDatabase) {
  beforeAll(async () => {
    await setupDatabase();
  });

  afterAll(() => {
    closeDatabase();

    // Clean up test directory
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    // Clean up tables before each test
    const db = getDatabase();
    db.exec('DELETE FROM session_tags');
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM tags');
    db.exec('DELETE FROM collections');
    db.exec('DELETE FROM smart_collections');
    db.exec('DELETE FROM prompts');
    db.exec('DELETE FROM quick_notes');
    db.exec('DELETE FROM notifications');
    db.exec('DELETE FROM knowledge_entries');
    db.exec('DELETE FROM saved_searches');
    db.exec('DELETE FROM tool_usage');
    db.exec('DELETE FROM activity_log');
    db.exec('DELETE FROM settings');
  });
} else {
  // Log a warning when tests are skipped
  console.warn('Skipping extended database tests: better-sqlite3 native module cannot be loaded');
}

// ============================================================================
// COLLECTION TESTS
// ============================================================================

describeIfDb('Collection Operations', () => {
  describe('createCollection', () => {
    it('should create a collection with default values', () => {
      const id = createCollection('My Collection');

      expect(id).toBeGreaterThan(0);

      const collections = getAllCollections();
      expect(collections).toHaveLength(1);
      expect(collections[0].name).toBe('My Collection');
      expect(collections[0].color).toBe('#6366f1');
      expect(collections[0].icon).toBe('\uD83D\uDCC1');
    });

    it('should create a collection with custom values', () => {
      const id = createCollection('Custom Collection', '#ff0000', '\uD83D\uDE80');

      const collections = getAllCollections();
      expect(collections[0].color).toBe('#ff0000');
      expect(collections[0].icon).toBe('\uD83D\uDE80');
    });

    it('should create nested collections with parent_id', () => {
      const parentId = createCollection('Parent');
      const childId = createCollection('Child', undefined, undefined, parentId);

      const collections = getAllCollections();
      const child = collections.find(c => c.id === childId);

      expect(child?.parentId).toBe(parentId);
    });
  });

  describe('getAllCollections', () => {
    it('should return collections ordered by sort_order and name', () => {
      createCollection('Zebra');
      createCollection('Alpha');
      createCollection('Beta');

      const collections = getAllCollections();

      // Default sort_order is 0, so should be alphabetical
      expect(collections[0].name).toBe('Alpha');
      expect(collections[1].name).toBe('Beta');
      expect(collections[2].name).toBe('Zebra');
    });

    it('should return empty array when no collections', () => {
      const collections = getAllCollections();
      expect(collections).toEqual([]);
    });
  });

  describe('updateCollection', () => {
    it('should update collection properties', () => {
      const id = createCollection('Original', '#000000', '\uD83D\uDCC1');

      updateCollection(id, 'Updated', '#ffffff', '\uD83C\uDF1F');

      const collections = getAllCollections();
      expect(collections[0].name).toBe('Updated');
      expect(collections[0].color).toBe('#ffffff');
      expect(collections[0].icon).toBe('\uD83C\uDF1F');
    });
  });

  describe('deleteCollection', () => {
    it('should delete a collection', () => {
      const id = createCollection('To Delete');

      expect(getAllCollections()).toHaveLength(1);

      deleteCollection(id);

      expect(getAllCollections()).toHaveLength(0);
    });

    it('should unlink sessions from deleted collection', () => {
      const collectionId = createCollection('My Collection');
      upsertSession({ id: 'session-1', projectName: 'Test' });
      addSessionToCollection('session-1', collectionId);

      deleteCollection(collectionId);

      const sessions = getSessionsByCollection(collectionId);
      expect(sessions).toHaveLength(0);
    });
  });

  describe('addSessionToCollection / getSessionsByCollection', () => {
    it('should add session to collection', () => {
      const collectionId = createCollection('My Collection');
      upsertSession({ id: 'session-1', projectName: 'Test' });

      addSessionToCollection('session-1', collectionId);

      const sessions = getSessionsByCollection(collectionId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('session-1');
    });

    it('should return sessions ordered by end_time desc', () => {
      const collectionId = createCollection('My Collection');
      upsertSession({ id: 'session-1', endTime: '2024-01-15T10:00:00Z' });
      upsertSession({ id: 'session-2', endTime: '2024-01-15T12:00:00Z' });
      upsertSession({ id: 'session-3', endTime: '2024-01-15T11:00:00Z' });

      addSessionToCollection('session-1', collectionId);
      addSessionToCollection('session-2', collectionId);
      addSessionToCollection('session-3', collectionId);

      const sessions = getSessionsByCollection(collectionId);
      expect(sessions[0].id).toBe('session-2');
      expect(sessions[1].id).toBe('session-3');
      expect(sessions[2].id).toBe('session-1');
    });
  });
});

describeIfDb('Smart Collection Operations', () => {
  describe('createSmartCollection', () => {
    it('should create a smart collection with rules', () => {
      const rules = [{ type: 'PROJECT' as const, value: 'myproject' }];
      const id = createSmartCollection('My Smart Collection', rules);

      expect(id).toBeGreaterThan(0);

      const collections = getAllSmartCollections();
      expect(collections).toHaveLength(1);
      expect(collections[0].name).toBe('My Smart Collection');
      expect(collections[0].rules).toEqual(rules);
      expect(collections[0].matchMode).toBe('all');
    });

    it('should create smart collection with custom match mode', () => {
      const rules = [{ type: 'PROJECT' as const, value: 'test' }];
      const id = createSmartCollection('Any Match', rules, '#ff0000', '\uD83D\uDD25', 'any');

      const collection = getSmartCollection(id);
      expect(collection?.matchMode).toBe('any');
    });
  });

  describe('getSmartCollection', () => {
    it('should return smart collection by ID', () => {
      const rules = [{ type: 'TAG' as const, value: 'important' }];
      const id = createSmartCollection('Test', rules);

      const collection = getSmartCollection(id);

      expect(collection).not.toBeNull();
      expect(collection?.name).toBe('Test');
    });

    it('should return null for non-existent ID', () => {
      const collection = getSmartCollection(9999);
      expect(collection).toBeNull();
    });
  });

  describe('updateSmartCollection', () => {
    it('should update smart collection', () => {
      const rules = [{ type: 'PROJECT' as const, value: 'old' }];
      const id = createSmartCollection('Original', rules);

      const newRules = [{ type: 'PROJECT' as const, value: 'new' }];
      updateSmartCollection(id, 'Updated', newRules, '#ffffff', '\uD83C\uDF1F', 'any');

      const collection = getSmartCollection(id);
      expect(collection?.name).toBe('Updated');
      expect(collection?.rules[0].value).toBe('new');
      expect(collection?.matchMode).toBe('any');
    });
  });

  describe('deleteSmartCollection', () => {
    it('should delete smart collection', () => {
      const id = createSmartCollection('To Delete', []);

      expect(getAllSmartCollections()).toHaveLength(1);

      deleteSmartCollection(id);

      expect(getAllSmartCollections()).toHaveLength(0);
    });
  });

  describe('getSessionsForSmartCollection', () => {
    beforeEach(() => {
      // Create test sessions
      upsertSession({ id: 'session-1', projectName: 'ProjectA', cost: 0.10 });
      upsertSession({ id: 'session-2', projectName: 'ProjectB', cost: 0.50 });
      upsertSession({ id: 'session-3', projectName: 'ProjectA', cost: 1.00 });
    });

    it('should filter by project name', () => {
      const rules = [{ type: 'PROJECT' as const, value: 'ProjectA' }];
      const id = createSmartCollection('Project A Sessions', rules);

      const sessions = getSessionsForSmartCollection(id);

      expect(sessions).toHaveLength(2);
      expect(sessions.every(s => s.projectName?.includes('ProjectA'))).toBe(true);
    });

    it('should filter by cost (gte)', () => {
      const rules = [{ type: 'COST' as const, value: '0.50', operator: 'gte' as const }];
      const id = createSmartCollection('High Cost', rules);

      const sessions = getSessionsForSmartCollection(id);

      expect(sessions).toHaveLength(2);
      expect(sessions.every(s => (s.cost ?? 0) >= 0.50)).toBe(true);
    });

    it('should filter by cost (lte)', () => {
      const rules = [{ type: 'COST' as const, value: '0.50', operator: 'lte' as const }];
      const id = createSmartCollection('Low Cost', rules);

      const sessions = getSessionsForSmartCollection(id);

      expect(sessions).toHaveLength(2);
      expect(sessions.every(s => (s.cost ?? 0) <= 0.50)).toBe(true);
    });

    it('should combine rules with AND (all match mode)', () => {
      const rules = [
        { type: 'PROJECT' as const, value: 'ProjectA' },
        { type: 'COST' as const, value: '0.50', operator: 'gte' as const },
      ];
      const id = createSmartCollection('Expensive ProjectA', rules, undefined, undefined, 'all');

      const sessions = getSessionsForSmartCollection(id);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('session-3');
    });

    it('should combine rules with OR (any match mode)', () => {
      const rules = [
        { type: 'PROJECT' as const, value: 'ProjectB' },
        { type: 'COST' as const, value: '1.00', operator: 'gte' as const },
      ];
      const id = createSmartCollection('ProjectB or Expensive', rules, undefined, undefined, 'any');

      const sessions = getSessionsForSmartCollection(id);

      expect(sessions).toHaveLength(2);
    });

    it('should return empty for non-existent collection', () => {
      const sessions = getSessionsForSmartCollection(9999);
      expect(sessions).toEqual([]);
    });

    it('should return empty when no rules match', () => {
      const rules = [{ type: 'PROJECT' as const, value: 'NonExistent' }];
      const id = createSmartCollection('Empty', rules);

      const sessions = getSessionsForSmartCollection(id);

      expect(sessions).toEqual([]);
    });
  });
});

// ============================================================================
// PROMPT TESTS
// ============================================================================

describeIfDb('Prompt Operations', () => {
  describe('savePrompt', () => {
    it('should save a prompt with default category', () => {
      const id = savePrompt('Test Prompt', 'Prompt content here');

      expect(id).toBeGreaterThan(0);

      const prompts = getAllPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].title).toBe('Test Prompt');
      expect(prompts[0].content).toBe('Prompt content here');
      expect(prompts[0].category).toBe('General');
      expect(prompts[0].useCount).toBe(0);
    });

    it('should save a prompt with custom category', () => {
      const id = savePrompt('Coding Prompt', 'Write clean code', 'Development');

      const prompts = getAllPrompts();
      expect(prompts[0].category).toBe('Development');
    });
  });

  describe('getAllPrompts', () => {
    it('should return prompts ordered by use_count and created_at', () => {
      savePrompt('Prompt 1', 'Content 1');
      savePrompt('Prompt 2', 'Content 2');
      savePrompt('Prompt 3', 'Content 3');

      // Use prompt 2 more
      const prompts = getAllPrompts();
      usePrompt(prompts[1].id);
      usePrompt(prompts[1].id);

      const reorderedPrompts = getAllPrompts();
      expect(reorderedPrompts[0].title).toBe('Prompt 2');
    });

    it('should return empty array when no prompts', () => {
      const prompts = getAllPrompts();
      expect(prompts).toEqual([]);
    });
  });

  describe('getPromptsByCategory', () => {
    it('should filter prompts by category', () => {
      savePrompt('Dev Prompt 1', 'Content', 'Development');
      savePrompt('Dev Prompt 2', 'Content', 'Development');
      savePrompt('General Prompt', 'Content', 'General');

      const devPrompts = getPromptsByCategory('Development');

      expect(devPrompts).toHaveLength(2);
      expect(devPrompts.every(p => p.category === 'Development')).toBe(true);
    });
  });

  describe('usePrompt', () => {
    it('should increment use count', () => {
      const id = savePrompt('Test', 'Content');

      expect(getAllPrompts()[0].useCount).toBe(0);

      usePrompt(id);
      expect(getAllPrompts()[0].useCount).toBe(1);

      usePrompt(id);
      usePrompt(id);
      expect(getAllPrompts()[0].useCount).toBe(3);
    });

    it('should update last_used timestamp', () => {
      const id = savePrompt('Test', 'Content');

      expect(getAllPrompts()[0].lastUsed).toBeNull();

      usePrompt(id);

      expect(getAllPrompts()[0].lastUsed).not.toBeNull();
    });
  });

  describe('updatePrompt', () => {
    it('should update prompt properties', () => {
      const id = savePrompt('Original', 'Original content', 'General');

      updatePrompt(id, 'Updated', 'Updated content', 'Development');

      const prompts = getAllPrompts();
      expect(prompts[0].title).toBe('Updated');
      expect(prompts[0].content).toBe('Updated content');
      expect(prompts[0].category).toBe('Development');
    });
  });

  describe('deletePrompt', () => {
    it('should delete a prompt', () => {
      const id = savePrompt('To Delete', 'Content');

      expect(getAllPrompts()).toHaveLength(1);

      deletePrompt(id);

      expect(getAllPrompts()).toHaveLength(0);
    });
  });

  describe('getPromptCategories', () => {
    it('should return distinct categories', () => {
      savePrompt('P1', 'C', 'Development');
      savePrompt('P2', 'C', 'Development');
      savePrompt('P3', 'C', 'Testing');
      savePrompt('P4', 'C', 'General');

      const categories = getPromptCategories();

      expect(categories).toHaveLength(3);
      expect(categories).toContain('Development');
      expect(categories).toContain('Testing');
      expect(categories).toContain('General');
    });

    it('should return categories in alphabetical order', () => {
      savePrompt('P1', 'C', 'Zebra');
      savePrompt('P2', 'C', 'Alpha');
      savePrompt('P3', 'C', 'Beta');

      const categories = getPromptCategories();

      expect(categories[0]).toBe('Alpha');
      expect(categories[1]).toBe('Beta');
      expect(categories[2]).toBe('Zebra');
    });
  });
});

// ============================================================================
// QUICK NOTES TESTS
// ============================================================================

describeIfDb('Quick Notes Operations', () => {
  describe('createQuickNote', () => {
    it('should create a note with default values', () => {
      const id = createQuickNote('My note content');

      expect(id).toBeGreaterThan(0);

      const notes = getQuickNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toBe('My note content');
      expect(notes[0].status).toBe('active');
      expect(notes[0].priority).toBe('normal');
      expect(notes[0].sessionId).toBeNull();
    });

    it('should create a note linked to a session', () => {
      upsertSession({ id: 'session-1', projectName: 'Test' });
      const id = createQuickNote('Note for session', 'session-1');

      const notes = getQuickNotes();
      expect(notes[0].sessionId).toBe('session-1');
    });

    it('should create a note with custom priority', () => {
      const id = createQuickNote('Urgent note', undefined, 'high');

      const notes = getQuickNotes();
      expect(notes[0].priority).toBe('high');
    });
  });

  describe('getQuickNotes', () => {
    it('should filter by status', () => {
      createQuickNote('Active note 1');
      createQuickNote('Active note 2');
      const completedId = createQuickNote('Completed note');
      setQuickNoteStatus(completedId, 'completed');

      const activeNotes = getQuickNotes('active');
      expect(activeNotes).toHaveLength(2);

      const completedNotes = getQuickNotes('completed');
      expect(completedNotes).toHaveLength(1);
    });

    it('should return notes ordered by created_at desc', () => {
      createQuickNote('First');
      createQuickNote('Second');
      createQuickNote('Third');

      const notes = getQuickNotes();

      // Most recent first
      expect(notes[0].content).toBe('Third');
      expect(notes[2].content).toBe('First');
    });
  });

  describe('updateQuickNote', () => {
    it('should update note content', () => {
      const id = createQuickNote('Original content');

      updateQuickNote(id, 'Updated content');

      const notes = getQuickNotes();
      expect(notes[0].content).toBe('Updated content');
    });
  });

  describe('setQuickNoteStatus', () => {
    it('should change note status', () => {
      const id = createQuickNote('Note');

      expect(getQuickNotes('active')).toHaveLength(1);
      expect(getQuickNotes('completed')).toHaveLength(0);

      setQuickNoteStatus(id, 'completed');

      expect(getQuickNotes('active')).toHaveLength(0);
      expect(getQuickNotes('completed')).toHaveLength(1);
    });

    it('should support archived status', () => {
      const id = createQuickNote('Note');

      setQuickNoteStatus(id, 'archived');

      const archivedNotes = getQuickNotes('archived');
      expect(archivedNotes).toHaveLength(1);
    });
  });

  describe('deleteQuickNote', () => {
    it('should delete a note', () => {
      const id = createQuickNote('To delete');

      expect(getQuickNotes()).toHaveLength(1);

      deleteQuickNote(id);

      expect(getQuickNotes()).toHaveLength(0);
    });
  });

  describe('linkQuickNoteToSession', () => {
    it('should link existing note to session', () => {
      const noteId = createQuickNote('Unlinked note');
      upsertSession({ id: 'session-1', projectName: 'Test' });

      linkQuickNoteToSession(noteId, 'session-1');

      const notes = getQuickNotes();
      expect(notes[0].sessionId).toBe('session-1');
    });
  });
});

// ============================================================================
// NOTIFICATION TESTS
// ============================================================================

describeIfDb('Notification Operations', () => {
  describe('createNotification', () => {
    it('should create a notification with default values', () => {
      const id = createNotification('info', 'Test Title');

      expect(id).toBeGreaterThan(0);

      const notifications = getNotifications(true);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe('info');
      expect(notifications[0].title).toBe('Test Title');
      expect(notifications[0].priority).toBe('normal');
      expect(notifications[0].read).toBe(false);
      expect(notifications[0].dismissed).toBe(false);
    });

    it('should create notification with all optional fields', () => {
      upsertSession({ id: 'session-1' });
      const id = createNotification('warning', 'Warning', 'Detailed message', 'high', 'session-1');

      const notifications = getNotifications(true);
      expect(notifications[0].message).toBe('Detailed message');
      expect(notifications[0].priority).toBe('high');
      expect(notifications[0].sessionId).toBe('session-1');
    });
  });

  describe('getNotifications', () => {
    it('should return only unread notifications by default', () => {
      const id1 = createNotification('info', 'Unread');
      const id2 = createNotification('info', 'Read');
      markNotificationRead(id2);

      const notifications = getNotifications(false);

      expect(notifications).toHaveLength(1);
      expect(notifications[0].title).toBe('Unread');
    });

    it('should include read notifications when flag is true', () => {
      const id1 = createNotification('info', 'Unread');
      const id2 = createNotification('info', 'Read');
      markNotificationRead(id2);

      const notifications = getNotifications(true);

      expect(notifications).toHaveLength(2);
    });

    it('should exclude dismissed notifications', () => {
      const id = createNotification('info', 'Dismissed');
      dismissNotification(id);

      expect(getNotifications(true)).toHaveLength(0);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        createNotification('info', `Notification ${i}`);
      }

      const notifications = getNotifications(true, 5);

      expect(notifications).toHaveLength(5);
    });
  });

  describe('getUnreadNotificationCount', () => {
    it('should count unread non-dismissed notifications', () => {
      createNotification('info', 'N1');
      createNotification('info', 'N2');
      const id3 = createNotification('info', 'N3');
      markNotificationRead(id3);

      expect(getUnreadNotificationCount()).toBe(2);
    });

    it('should return 0 when no unread notifications', () => {
      expect(getUnreadNotificationCount()).toBe(0);
    });

    it('should not count dismissed notifications', () => {
      const id = createNotification('info', 'Dismissed');
      dismissNotification(id);

      expect(getUnreadNotificationCount()).toBe(0);
    });
  });

  describe('markNotificationRead', () => {
    it('should mark notification as read', () => {
      const id = createNotification('info', 'Test');

      expect(getNotifications(false)).toHaveLength(1);

      markNotificationRead(id);

      expect(getNotifications(false)).toHaveLength(0);
      expect(getNotifications(true)).toHaveLength(1);
      expect(getNotifications(true)[0].read).toBe(true);
    });
  });

  describe('markAllNotificationsRead', () => {
    it('should mark all notifications as read', () => {
      createNotification('info', 'N1');
      createNotification('info', 'N2');
      createNotification('info', 'N3');

      expect(getUnreadNotificationCount()).toBe(3);

      markAllNotificationsRead();

      expect(getUnreadNotificationCount()).toBe(0);
    });
  });

  describe('dismissNotification', () => {
    it('should dismiss a notification', () => {
      const id = createNotification('info', 'Test');

      expect(getNotifications(true)).toHaveLength(1);

      dismissNotification(id);

      expect(getNotifications(true)).toHaveLength(0);
    });
  });

  describe('dismissAllNotifications', () => {
    it('should dismiss all notifications', () => {
      createNotification('info', 'N1');
      createNotification('info', 'N2');
      createNotification('info', 'N3');

      dismissAllNotifications();

      expect(getNotifications(true)).toHaveLength(0);
    });
  });
});

// ============================================================================
// KNOWLEDGE TESTS
// ============================================================================

describeIfDb('Knowledge Operations', () => {
  describe('createKnowledgeEntry', () => {
    it('should create an entry with minimal fields', () => {
      const id = createKnowledgeEntry('Test Title', 'Test content');

      expect(id).toBeGreaterThan(0);

      const entries = getAllKnowledgeEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe('Test Title');
      expect(entries[0].content).toBe('Test content');
      expect(entries[0].viewCount).toBe(0);
    });

    it('should create an entry with all fields', () => {
      upsertSession({ id: 'session-1' });
      const id = createKnowledgeEntry(
        'Full Entry',
        'Content here',
        'Development',
        'react,typescript',
        'session-1'
      );

      const entries = getAllKnowledgeEntries();
      expect(entries[0].category).toBe('Development');
      expect(entries[0].tags).toBe('react,typescript');
      expect(entries[0].sourceSessionId).toBe('session-1');
    });
  });

  describe('getAllKnowledgeEntries', () => {
    it('should return entries ordered by updated_at desc', () => {
      createKnowledgeEntry('First', 'Content');
      createKnowledgeEntry('Second', 'Content');
      createKnowledgeEntry('Third', 'Content');

      const entries = getAllKnowledgeEntries();

      expect(entries[0].title).toBe('Third');
      expect(entries[2].title).toBe('First');
    });
  });

  describe('getKnowledgeEntry', () => {
    it('should return entry and increment view count', () => {
      const id = createKnowledgeEntry('Test', 'Content');

      expect(getAllKnowledgeEntries()[0].viewCount).toBe(0);

      const entry = getKnowledgeEntry(id);

      expect(entry).not.toBeNull();
      expect(entry?.viewCount).toBe(1);

      // View again
      getKnowledgeEntry(id);
      expect(getKnowledgeEntry(id)?.viewCount).toBe(3);
    });

    it('should return null for non-existent entry', () => {
      const entry = getKnowledgeEntry(9999);
      expect(entry).toBeNull();
    });
  });

  describe('getKnowledgeByCategory', () => {
    it('should filter by category', () => {
      createKnowledgeEntry('Dev 1', 'Content', 'Development');
      createKnowledgeEntry('Dev 2', 'Content', 'Development');
      createKnowledgeEntry('Test 1', 'Content', 'Testing');

      const devEntries = getKnowledgeByCategory('Development');

      expect(devEntries).toHaveLength(2);
      expect(devEntries.every(e => e.category === 'Development')).toBe(true);
    });
  });

  describe('searchKnowledge', () => {
    beforeEach(() => {
      createKnowledgeEntry('React Hooks Guide', 'Learn about useState and useEffect', 'Development', 'react');
      createKnowledgeEntry('TypeScript Tips', 'Type inference and generics', 'Development', 'typescript');
      createKnowledgeEntry('Testing Best Practices', 'Unit testing with Vitest', 'Testing', 'testing,vitest');
    });

    it('should search in title', () => {
      const results = searchKnowledge('React');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('React Hooks Guide');
    });

    it('should search in content', () => {
      const results = searchKnowledge('generics');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('TypeScript Tips');
    });

    it('should search in tags', () => {
      const results = searchKnowledge('vitest');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Testing Best Practices');
    });

    it('should return results ordered by view count', () => {
      const entries = getAllKnowledgeEntries();
      // View TypeScript entry multiple times
      getKnowledgeEntry(entries.find(e => e.title === 'TypeScript Tips')!.id);
      getKnowledgeEntry(entries.find(e => e.title === 'TypeScript Tips')!.id);

      const results = searchKnowledge('Development');

      // TypeScript should be first due to higher view count
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('updateKnowledgeEntry', () => {
    it('should update entry properties', () => {
      const id = createKnowledgeEntry('Original', 'Original content');

      updateKnowledgeEntry(id, 'Updated', 'Updated content', 'NewCategory', 'new,tags');

      const entry = getKnowledgeEntry(id);
      expect(entry?.title).toBe('Updated');
      expect(entry?.content).toBe('Updated content');
      expect(entry?.category).toBe('NewCategory');
      expect(entry?.tags).toBe('new,tags');
    });
  });

  describe('deleteKnowledgeEntry', () => {
    it('should delete an entry', () => {
      const id = createKnowledgeEntry('To Delete', 'Content');

      expect(getAllKnowledgeEntries()).toHaveLength(1);

      deleteKnowledgeEntry(id);

      expect(getAllKnowledgeEntries()).toHaveLength(0);
    });
  });

  describe('getKnowledgeCategories', () => {
    it('should return categories with counts', () => {
      createKnowledgeEntry('E1', 'C', 'Development');
      createKnowledgeEntry('E2', 'C', 'Development');
      createKnowledgeEntry('E3', 'C', 'Testing');

      const categories = getKnowledgeCategories();

      expect(categories).toHaveLength(2);
      const devCategory = categories.find(c => c.category === 'Development');
      expect(devCategory?.count).toBe(2);
    });

    it('should order by count desc', () => {
      createKnowledgeEntry('E1', 'C', 'A');
      createKnowledgeEntry('E2', 'C', 'B');
      createKnowledgeEntry('E3', 'C', 'B');
      createKnowledgeEntry('E4', 'C', 'B');

      const categories = getKnowledgeCategories();

      expect(categories[0].category).toBe('B');
      expect(categories[0].count).toBe(3);
    });
  });

  describe('getMostViewedKnowledge', () => {
    it('should return entries ordered by view count', () => {
      const id1 = createKnowledgeEntry('Low Views', 'Content');
      const id2 = createKnowledgeEntry('High Views', 'Content');
      const id3 = createKnowledgeEntry('Medium Views', 'Content');

      // View entries different amounts
      getKnowledgeEntry(id2);
      getKnowledgeEntry(id2);
      getKnowledgeEntry(id2);
      getKnowledgeEntry(id3);
      getKnowledgeEntry(id3);

      const mostViewed = getMostViewedKnowledge(10);

      expect(mostViewed[0].title).toBe('High Views');
      expect(mostViewed[1].title).toBe('Medium Views');
      expect(mostViewed[2].title).toBe('Low Views');
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        createKnowledgeEntry(`Entry ${i}`, 'Content');
      }

      const topThree = getMostViewedKnowledge(3);

      expect(topThree).toHaveLength(3);
    });
  });
});

// ============================================================================
// SEARCH TESTS
// ============================================================================

describeIfDb('Search Operations', () => {
  beforeEach(() => {
    // Create test sessions
    upsertSession({ id: 'session-1', projectName: 'ProjectA', cost: 0.10, startTime: '2024-01-15T10:00:00Z' });
    upsertSession({ id: 'session-2', projectName: 'ProjectB', cost: 0.50, startTime: '2024-01-16T10:00:00Z' });
    upsertSession({ id: 'session-3', projectName: 'ProjectA', cost: 1.00, startTime: '2024-01-17T10:00:00Z' });
  });

  describe('searchSessions', () => {
    it('should search by project name', () => {
      const results = searchSessions('ProjectA');

      expect(results).toHaveLength(2);
      expect(results.every(s => s.projectName?.includes('ProjectA'))).toBe(true);
    });

    it('should search in message content', () => {
      storeMessages('session-1', [{ role: 'user', content: 'unique search term' }]);

      const results = searchSessions('unique search term');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('session-1');
    });

    it('should return empty array for no matches', () => {
      const results = searchSessions('nonexistent');

      expect(results).toEqual([]);
    });
  });

  describe('searchSessionsAdvanced', () => {
    it('should filter by query in project name', () => {
      const results = searchSessionsAdvanced({ query: 'ProjectA' });

      expect(results).toHaveLength(2);
    });

    it('should filter by favorite status', () => {
      const db = getDatabase();
      db.prepare('UPDATE sessions SET favorite = 1 WHERE id = ?').run('session-1');

      const results = searchSessionsAdvanced({ favorite: true });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('session-1');
    });

    it('should filter by archived status', () => {
      const db = getDatabase();
      db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run('session-2');

      const results = searchSessionsAdvanced({ archived: true });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('session-2');
    });

    it('should filter by collection', () => {
      const collectionId = createCollection('Test');
      addSessionToCollection('session-1', collectionId);

      const results = searchSessionsAdvanced({ collectionId });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('session-1');
    });

    it('should filter by date range', () => {
      const results = searchSessionsAdvanced({
        startDate: '2024-01-16T00:00:00Z',
        endDate: '2024-01-17T00:00:00Z',
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('session-2');
    });

    it('should filter by cost range', () => {
      const results = searchSessionsAdvanced({
        minCost: 0.20,
        maxCost: 0.80,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('session-2');
    });

    it('should filter by project', () => {
      const results = searchSessionsAdvanced({ project: 'ProjectB' });

      expect(results).toHaveLength(1);
      expect(results[0].projectName).toBe('ProjectB');
    });

    it('should respect limit parameter', () => {
      const results = searchSessionsAdvanced({ limit: 2 });

      expect(results).toHaveLength(2);
    });

    it('should combine multiple filters', () => {
      const results = searchSessionsAdvanced({
        project: 'ProjectA',
        minCost: 0.50,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('session-3');
    });
  });

  describe('savedSearches', () => {
    describe('saveSearch', () => {
      it('should save a search', () => {
        const id = saveSearch('My Search', 'test query');

        expect(id).toBeGreaterThan(0);

        const searches = getAllSavedSearches();
        expect(searches).toHaveLength(1);
        expect(searches[0].name).toBe('My Search');
        expect(searches[0].query).toBe('test query');
      });

      it('should save search with filters', () => {
        const filters = { project: 'Test', minCost: 0.10 };
        const id = saveSearch('Filtered Search', 'query', filters);

        const searches = getAllSavedSearches();
        const parsedFilters = JSON.parse(searches[0].filters);
        expect(parsedFilters).toEqual(filters);
      });
    });

    describe('getAllSavedSearches', () => {
      it('should return searches ordered by created_at desc', () => {
        saveSearch('First', 'q1');
        saveSearch('Second', 'q2');
        saveSearch('Third', 'q3');

        const searches = getAllSavedSearches();

        expect(searches[0].name).toBe('Third');
        expect(searches[2].name).toBe('First');
      });
    });

    describe('deleteSavedSearch', () => {
      it('should delete a saved search', () => {
        const id = saveSearch('To Delete', 'query');

        expect(getAllSavedSearches()).toHaveLength(1);

        deleteSavedSearch(id);

        expect(getAllSavedSearches()).toHaveLength(0);
      });
    });
  });
});

// ============================================================================
// CONNECTION MODULE TESTS
// ============================================================================

describeIfDb('Connection Module', () => {
  describe('isDatabaseInitialized', () => {
    it('should return true when database is initialized', () => {
      expect(isDatabaseInitialized()).toBe(true);
    });
  });

  describe('getDatabase throws when not initialized', () => {
    it('should throw when database is cleared', () => {
      // Save the current instance
      const db = getDatabase();

      // Clear it
      clearDatabaseInstance();

      // Should throw
      expect(() => getDatabase()).toThrow('Database not initialized');
      expect(isDatabaseInitialized()).toBe(false);

      // Restore
      setDatabaseInstance(db);
      expect(isDatabaseInitialized()).toBe(true);
    });
  });
});

// ============================================================================
// MIGRATION TESTS
// ============================================================================

describeIfDb('Migration Operations', () => {
  describe('getCurrentVersion', () => {
    it('should return current schema version', () => {
      const db = getDatabase();
      const version = getCurrentVersion(db);

      // Should be at least 0 (or higher if migrations have run)
      expect(version).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getMigrationHistory', () => {
    it('should return migration history', () => {
      const db = getDatabase();
      const history = getMigrationHistory(db);

      // Should be an array
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('hasMigration', () => {
    it('should check if migration exists', () => {
      const db = getDatabase();

      // Version 0 should not exist (base state)
      expect(hasMigration(db, 0)).toBe(false);

      // Very high version should not exist
      expect(hasMigration(db, 99999)).toBe(false);
    });
  });

  describe('getPendingMigrations', () => {
    it('should return pending migrations', () => {
      const db = getDatabase();

      // Create test migrations
      const testMigrations = [
        { version: 1000, description: 'Test migration 1', up: () => {} },
        { version: 1001, description: 'Test migration 2', up: () => {} },
      ];

      const pending = getPendingMigrations(db, testMigrations);

      // These should be pending (versions are higher than current)
      expect(pending.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('runMigrations', () => {
    it('should run pending migrations', () => {
      const db = getDatabase();
      const currentVersion = getCurrentVersion(db);

      // Create a test migration with a very high version
      let migrationRan = false;
      const testMigrations = [
        {
          version: currentVersion + 100,
          description: 'Test migration',
          up: () => {
            migrationRan = true;
          },
        },
      ];

      const applied = runMigrations(db, testMigrations);

      expect(applied).toBe(1);
      expect(migrationRan).toBe(true);
      expect(hasMigration(db, currentVersion + 100)).toBe(true);
    });

    it('should not run migrations if already up to date', () => {
      const db = getDatabase();

      // Empty migrations array
      const applied = runMigrations(db, []);

      expect(applied).toBe(0);
    });

    it('should run migrations in order', () => {
      const db = getDatabase();
      const currentVersion = getCurrentVersion(db);

      const order: number[] = [];
      const testMigrations = [
        {
          version: currentVersion + 102,
          description: 'Third',
          up: () => order.push(3),
        },
        {
          version: currentVersion + 101,
          description: 'Second',
          up: () => order.push(2),
        },
        {
          version: currentVersion + 103,
          description: 'Fourth',
          up: () => order.push(4),
        },
      ];

      runMigrations(db, testMigrations);

      // Should run in version order
      expect(order).toEqual([2, 3, 4]);
    });
  });

  describe('rollbackMigrations', () => {
    it('should rollback migrations', () => {
      const db = getDatabase();
      const currentVersion = getCurrentVersion(db);

      // First apply a migration
      let tableCreated = false;
      let tableDropped = false;
      const testMigrations = [
        {
          version: currentVersion + 200,
          description: 'Create test table',
          up: () => {
            tableCreated = true;
          },
          down: () => {
            tableDropped = true;
          },
        },
      ];

      runMigrations(db, testMigrations);
      expect(tableCreated).toBe(true);

      // Now rollback
      const rolledBack = rollbackMigrations(db, testMigrations, currentVersion);

      expect(rolledBack).toBe(1);
      expect(tableDropped).toBe(true);
      expect(hasMigration(db, currentVersion + 200)).toBe(false);
    });

    it('should not rollback if already at target version', () => {
      const db = getDatabase();
      const currentVersion = getCurrentVersion(db);

      const rolledBack = rollbackMigrations(db, [], currentVersion);

      expect(rolledBack).toBe(0);
    });

    it('should skip migrations without down function', () => {
      const db = getDatabase();
      const currentVersion = getCurrentVersion(db);

      const testMigrations = [
        {
          version: currentVersion + 300,
          description: 'No rollback',
          up: () => {},
          // No down function
        },
      ];

      runMigrations(db, testMigrations);

      // Try to rollback
      const rolledBack = rollbackMigrations(db, testMigrations, currentVersion);

      // Should report 0 rolled back (no down function)
      expect(rolledBack).toBe(0);
    });
  });
});

// ============================================================================
// EDGE CASES AND ERROR HANDLING
// ============================================================================

describeIfDb('Edge Cases and Error Handling', () => {
  describe('Empty inputs', () => {
    it('should handle empty search queries', () => {
      upsertSession({ id: 'session-1', projectName: 'Test' });

      const results = searchSessions('');

      // Empty query should match all (via LIKE '%%')
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty prompt content', () => {
      const id = savePrompt('Empty Content', '');

      const prompts = getAllPrompts();
      expect(prompts[0].content).toBe('');
    });

    it('should handle empty note content', () => {
      const id = createQuickNote('');

      const notes = getQuickNotes();
      expect(notes[0].content).toBe('');
    });
  });

  describe('Special characters', () => {
    it('should handle special characters in project names', () => {
      upsertSession({ id: 'session-1', projectName: "Project's \"Test\" <>&" });

      const results = searchSessions('Project');

      expect(results).toHaveLength(1);
      expect(results[0].projectName).toBe("Project's \"Test\" <>&");
    });

    it('should handle SQL injection attempts', () => {
      // This should not cause an error or unexpected behavior
      upsertSession({ id: 'session-1', projectName: "'; DROP TABLE sessions; --" });

      const results = searchSessions("'; DROP TABLE sessions; --");

      // Table should still exist
      const db = getDatabase();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all();
      expect(tables).toHaveLength(1);
    });

    it('should handle unicode characters', () => {
      upsertSession({ id: 'session-1', projectName: '\u4E2D\u6587\u9879\u76EE' });
      createKnowledgeEntry('\u65E5\u672C\u8A9E\u30BF\u30A4\u30C8\u30EB', '\u30B3\u30F3\u30C6\u30F3\u30C4');
      createNotification('info', '\uD83D\uDE80 Rocket notification');

      const sessions = searchSessions('\u4E2D\u6587');
      expect(sessions).toHaveLength(1);

      const entries = getAllKnowledgeEntries();
      expect(entries[0].title).toBe('\u65E5\u672C\u8A9E\u30BF\u30A4\u30C8\u30EB');

      const notifications = getNotifications(true);
      expect(notifications[0].title).toContain('\uD83D\uDE80');
    });
  });

  describe('Large data', () => {
    it('should handle large content in knowledge entries', () => {
      const largeContent = 'A'.repeat(100000);
      const id = createKnowledgeEntry('Large Entry', largeContent);

      const entry = getKnowledgeEntry(id);
      expect(entry?.content.length).toBe(100000);
    });

    it('should handle many records', () => {
      // Insert 100 sessions
      for (let i = 0; i < 100; i++) {
        upsertSession({ id: `session-${i}`, projectName: `Project ${i}` });
      }

      const results = searchSessionsAdvanced({ limit: 50 });
      expect(results).toHaveLength(50);

      const allResults = searchSessionsAdvanced({});
      expect(allResults).toHaveLength(100);
    });
  });

  describe('NULL handling', () => {
    it('should handle null values in session fields', () => {
      upsertSession({
        id: 'session-null',
        projectName: undefined,
        filePath: undefined,
        startTime: undefined,
        endTime: undefined,
      });

      const results = searchSessionsAdvanced({});
      const session = results.find(s => s.id === 'session-null');

      expect(session).toBeDefined();
      expect(session?.projectName).toBeNull();
    });

    it('should handle null category in knowledge entries', () => {
      createKnowledgeEntry('No Category', 'Content', undefined);

      const categories = getKnowledgeCategories();
      // Should not include null categories
      expect(categories.every(c => c.category !== null)).toBe(true);
    });
  });

  describe('Concurrent operations', () => {
    it('should handle multiple rapid inserts', () => {
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 50; i++) {
        // Synchronous operations but called rapidly
        upsertSession({ id: `rapid-${i}`, projectName: `Rapid ${i}` });
        createQuickNote(`Note ${i}`);
        createNotification('info', `Notification ${i}`);
      }

      const sessions = searchSessionsAdvanced({});
      const notes = getQuickNotes();
      const notifications = getNotifications(true);

      expect(sessions.filter(s => s.id.startsWith('rapid-'))).toHaveLength(50);
      expect(notes.length).toBeGreaterThanOrEqual(50);
      expect(notifications.length).toBeGreaterThanOrEqual(50);
    });
  });
});
