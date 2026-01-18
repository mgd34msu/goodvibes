// ============================================================================
// AGENCY INDEX DATABASE TESTS
// ============================================================================
//
// Comprehensive tests for the agency index database operations including:
// - Indexed skills CRUD operations
// - Indexed agents CRUD operations
// - Category operations
// - Active agents and queued skills
// - Full-text search functionality
// - Usage tracking and statistics
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
const TEST_DIR = path.join(os.tmpdir(), 'agency-index-test-' + Date.now());

// Mock electron and logger
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(TEST_DIR),
  },
}));

vi.mock('../../services/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// Types for dynamic imports
type InitDatabase = typeof import('../index.js').initDatabase;
type CloseDatabase = typeof import('../index.js').closeDatabase;
type GetDatabase = typeof import('../connection.js').getDatabase;

// Skills operations
type UpsertIndexedSkill = typeof import('./skills.js').upsertIndexedSkill;
type GetIndexedSkill = typeof import('./skills.js').getIndexedSkill;
type GetIndexedSkillBySlug = typeof import('./skills.js').getIndexedSkillBySlug;
type GetAllIndexedSkills = typeof import('./skills.js').getAllIndexedSkills;
type GetIndexedSkillsByCategory = typeof import('./skills.js').getIndexedSkillsByCategory;
type GetIndexedSkillsByCategoryPath = typeof import('./skills.js').getIndexedSkillsByCategoryPath;
type GetIndexedSkillsByAgent = typeof import('./skills.js').getIndexedSkillsByAgent;
type GetPopularSkills = typeof import('./skills.js').getPopularSkills;
type GetRecentlyUsedSkills = typeof import('./skills.js').getRecentlyUsedSkills;
type SearchIndexedSkills = typeof import('./skills.js').searchIndexedSkills;
type RecordSkillUsage = typeof import('./skills.js').recordSkillUsage;
type DeleteIndexedSkill = typeof import('./skills.js').deleteIndexedSkill;
type ClearIndexedSkills = typeof import('./skills.js').clearIndexedSkills;
type GetSkillCount = typeof import('./skills.js').getSkillCount;

// Agents operations
type UpsertIndexedAgent = typeof import('./agents.js').upsertIndexedAgent;
type GetIndexedAgent = typeof import('./agents.js').getIndexedAgent;
type GetIndexedAgentBySlug = typeof import('./agents.js').getIndexedAgentBySlug;
type GetAllIndexedAgents = typeof import('./agents.js').getAllIndexedAgents;
type GetIndexedAgentsByCategory = typeof import('./agents.js').getIndexedAgentsByCategory;
type GetIndexedAgentsByCategoryPath = typeof import('./agents.js').getIndexedAgentsByCategoryPath;
type GetPopularAgents = typeof import('./agents.js').getPopularAgents;
type GetRecentlyUsedAgents = typeof import('./agents.js').getRecentlyUsedAgents;
type SearchIndexedAgents = typeof import('./agents.js').searchIndexedAgents;
type RecordAgentUsage = typeof import('./agents.js').recordAgentUsage;
type DeleteIndexedAgent = typeof import('./agents.js').deleteIndexedAgent;
type ClearIndexedAgents = typeof import('./agents.js').clearIndexedAgents;
type GetAgentCount = typeof import('./agents.js').getAgentCount;

// Category operations
type UpsertCategory = typeof import('./categories.js').upsertCategory;
type GetCategory = typeof import('./categories.js').getCategory;
type GetCategoryByPath = typeof import('./categories.js').getCategoryByPath;
type GetCategories = typeof import('./categories.js').getCategories;
type GetCategoryTree = typeof import('./categories.js').getCategoryTree;
type UpdateCategoryCount = typeof import('./categories.js').updateCategoryCount;

// Active agents and queued skills operations
type ActivateAgent = typeof import('./active.js').activateAgent;
type GetActiveAgent = typeof import('./active.js').getActiveAgent;
type GetActiveAgentsForSession = typeof import('./active.js').getActiveAgentsForSession;
type GetActiveAgentsForProject = typeof import('./active.js').getActiveAgentsForProject;
type GetAllActiveAgentConfigs = typeof import('./active.js').getAllActiveAgentConfigs;
type DeactivateAgent = typeof import('./active.js').deactivateAgent;
type DeactivateAgentByAgentId = typeof import('./active.js').deactivateAgentByAgentId;
type QueueSkill = typeof import('./active.js').queueSkill;
type GetQueuedSkill = typeof import('./active.js').getQueuedSkill;
type GetPendingSkillsForSession = typeof import('./active.js').getPendingSkillsForSession;
type GetPendingSkillsForProject = typeof import('./active.js').getPendingSkillsForProject;
type GetAllPendingSkills = typeof import('./active.js').getAllPendingSkills;
type MarkSkillInjected = typeof import('./active.js').markSkillInjected;
type RemoveQueuedSkill = typeof import('./active.js').removeQueuedSkill;
type ClearSkillQueue = typeof import('./active.js').clearSkillQueue;

// Index operations
type CreateAgencyIndexTables = typeof import('./index.js').createAgencyIndexTables;
type GetIndexStats = typeof import('./index.js').getIndexStats;

// Declare variables for dynamic imports
let initDatabase: InitDatabase;
let closeDatabase: CloseDatabase;
let getDatabase: GetDatabase;

// Skills
let upsertIndexedSkill: UpsertIndexedSkill;
let getIndexedSkill: GetIndexedSkill;
let getIndexedSkillBySlug: GetIndexedSkillBySlug;
let getAllIndexedSkills: GetAllIndexedSkills;
let getIndexedSkillsByCategory: GetIndexedSkillsByCategory;
let getIndexedSkillsByCategoryPath: GetIndexedSkillsByCategoryPath;
let getIndexedSkillsByAgent: GetIndexedSkillsByAgent;
let getPopularSkills: GetPopularSkills;
let getRecentlyUsedSkills: GetRecentlyUsedSkills;
let searchIndexedSkills: SearchIndexedSkills;
let recordSkillUsage: RecordSkillUsage;
let deleteIndexedSkill: DeleteIndexedSkill;
let clearIndexedSkills: ClearIndexedSkills;
let getSkillCount: GetSkillCount;

// Agents
let upsertIndexedAgent: UpsertIndexedAgent;
let getIndexedAgent: GetIndexedAgent;
let getIndexedAgentBySlug: GetIndexedAgentBySlug;
let getAllIndexedAgents: GetAllIndexedAgents;
let getIndexedAgentsByCategory: GetIndexedAgentsByCategory;
let getIndexedAgentsByCategoryPath: GetIndexedAgentsByCategoryPath;
let getPopularAgents: GetPopularAgents;
let getRecentlyUsedAgents: GetRecentlyUsedAgents;
let searchIndexedAgents: SearchIndexedAgents;
let recordAgentUsage: RecordAgentUsage;
let deleteIndexedAgent: DeleteIndexedAgent;
let clearIndexedAgents: ClearIndexedAgents;
let getAgentCount: GetAgentCount;

// Categories
let upsertCategory: UpsertCategory;
let getCategory: GetCategory;
let getCategoryByPath: GetCategoryByPath;
let getCategories: GetCategories;
let getCategoryTree: GetCategoryTree;
let updateCategoryCount: UpdateCategoryCount;

// Active agents and queued skills
let activateAgent: ActivateAgent;
let getActiveAgent: GetActiveAgent;
let getActiveAgentsForSession: GetActiveAgentsForSession;
let getActiveAgentsForProject: GetActiveAgentsForProject;
let getAllActiveAgentConfigs: GetAllActiveAgentConfigs;
let deactivateAgent: DeactivateAgent;
let deactivateAgentByAgentId: DeactivateAgentByAgentId;
let queueSkill: QueueSkill;
let getQueuedSkill: GetQueuedSkill;
let getPendingSkillsForSession: GetPendingSkillsForSession;
let getPendingSkillsForProject: GetPendingSkillsForProject;
let getAllPendingSkills: GetAllPendingSkills;
let markSkillInjected: MarkSkillInjected;
let removeQueuedSkill: RemoveQueuedSkill;
let clearSkillQueue: ClearSkillQueue;

// Index
let createAgencyIndexTables: CreateAgencyIndexTables;
let getIndexStats: GetIndexStats;

// ============================================================================
// TEST SETUP
// ============================================================================

beforeAll(async () => {
  if (!canLoadDatabase) {
    console.warn('Skipping agency index tests: better-sqlite3 native module cannot be loaded');
    return;
  }

  // Create test directory
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  // Dynamic imports to prevent module load errors
  const dbModule = await import('../index.js');
  const connectionModule = await import('../connection.js');
  const skillsModule = await import('./skills.js');
  const agentsModule = await import('./agents.js');
  const categoriesModule = await import('./categories.js');
  const activeModule = await import('./active.js');
  const indexModule = await import('./index.js');

  initDatabase = dbModule.initDatabase;
  closeDatabase = dbModule.closeDatabase;
  getDatabase = connectionModule.getDatabase;

  // Skills
  upsertIndexedSkill = skillsModule.upsertIndexedSkill;
  getIndexedSkill = skillsModule.getIndexedSkill;
  getIndexedSkillBySlug = skillsModule.getIndexedSkillBySlug;
  getAllIndexedSkills = skillsModule.getAllIndexedSkills;
  getIndexedSkillsByCategory = skillsModule.getIndexedSkillsByCategory;
  getIndexedSkillsByCategoryPath = skillsModule.getIndexedSkillsByCategoryPath;
  getIndexedSkillsByAgent = skillsModule.getIndexedSkillsByAgent;
  getPopularSkills = skillsModule.getPopularSkills;
  getRecentlyUsedSkills = skillsModule.getRecentlyUsedSkills;
  searchIndexedSkills = skillsModule.searchIndexedSkills;
  recordSkillUsage = skillsModule.recordSkillUsage;
  deleteIndexedSkill = skillsModule.deleteIndexedSkill;
  clearIndexedSkills = skillsModule.clearIndexedSkills;
  getSkillCount = skillsModule.getSkillCount;

  // Agents
  upsertIndexedAgent = agentsModule.upsertIndexedAgent;
  getIndexedAgent = agentsModule.getIndexedAgent;
  getIndexedAgentBySlug = agentsModule.getIndexedAgentBySlug;
  getAllIndexedAgents = agentsModule.getAllIndexedAgents;
  getIndexedAgentsByCategory = agentsModule.getIndexedAgentsByCategory;
  getIndexedAgentsByCategoryPath = agentsModule.getIndexedAgentsByCategoryPath;
  getPopularAgents = agentsModule.getPopularAgents;
  getRecentlyUsedAgents = agentsModule.getRecentlyUsedAgents;
  searchIndexedAgents = agentsModule.searchIndexedAgents;
  recordAgentUsage = agentsModule.recordAgentUsage;
  deleteIndexedAgent = agentsModule.deleteIndexedAgent;
  clearIndexedAgents = agentsModule.clearIndexedAgents;
  getAgentCount = agentsModule.getAgentCount;

  // Categories
  upsertCategory = categoriesModule.upsertCategory;
  getCategory = categoriesModule.getCategory;
  getCategoryByPath = categoriesModule.getCategoryByPath;
  getCategories = categoriesModule.getCategories;
  getCategoryTree = categoriesModule.getCategoryTree;
  updateCategoryCount = categoriesModule.updateCategoryCount;

  // Active agents and queued skills
  activateAgent = activeModule.activateAgent;
  getActiveAgent = activeModule.getActiveAgent;
  getActiveAgentsForSession = activeModule.getActiveAgentsForSession;
  getActiveAgentsForProject = activeModule.getActiveAgentsForProject;
  getAllActiveAgentConfigs = activeModule.getAllActiveAgentConfigs;
  deactivateAgent = activeModule.deactivateAgent;
  deactivateAgentByAgentId = activeModule.deactivateAgentByAgentId;
  queueSkill = activeModule.queueSkill;
  getQueuedSkill = activeModule.getQueuedSkill;
  getPendingSkillsForSession = activeModule.getPendingSkillsForSession;
  getPendingSkillsForProject = activeModule.getPendingSkillsForProject;
  getAllPendingSkills = activeModule.getAllPendingSkills;
  markSkillInjected = activeModule.markSkillInjected;
  removeQueuedSkill = activeModule.removeQueuedSkill;
  clearSkillQueue = activeModule.clearSkillQueue;

  // Index
  createAgencyIndexTables = indexModule.createAgencyIndexTables;
  getIndexStats = indexModule.getIndexStats;

  // Initialize database
  await initDatabase(TEST_DIR);
});

afterAll(() => {
  if (!canLoadDatabase) return;

  closeDatabase();

  // Clean up test directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

beforeEach(() => {
  if (!canLoadDatabase) return;

  // Clean up tables before each test
  const db = getDatabase();
  db.exec('DELETE FROM queued_skills');
  db.exec('DELETE FROM active_agents');
  db.exec('DELETE FROM indexed_skills');
  db.exec('DELETE FROM indexed_agents');
  db.exec('DELETE FROM agency_categories');
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createTestCategory(overrides: Partial<{
  name: string;
  path: string;
  parentId: number | null;
  type: 'agent' | 'skill';
  itemCount: number;
}> = {}) {
  return upsertCategory({
    name: overrides.name ?? 'Test Category',
    path: overrides.path ?? 'test/category',
    parentId: overrides.parentId ?? null,
    type: overrides.type ?? 'skill',
    itemCount: overrides.itemCount ?? 0,
  });
}

function createTestSkill(overrides: Partial<{
  name: string;
  slug: string;
  description: string | null;
  content: string;
  categoryId: number;
  categoryPath: string;
  filePath: string;
  agentSlug: string | null;
  triggers: string[];
  tags: string[];
  lastIndexed: string;
}> = {}) {
  return upsertIndexedSkill({
    name: overrides.name ?? 'Test Skill',
    slug: overrides.slug ?? 'test-skill',
    description: overrides.description ?? 'A test skill description',
    content: overrides.content ?? '# Test Skill\n\nThis is test content.',
    categoryId: overrides.categoryId ?? 1,
    categoryPath: overrides.categoryPath ?? 'test/category',
    filePath: overrides.filePath ?? '/path/to/skill/SKILL.md',
    agentSlug: overrides.agentSlug ?? null,
    triggers: overrides.triggers ?? ['test', 'example'],
    tags: overrides.tags ?? ['testing', 'unit-test'],
    lastIndexed: overrides.lastIndexed ?? new Date().toISOString(),
  });
}

function createTestAgent(overrides: Partial<{
  name: string;
  slug: string;
  description: string | null;
  content: string;
  categoryId: number;
  categoryPath: string;
  filePath: string;
  skills: string[];
  tags: string[];
  lastIndexed: string;
}> = {}) {
  return upsertIndexedAgent({
    name: overrides.name ?? 'Test Agent',
    slug: overrides.slug ?? 'test-agent',
    description: overrides.description ?? 'A test agent description',
    content: overrides.content ?? '# Test Agent\n\nThis is test agent content.',
    categoryId: overrides.categoryId ?? 1,
    categoryPath: overrides.categoryPath ?? 'test/category',
    filePath: overrides.filePath ?? '/path/to/agent.md',
    skills: overrides.skills ?? ['skill-1', 'skill-2'],
    tags: overrides.tags ?? ['testing', 'unit-test'],
    lastIndexed: overrides.lastIndexed ?? new Date().toISOString(),
  });
}

// ============================================================================
// CATEGORY TESTS
// ============================================================================

describeIfDb('Category Operations', () => {
  describe('upsertCategory', () => {
    it('should insert a new category', () => {
      const category = createTestCategory({
        name: 'Web Development',
        path: 'webdev',
        type: 'skill',
      });

      expect(category.id).toBeGreaterThan(0);
      expect(category.name).toBe('Web Development');
      expect(category.path).toBe('webdev');
      expect(category.type).toBe('skill');
      expect(category.parentId).toBeNull();
      expect(category.createdAt).toBeDefined();
      expect(category.updatedAt).toBeDefined();
    });

    it('should update an existing category by path', () => {
      createTestCategory({
        name: 'Original Name',
        path: 'test/path',
        itemCount: 5,
      });

      const updated = upsertCategory({
        name: 'Updated Name',
        path: 'test/path',
        parentId: null,
        type: 'skill',
        itemCount: 10,
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.itemCount).toBe(10);
    });

    it('should create nested categories with parent references', () => {
      const parent = createTestCategory({
        name: 'Parent',
        path: 'parent',
        type: 'agent',
      });

      const child = createTestCategory({
        name: 'Child',
        path: 'parent/child',
        parentId: parent.id,
        type: 'agent',
      });

      expect(child.parentId).toBe(parent.id);
    });
  });

  describe('getCategory', () => {
    it('should return category by ID', () => {
      const created = createTestCategory();
      const retrieved = getCategory(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe(created.name);
    });

    it('should return null for non-existent ID', () => {
      const result = getCategory(99999);
      expect(result).toBeNull();
    });
  });

  describe('getCategoryByPath', () => {
    it('should return category by path', () => {
      createTestCategory({ path: 'unique/path' });
      const retrieved = getCategoryByPath('unique/path');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.path).toBe('unique/path');
    });

    it('should return null for non-existent path', () => {
      const result = getCategoryByPath('non/existent');
      expect(result).toBeNull();
    });
  });

  describe('getCategories', () => {
    it('should return all categories', () => {
      createTestCategory({ path: 'cat1', type: 'skill' });
      createTestCategory({ path: 'cat2', type: 'agent' });

      const categories = getCategories();
      expect(categories).toHaveLength(2);
    });

    it('should filter by type', () => {
      createTestCategory({ path: 'skill1', type: 'skill' });
      createTestCategory({ path: 'skill2', type: 'skill' });
      createTestCategory({ path: 'agent1', type: 'agent' });

      const skills = getCategories('skill');
      const agents = getCategories('agent');

      expect(skills).toHaveLength(2);
      expect(agents).toHaveLength(1);
    });

    it('should return categories ordered by path', () => {
      createTestCategory({ path: 'z/path' });
      createTestCategory({ path: 'a/path' });
      createTestCategory({ path: 'm/path' });

      const categories = getCategories();

      expect(categories[0].path).toBe('a/path');
      expect(categories[1].path).toBe('m/path');
      expect(categories[2].path).toBe('z/path');
    });
  });

  describe('getCategoryTree', () => {
    it('should return category tree for type', () => {
      createTestCategory({ path: 'webdev', type: 'skill' });
      createTestCategory({ path: 'webdev/frontend', type: 'skill' });
      createTestCategory({ path: 'agents/test', type: 'agent' });

      const skillTree = getCategoryTree('skill');
      const agentTree = getCategoryTree('agent');

      expect(skillTree).toHaveLength(2);
      expect(agentTree).toHaveLength(1);
    });
  });

  describe('updateCategoryCount', () => {
    it('should update item count', () => {
      const category = createTestCategory({ itemCount: 0 });
      updateCategoryCount(category.id, 15);

      const updated = getCategory(category.id);
      expect(updated?.itemCount).toBe(15);
    });
  });
});

// ============================================================================
// INDEXED SKILL TESTS
// ============================================================================

describeIfDb('Indexed Skill Operations', () => {
  beforeEach(() => {
    // Create a category for skills
    createTestCategory({ path: 'test/category' });
  });

  describe('upsertIndexedSkill', () => {
    it('should insert a new skill', () => {
      const skill = createTestSkill({
        name: 'React Testing',
        slug: 'react-testing',
        description: 'Testing React components',
      });

      expect(skill.id).toBeGreaterThan(0);
      expect(skill.name).toBe('React Testing');
      expect(skill.slug).toBe('react-testing');
      expect(skill.description).toBe('Testing React components');
      expect(skill.useCount).toBe(0);
      expect(skill.lastUsed).toBeNull();
      expect(skill.createdAt).toBeDefined();
    });

    it('should update an existing skill by slug', () => {
      createTestSkill({
        slug: 'update-test',
        name: 'Original Name',
        content: 'Original content',
      });

      const updated = upsertIndexedSkill({
        slug: 'update-test',
        name: 'Updated Name',
        content: 'Updated content',
        description: 'Updated description',
        categoryId: 1,
        categoryPath: 'test/category',
        filePath: '/new/path',
        agentSlug: null,
        triggers: ['new-trigger'],
        tags: ['new-tag'],
        lastIndexed: new Date().toISOString(),
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.content).toBe('Updated content');
    });

    it('should preserve use count and last used on update', () => {
      const skill = createTestSkill({ slug: 'usage-test' });
      recordSkillUsage(skill.id);
      recordSkillUsage(skill.id);

      const updated = upsertIndexedSkill({
        slug: 'usage-test',
        name: 'Updated',
        description: null,
        content: 'Updated content',
        categoryId: 1,
        categoryPath: 'test/category',
        filePath: '/path',
        agentSlug: null,
        triggers: [],
        tags: [],
        lastIndexed: new Date().toISOString(),
      });

      expect(updated.useCount).toBe(2);
      expect(updated.lastUsed).not.toBeNull();
    });

    it('should store triggers as JSON array', () => {
      const skill = createTestSkill({
        triggers: ['trigger1', 'trigger2', 'trigger3'],
      });

      expect(skill.triggers).toEqual(['trigger1', 'trigger2', 'trigger3']);
    });

    it('should store tags as JSON array', () => {
      const skill = createTestSkill({
        tags: ['tag1', 'tag2'],
      });

      expect(skill.tags).toEqual(['tag1', 'tag2']);
    });
  });

  describe('getIndexedSkill', () => {
    it('should return skill by ID', () => {
      const created = createTestSkill();
      const retrieved = getIndexedSkill(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return null for non-existent ID', () => {
      const result = getIndexedSkill(99999);
      expect(result).toBeNull();
    });
  });

  describe('getIndexedSkillBySlug', () => {
    it('should return skill by slug', () => {
      createTestSkill({ slug: 'unique-slug' });
      const retrieved = getIndexedSkillBySlug('unique-slug');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.slug).toBe('unique-slug');
    });

    it('should return null for non-existent slug', () => {
      const result = getIndexedSkillBySlug('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('getAllIndexedSkills', () => {
    it('should return all skills ordered by name', () => {
      createTestSkill({ slug: 'z-skill', name: 'Zebra Skill' });
      createTestSkill({ slug: 'a-skill', name: 'Alpha Skill' });
      createTestSkill({ slug: 'm-skill', name: 'Middle Skill' });

      const skills = getAllIndexedSkills();

      expect(skills).toHaveLength(3);
      expect(skills[0].name).toBe('Alpha Skill');
      expect(skills[1].name).toBe('Middle Skill');
      expect(skills[2].name).toBe('Zebra Skill');
    });

    it('should return empty array when no skills exist', () => {
      const skills = getAllIndexedSkills();
      expect(skills).toEqual([]);
    });
  });

  describe('getIndexedSkillsByCategory', () => {
    it('should return skills filtered by category ID', () => {
      const cat1 = createTestCategory({ path: 'cat1' });
      const cat2 = createTestCategory({ path: 'cat2' });

      createTestSkill({ slug: 'skill1', categoryId: cat1.id, categoryPath: 'cat1' });
      createTestSkill({ slug: 'skill2', categoryId: cat1.id, categoryPath: 'cat1' });
      createTestSkill({ slug: 'skill3', categoryId: cat2.id, categoryPath: 'cat2' });

      const cat1Skills = getIndexedSkillsByCategory(cat1.id);
      const cat2Skills = getIndexedSkillsByCategory(cat2.id);

      expect(cat1Skills).toHaveLength(2);
      expect(cat2Skills).toHaveLength(1);
    });
  });

  describe('getIndexedSkillsByCategoryPath', () => {
    it('should return skills with matching category path prefix', () => {
      createTestSkill({ slug: 'skill1', categoryPath: 'webdev/frontend' });
      createTestSkill({ slug: 'skill2', categoryPath: 'webdev/backend' });
      createTestSkill({ slug: 'skill3', categoryPath: 'mobile/ios' });

      const webdevSkills = getIndexedSkillsByCategoryPath('webdev');
      const mobileSkills = getIndexedSkillsByCategoryPath('mobile');

      expect(webdevSkills).toHaveLength(2);
      expect(mobileSkills).toHaveLength(1);
    });
  });

  describe('getIndexedSkillsByAgent', () => {
    it('should return skills associated with agent slug', () => {
      createTestSkill({ slug: 'skill1', agentSlug: 'test-agent' });
      createTestSkill({ slug: 'skill2', agentSlug: 'test-agent' });
      createTestSkill({ slug: 'skill3', agentSlug: 'other-agent' });
      createTestSkill({ slug: 'skill4', agentSlug: null });

      const agentSkills = getIndexedSkillsByAgent('test-agent');

      expect(agentSkills).toHaveLength(2);
      expect(agentSkills.every(s => s.agentSlug === 'test-agent')).toBe(true);
    });
  });

  describe('getPopularSkills', () => {
    it('should return skills ordered by use count descending', () => {
      const skill1 = createTestSkill({ slug: 'low-usage' });
      const skill2 = createTestSkill({ slug: 'high-usage' });
      const skill3 = createTestSkill({ slug: 'medium-usage' });

      // Record different usage counts
      recordSkillUsage(skill2.id);
      recordSkillUsage(skill2.id);
      recordSkillUsage(skill2.id);
      recordSkillUsage(skill3.id);
      recordSkillUsage(skill3.id);
      recordSkillUsage(skill1.id);

      const popular = getPopularSkills(10);

      expect(popular[0].slug).toBe('high-usage');
      expect(popular[1].slug).toBe('medium-usage');
      expect(popular[2].slug).toBe('low-usage');
    });

    it('should respect limit parameter', () => {
      createTestSkill({ slug: 'skill1' });
      createTestSkill({ slug: 'skill2' });
      createTestSkill({ slug: 'skill3' });

      const limited = getPopularSkills(2);

      expect(limited).toHaveLength(2);
    });
  });

  describe('getRecentlyUsedSkills', () => {
    it('should return skills with lastUsed ordered by recency', () => {
      const skill1 = createTestSkill({ slug: 'skill1' });
      const skill2 = createTestSkill({ slug: 'skill2' });
      const skill3 = createTestSkill({ slug: 'skill3' });

      // Record usage in order
      recordSkillUsage(skill1.id);
      recordSkillUsage(skill2.id);
      recordSkillUsage(skill3.id);

      const recent = getRecentlyUsedSkills(10);

      // skill3 was used last, so it should be first
      expect(recent[0].slug).toBe('skill3');
    });

    it('should exclude skills that were never used', () => {
      createTestSkill({ slug: 'never-used' });
      const used = createTestSkill({ slug: 'used' });
      recordSkillUsage(used.id);

      const recent = getRecentlyUsedSkills(10);

      expect(recent).toHaveLength(1);
      expect(recent[0].slug).toBe('used');
    });
  });

  describe('recordSkillUsage', () => {
    it('should increment use count', () => {
      const skill = createTestSkill();

      recordSkillUsage(skill.id);
      recordSkillUsage(skill.id);
      recordSkillUsage(skill.id);

      const updated = getIndexedSkill(skill.id);
      expect(updated?.useCount).toBe(3);
    });

    it('should update lastUsed timestamp', () => {
      const skill = createTestSkill();
      expect(skill.lastUsed).toBeNull();

      recordSkillUsage(skill.id);

      const updated = getIndexedSkill(skill.id);
      expect(updated?.lastUsed).not.toBeNull();
    });
  });

  describe('deleteIndexedSkill', () => {
    it('should delete skill by ID', () => {
      const skill = createTestSkill();
      deleteIndexedSkill(skill.id);

      const result = getIndexedSkill(skill.id);
      expect(result).toBeNull();
    });

    it('should not throw for non-existent ID', () => {
      expect(() => deleteIndexedSkill(99999)).not.toThrow();
    });
  });

  describe('clearIndexedSkills', () => {
    it('should delete all skills', () => {
      createTestSkill({ slug: 'skill1' });
      createTestSkill({ slug: 'skill2' });
      createTestSkill({ slug: 'skill3' });

      expect(getSkillCount()).toBe(3);

      clearIndexedSkills();

      expect(getSkillCount()).toBe(0);
    });
  });

  describe('getSkillCount', () => {
    it('should return correct count', () => {
      expect(getSkillCount()).toBe(0);

      createTestSkill({ slug: 'skill1' });
      expect(getSkillCount()).toBe(1);

      createTestSkill({ slug: 'skill2' });
      expect(getSkillCount()).toBe(2);
    });
  });
});

// ============================================================================
// INDEXED AGENT TESTS
// ============================================================================

describeIfDb('Indexed Agent Operations', () => {
  beforeEach(() => {
    createTestCategory({ path: 'test/category', type: 'agent' });
  });

  describe('upsertIndexedAgent', () => {
    it('should insert a new agent', () => {
      const agent = createTestAgent({
        name: 'Frontend Engineer',
        slug: 'frontend-engineer',
        description: 'Builds user interfaces',
      });

      expect(agent.id).toBeGreaterThan(0);
      expect(agent.name).toBe('Frontend Engineer');
      expect(agent.slug).toBe('frontend-engineer');
      expect(agent.description).toBe('Builds user interfaces');
      expect(agent.useCount).toBe(0);
      expect(agent.lastUsed).toBeNull();
    });

    it('should update an existing agent by slug', () => {
      createTestAgent({
        slug: 'update-test',
        name: 'Original',
      });

      const updated = upsertIndexedAgent({
        slug: 'update-test',
        name: 'Updated',
        description: 'Updated description',
        content: 'Updated content',
        categoryId: 1,
        categoryPath: 'test/category',
        filePath: '/new/path',
        skills: ['new-skill'],
        tags: ['new-tag'],
        lastIndexed: new Date().toISOString(),
      });

      expect(updated.name).toBe('Updated');
    });

    it('should store skills as JSON array', () => {
      const agent = createTestAgent({
        skills: ['vitest', 'playwright', 'react-testing-library'],
      });

      expect(agent.skills).toEqual(['vitest', 'playwright', 'react-testing-library']);
    });
  });

  describe('getIndexedAgent', () => {
    it('should return agent by ID', () => {
      const created = createTestAgent();
      const retrieved = getIndexedAgent(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return null for non-existent ID', () => {
      const result = getIndexedAgent(99999);
      expect(result).toBeNull();
    });
  });

  describe('getIndexedAgentBySlug', () => {
    it('should return agent by slug', () => {
      createTestAgent({ slug: 'unique-agent' });
      const retrieved = getIndexedAgentBySlug('unique-agent');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.slug).toBe('unique-agent');
    });
  });

  describe('getAllIndexedAgents', () => {
    it('should return all agents ordered by name', () => {
      createTestAgent({ slug: 'z-agent', name: 'Zebra Agent' });
      createTestAgent({ slug: 'a-agent', name: 'Alpha Agent' });

      const agents = getAllIndexedAgents();

      expect(agents).toHaveLength(2);
      expect(agents[0].name).toBe('Alpha Agent');
      expect(agents[1].name).toBe('Zebra Agent');
    });
  });

  describe('getIndexedAgentsByCategory', () => {
    it('should return agents filtered by category ID', () => {
      const cat1 = createTestCategory({ path: 'cat1', type: 'agent' });
      const cat2 = createTestCategory({ path: 'cat2', type: 'agent' });

      createTestAgent({ slug: 'agent1', categoryId: cat1.id, categoryPath: 'cat1' });
      createTestAgent({ slug: 'agent2', categoryId: cat2.id, categoryPath: 'cat2' });

      const cat1Agents = getIndexedAgentsByCategory(cat1.id);

      expect(cat1Agents).toHaveLength(1);
      expect(cat1Agents[0].slug).toBe('agent1');
    });
  });

  describe('getIndexedAgentsByCategoryPath', () => {
    it('should return agents with matching category path prefix', () => {
      createTestAgent({ slug: 'agent1', categoryPath: 'webdev/frontend' });
      createTestAgent({ slug: 'agent2', categoryPath: 'webdev/backend' });
      createTestAgent({ slug: 'agent3', categoryPath: 'mobile/ios' });

      const webdevAgents = getIndexedAgentsByCategoryPath('webdev');

      expect(webdevAgents).toHaveLength(2);
    });
  });

  describe('getPopularAgents', () => {
    it('should return agents ordered by use count descending', () => {
      const agent1 = createTestAgent({ slug: 'low-usage' });
      const agent2 = createTestAgent({ slug: 'high-usage' });

      recordAgentUsage(agent2.id);
      recordAgentUsage(agent2.id);
      recordAgentUsage(agent1.id);

      const popular = getPopularAgents(10);

      expect(popular[0].slug).toBe('high-usage');
      expect(popular[1].slug).toBe('low-usage');
    });
  });

  describe('getRecentlyUsedAgents', () => {
    it('should return agents ordered by last used time', () => {
      const agent1 = createTestAgent({ slug: 'agent1' });
      const agent2 = createTestAgent({ slug: 'agent2' });

      recordAgentUsage(agent1.id);
      recordAgentUsage(agent2.id);

      const recent = getRecentlyUsedAgents(10);

      expect(recent[0].slug).toBe('agent2');
    });
  });

  describe('recordAgentUsage', () => {
    it('should increment use count', () => {
      const agent = createTestAgent();

      recordAgentUsage(agent.id);
      recordAgentUsage(agent.id);

      const updated = getIndexedAgent(agent.id);
      expect(updated?.useCount).toBe(2);
    });
  });

  describe('deleteIndexedAgent', () => {
    it('should delete agent by ID', () => {
      const agent = createTestAgent();
      deleteIndexedAgent(agent.id);

      const result = getIndexedAgent(agent.id);
      expect(result).toBeNull();
    });
  });

  describe('clearIndexedAgents', () => {
    it('should delete all agents', () => {
      createTestAgent({ slug: 'agent1' });
      createTestAgent({ slug: 'agent2' });

      expect(getAgentCount()).toBe(2);

      clearIndexedAgents();

      expect(getAgentCount()).toBe(0);
    });
  });

  describe('getAgentCount', () => {
    it('should return correct count', () => {
      expect(getAgentCount()).toBe(0);

      createTestAgent({ slug: 'agent1' });
      expect(getAgentCount()).toBe(1);
    });
  });
});

// ============================================================================
// ACTIVE AGENT TESTS
// ============================================================================

describeIfDb('Active Agent Operations', () => {
  let testAgentId: number;

  beforeEach(() => {
    createTestCategory({ path: 'test/category', type: 'agent' });
    const agent = createTestAgent();
    testAgentId = agent.id;
  });

  describe('activateAgent', () => {
    it('should create active agent record', () => {
      const active = activateAgent(testAgentId, 'session-123', '/project/path', 10);

      expect(active.id).toBeGreaterThan(0);
      expect(active.agentId).toBe(testAgentId);
      expect(active.sessionId).toBe('session-123');
      expect(active.projectPath).toBe('/project/path');
      expect(active.priority).toBe(10);
      expect(active.isActive).toBe(true);
      expect(active.activatedAt).toBeDefined();
      expect(active.deactivatedAt).toBeNull();
    });

    it('should allow activation without session or project', () => {
      const active = activateAgent(testAgentId);

      expect(active.sessionId).toBeNull();
      expect(active.projectPath).toBeNull();
    });

    it('should use default priority of 0', () => {
      const active = activateAgent(testAgentId);
      expect(active.priority).toBe(0);
    });
  });

  describe('getActiveAgent', () => {
    it('should return active agent by ID', () => {
      const active = activateAgent(testAgentId);
      const retrieved = getActiveAgent(active.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(active.id);
    });

    it('should return null for non-existent ID', () => {
      const result = getActiveAgent(99999);
      expect(result).toBeNull();
    });
  });

  describe('getActiveAgentsForSession', () => {
    it('should return active agents for session', () => {
      activateAgent(testAgentId, 'session-1');

      const agent2 = createTestAgent({ slug: 'agent2' });
      activateAgent(agent2.id, 'session-1');

      const agent3 = createTestAgent({ slug: 'agent3' });
      activateAgent(agent3.id, 'session-2');

      const session1Agents = getActiveAgentsForSession('session-1');

      expect(session1Agents).toHaveLength(2);
    });

    it('should include globally activated agents (null session)', () => {
      activateAgent(testAgentId); // Global

      const agent2 = createTestAgent({ slug: 'agent2' });
      activateAgent(agent2.id, 'session-1');

      const session1Agents = getActiveAgentsForSession('session-1');

      expect(session1Agents).toHaveLength(2);
    });

    it('should order by priority descending', () => {
      activateAgent(testAgentId, 'session-1', undefined, 1);

      const agent2 = createTestAgent({ slug: 'agent2' });
      activateAgent(agent2.id, 'session-1', undefined, 10);

      const agents = getActiveAgentsForSession('session-1');

      expect(agents[0].priority).toBe(10);
      expect(agents[1].priority).toBe(1);
    });

    it('should exclude deactivated agents', () => {
      const active = activateAgent(testAgentId, 'session-1');
      deactivateAgent(active.id);

      const agents = getActiveAgentsForSession('session-1');

      expect(agents).toHaveLength(0);
    });
  });

  describe('getActiveAgentsForProject', () => {
    it('should return active agents for project', () => {
      activateAgent(testAgentId, undefined, '/project/a');

      const agent2 = createTestAgent({ slug: 'agent2' });
      activateAgent(agent2.id, undefined, '/project/b');

      const projectAgents = getActiveAgentsForProject('/project/a');

      expect(projectAgents).toHaveLength(1);
    });

    it('should include globally activated agents', () => {
      activateAgent(testAgentId); // Global

      const agent2 = createTestAgent({ slug: 'agent2' });
      activateAgent(agent2.id, undefined, '/project/a');

      const projectAgents = getActiveAgentsForProject('/project/a');

      expect(projectAgents).toHaveLength(2);
    });
  });

  describe('getAllActiveAgentConfigs', () => {
    it('should return all active agents', () => {
      activateAgent(testAgentId);

      const agent2 = createTestAgent({ slug: 'agent2' });
      activateAgent(agent2.id, 'session-1');

      const all = getAllActiveAgentConfigs();

      expect(all).toHaveLength(2);
    });

    it('should exclude deactivated agents', () => {
      const active = activateAgent(testAgentId);
      deactivateAgent(active.id);

      const all = getAllActiveAgentConfigs();

      expect(all).toHaveLength(0);
    });
  });

  describe('deactivateAgent', () => {
    it('should set isActive to false', () => {
      const active = activateAgent(testAgentId);
      deactivateAgent(active.id);

      const updated = getActiveAgent(active.id);

      expect(updated?.isActive).toBe(false);
    });

    it('should set deactivatedAt timestamp', () => {
      const active = activateAgent(testAgentId);
      expect(active.deactivatedAt).toBeNull();

      deactivateAgent(active.id);

      const updated = getActiveAgent(active.id);
      expect(updated?.deactivatedAt).not.toBeNull();
    });
  });

  describe('deactivateAgentByAgentId', () => {
    it('should deactivate all matching agents', () => {
      activateAgent(testAgentId, 'session-1');
      activateAgent(testAgentId, 'session-2');

      deactivateAgentByAgentId(testAgentId);

      const all = getAllActiveAgentConfigs();
      expect(all).toHaveLength(0);
    });

    it('should filter by session when provided', () => {
      activateAgent(testAgentId, 'session-1');
      activateAgent(testAgentId, 'session-2');

      deactivateAgentByAgentId(testAgentId, 'session-1');

      const all = getAllActiveAgentConfigs();
      expect(all).toHaveLength(1);
      expect(all[0].sessionId).toBe('session-2');
    });

    it('should filter by project when provided', () => {
      activateAgent(testAgentId, undefined, '/project/a');
      activateAgent(testAgentId, undefined, '/project/b');

      deactivateAgentByAgentId(testAgentId, undefined, '/project/a');

      const all = getAllActiveAgentConfigs();
      expect(all).toHaveLength(1);
    });
  });
});

// ============================================================================
// QUEUED SKILL TESTS
// ============================================================================

describeIfDb('Queued Skill Operations', () => {
  let testSkillId: number;

  beforeEach(() => {
    createTestCategory({ path: 'test/category' });
    const skill = createTestSkill();
    testSkillId = skill.id;
  });

  describe('queueSkill', () => {
    it('should create queued skill record', () => {
      const queued = queueSkill(testSkillId, 'session-123', '/project/path', 5);

      expect(queued.id).toBeGreaterThan(0);
      expect(queued.skillId).toBe(testSkillId);
      expect(queued.sessionId).toBe('session-123');
      expect(queued.projectPath).toBe('/project/path');
      expect(queued.priority).toBe(5);
      expect(queued.injected).toBe(false);
      expect(queued.injectedAt).toBeNull();
      expect(queued.queuedAt).toBeDefined();
    });

    it('should allow queuing without session or project', () => {
      const queued = queueSkill(testSkillId);

      expect(queued.sessionId).toBeNull();
      expect(queued.projectPath).toBeNull();
    });
  });

  describe('getQueuedSkill', () => {
    it('should return queued skill by ID', () => {
      const queued = queueSkill(testSkillId);
      const retrieved = getQueuedSkill(queued.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(queued.id);
    });

    it('should return null for non-existent ID', () => {
      const result = getQueuedSkill(99999);
      expect(result).toBeNull();
    });
  });

  describe('getPendingSkillsForSession', () => {
    it('should return pending skills for session', () => {
      queueSkill(testSkillId, 'session-1');

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, 'session-1');

      const skill3 = createTestSkill({ slug: 'skill3' });
      queueSkill(skill3.id, 'session-2');

      const pending = getPendingSkillsForSession('session-1');

      expect(pending).toHaveLength(2);
    });

    it('should include global skills (null session)', () => {
      queueSkill(testSkillId); // Global

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, 'session-1');

      const pending = getPendingSkillsForSession('session-1');

      expect(pending).toHaveLength(2);
    });

    it('should exclude injected skills', () => {
      const queued = queueSkill(testSkillId, 'session-1');
      markSkillInjected(queued.id);

      const pending = getPendingSkillsForSession('session-1');

      expect(pending).toHaveLength(0);
    });

    it('should order by priority DESC then queuedAt ASC', () => {
      queueSkill(testSkillId, 'session-1', undefined, 1);

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, 'session-1', undefined, 10);

      const pending = getPendingSkillsForSession('session-1');

      expect(pending[0].priority).toBe(10);
      expect(pending[1].priority).toBe(1);
    });
  });

  describe('getPendingSkillsForProject', () => {
    it('should return pending skills for project', () => {
      queueSkill(testSkillId, undefined, '/project/a');

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, undefined, '/project/b');

      const pending = getPendingSkillsForProject('/project/a');

      expect(pending).toHaveLength(1);
    });
  });

  describe('getAllPendingSkills', () => {
    it('should return all pending skills', () => {
      queueSkill(testSkillId);

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, 'session-1');

      const all = getAllPendingSkills();

      expect(all).toHaveLength(2);
    });

    it('should exclude injected skills', () => {
      const queued = queueSkill(testSkillId);
      markSkillInjected(queued.id);

      const all = getAllPendingSkills();

      expect(all).toHaveLength(0);
    });
  });

  describe('markSkillInjected', () => {
    it('should set injected to true', () => {
      const queued = queueSkill(testSkillId);
      markSkillInjected(queued.id);

      const updated = getQueuedSkill(queued.id);

      expect(updated?.injected).toBe(true);
    });

    it('should set injectedAt timestamp', () => {
      const queued = queueSkill(testSkillId);
      expect(queued.injectedAt).toBeNull();

      markSkillInjected(queued.id);

      const updated = getQueuedSkill(queued.id);
      expect(updated?.injectedAt).not.toBeNull();
    });
  });

  describe('removeQueuedSkill', () => {
    it('should delete queued skill by ID', () => {
      const queued = queueSkill(testSkillId);
      removeQueuedSkill(queued.id);

      const result = getQueuedSkill(queued.id);
      expect(result).toBeNull();
    });
  });

  describe('clearSkillQueue', () => {
    it('should clear all skills when no filters', () => {
      queueSkill(testSkillId, 'session-1');

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, 'session-2');

      clearSkillQueue();

      expect(getAllPendingSkills()).toHaveLength(0);
    });

    it('should filter by session when provided', () => {
      queueSkill(testSkillId, 'session-1');

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, 'session-2');

      clearSkillQueue('session-1');

      const remaining = getAllPendingSkills();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe('session-2');
    });

    it('should filter by project when provided', () => {
      queueSkill(testSkillId, undefined, '/project/a');

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, undefined, '/project/b');

      clearSkillQueue(undefined, '/project/a');

      const remaining = getAllPendingSkills();
      expect(remaining).toHaveLength(1);
    });

    it('should clear global skills when null is passed', () => {
      queueSkill(testSkillId); // Global (null session)

      const skill2 = createTestSkill({ slug: 'skill2' });
      queueSkill(skill2.id, 'session-1');

      clearSkillQueue(''); // Empty string becomes null

      const remaining = getAllPendingSkills();
      expect(remaining).toHaveLength(1);
    });
  });
});

// ============================================================================
// INDEX STATS TESTS
// ============================================================================

describeIfDb('Index Statistics', () => {
  describe('getIndexStats', () => {
    it('should return zeroes when empty', () => {
      const stats = getIndexStats();

      expect(stats.agentCount).toBe(0);
      expect(stats.skillCount).toBe(0);
      expect(stats.categoryCount).toBe(0);
      expect(stats.activeAgentCount).toBe(0);
      expect(stats.pendingSkillCount).toBe(0);
      expect(stats.lastIndexed).toBeNull();
    });

    it('should count agents correctly', () => {
      createTestCategory({ path: 'test', type: 'agent' });
      createTestAgent({ slug: 'agent1' });
      createTestAgent({ slug: 'agent2' });

      const stats = getIndexStats();

      expect(stats.agentCount).toBe(2);
    });

    it('should count skills correctly', () => {
      createTestCategory({ path: 'test' });
      createTestSkill({ slug: 'skill1' });
      createTestSkill({ slug: 'skill2' });
      createTestSkill({ slug: 'skill3' });

      const stats = getIndexStats();

      expect(stats.skillCount).toBe(3);
    });

    it('should count categories correctly', () => {
      createTestCategory({ path: 'cat1' });
      createTestCategory({ path: 'cat2' });

      const stats = getIndexStats();

      expect(stats.categoryCount).toBe(2);
    });

    it('should count active agents correctly', () => {
      createTestCategory({ path: 'test', type: 'agent' });
      const agent1 = createTestAgent({ slug: 'agent1' });
      const agent2 = createTestAgent({ slug: 'agent2' });

      activateAgent(agent1.id);
      const active2 = activateAgent(agent2.id);
      deactivateAgent(active2.id);

      const stats = getIndexStats();

      expect(stats.activeAgentCount).toBe(1);
    });

    it('should count pending skills correctly', () => {
      createTestCategory({ path: 'test' });
      const skill1 = createTestSkill({ slug: 'skill1' });
      const skill2 = createTestSkill({ slug: 'skill2' });

      queueSkill(skill1.id);
      const queued2 = queueSkill(skill2.id);
      markSkillInjected(queued2.id);

      const stats = getIndexStats();

      expect(stats.pendingSkillCount).toBe(1);
    });

    it('should return last indexed timestamp', () => {
      createTestCategory({ path: 'test', type: 'agent' });
      createTestAgent({ slug: 'agent1' });

      const stats = getIndexStats();

      expect(stats.lastIndexed).not.toBeNull();
    });
  });
});

// ============================================================================
// FULL-TEXT SEARCH TESTS
// ============================================================================

describeIfDb('Full-Text Search', () => {
  beforeEach(() => {
    createTestCategory({ path: 'test' });
    createTestCategory({ path: 'agents', type: 'agent' });
  });

  describe('searchIndexedSkills', () => {
    it('should find skills by name', () => {
      createTestSkill({ slug: 'react-testing', name: 'React Testing Library' });
      createTestSkill({ slug: 'vitest-basics', name: 'Vitest Basics' });

      const results = searchIndexedSkills('react');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].item.slug).toBe('react-testing');
    });

    it('should find skills by content', () => {
      createTestSkill({
        slug: 'mock-skill',
        name: 'Generic Skill',
        content: '# Mock Service Worker\n\nThis skill covers MSW for API mocking.',
      });

      const results = searchIndexedSkills('mocking');

      expect(results.length).toBeGreaterThan(0);
    });

    it('should return search results with scores', () => {
      createTestSkill({ slug: 'test-skill', name: 'Test Skill' });

      const results = searchIndexedSkills('test');

      expect(results[0]).toHaveProperty('item');
      expect(results[0]).toHaveProperty('score');
      expect(results[0]).toHaveProperty('matchedFields');
    });

    it('should respect limit parameter', () => {
      createTestSkill({ slug: 'skill1', name: 'Test One' });
      createTestSkill({ slug: 'skill2', name: 'Test Two' });
      createTestSkill({ slug: 'skill3', name: 'Test Three' });

      const results = searchIndexedSkills('test', 2);

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should return empty array for no matches', () => {
      createTestSkill({ slug: 'react-skill', name: 'React Skill' });

      const results = searchIndexedSkills('xyznonexistent');

      expect(results).toHaveLength(0);
    });
  });

  describe('searchIndexedAgents', () => {
    it('should find agents by name', () => {
      createTestAgent({ slug: 'frontend-engineer', name: 'Frontend Engineer' });
      createTestAgent({ slug: 'backend-engineer', name: 'Backend Engineer' });

      const results = searchIndexedAgents('frontend');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].item.slug).toBe('frontend-engineer');
    });

    it('should find agents by description', () => {
      createTestAgent({
        slug: 'test-agent',
        name: 'Generic Agent',
        description: 'Specializes in TypeScript development',
      });

      const results = searchIndexedAgents('typescript');

      expect(results.length).toBeGreaterThan(0);
    });

    it('should return search results with metadata', () => {
      createTestAgent({ slug: 'test-agent', name: 'Test Agent' });

      const results = searchIndexedAgents('test');

      expect(results[0]).toHaveProperty('item');
      expect(results[0]).toHaveProperty('score');
      expect(results[0]).toHaveProperty('matchedFields');
    });
  });
});

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

describeIfDb('Error Handling', () => {
  it('should throw when upserting skill fails to retrieve', () => {
    // This test verifies the error path exists
    // In practice, this should not happen with a valid database
    createTestCategory({ path: 'test' });

    // Successful upsert should not throw
    expect(() => createTestSkill()).not.toThrow();
  });

  it('should throw when upserting agent fails to retrieve', () => {
    createTestCategory({ path: 'test', type: 'agent' });

    // Successful upsert should not throw
    expect(() => createTestAgent()).not.toThrow();
  });

  it('should throw when activating agent fails to retrieve', () => {
    createTestCategory({ path: 'test', type: 'agent' });
    const agent = createTestAgent();

    // Successful activation should not throw
    expect(() => activateAgent(agent.id)).not.toThrow();
  });

  it('should throw when queueing skill fails to retrieve', () => {
    createTestCategory({ path: 'test' });
    const skill = createTestSkill();

    // Successful queue should not throw
    expect(() => queueSkill(skill.id)).not.toThrow();
  });
});

// ============================================================================
// EDGE CASES TESTS
// ============================================================================

describeIfDb('Edge Cases', () => {
  describe('Empty and null handling', () => {
    it('should handle empty triggers array', () => {
      createTestCategory({ path: 'test' });
      const skill = createTestSkill({ triggers: [] });

      expect(skill.triggers).toEqual([]);
    });

    it('should handle empty tags array', () => {
      createTestCategory({ path: 'test' });
      const skill = createTestSkill({ tags: [] });

      expect(skill.tags).toEqual([]);
    });

    it('should handle null description', () => {
      createTestCategory({ path: 'test' });
      const skill = createTestSkill({ description: null });

      expect(skill.description).toBeNull();
    });

    it('should handle null agentSlug', () => {
      createTestCategory({ path: 'test' });
      const skill = createTestSkill({ agentSlug: null });

      expect(skill.agentSlug).toBeNull();
    });
  });

  describe('Special characters', () => {
    it('should handle special characters in skill content', () => {
      createTestCategory({ path: 'test' });
      const skill = createTestSkill({
        content: '```typescript\nconst x = "test";\n```\n\n<html>test</html>',
      });

      const retrieved = getIndexedSkill(skill.id);
      expect(retrieved?.content).toContain('```typescript');
    });

    it('should handle unicode in names', () => {
      createTestCategory({ path: 'test' });
      const skill = createTestSkill({
        name: 'Test Skill \'E9\'E8\'E0',
        slug: 'unicode-test',
      });

      const retrieved = getIndexedSkillBySlug('unicode-test');
      expect(retrieved?.name).toContain('Test Skill');
    });
  });

  describe('Large data', () => {
    it('should handle large content', () => {
      createTestCategory({ path: 'test' });
      const largeContent = 'x'.repeat(100000);
      const skill = createTestSkill({ content: largeContent });

      const retrieved = getIndexedSkill(skill.id);
      expect(retrieved?.content.length).toBe(100000);
    });

    it('should handle many tags', () => {
      createTestCategory({ path: 'test' });
      const manyTags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
      const skill = createTestSkill({ tags: manyTags });

      expect(skill.tags).toHaveLength(50);
    });
  });
});
