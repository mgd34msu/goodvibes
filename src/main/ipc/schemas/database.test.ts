// ============================================================================
// DATABASE SCHEMA TESTS
// ============================================================================
//
// Tests for database-related Zod validation schemas, including activity logs,
// collections, tags, prompts, notes, notifications, knowledge, and search.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  activityTypeSchema,
  activityDescriptionSchema,
  logActivityInputSchema,
  recentActivityLimitSchema,
  quickNoteStatusQuerySchema,
  searchTermSchema,
} from './database.js';
import {
  numericIdSchema,
  sessionIdSchema,
  hexColorSchema,
} from './primitives.js';
import {
  createCollectionSchema,
  updateCollectionSchema,
  sessionCollectionSchema,
  createSmartCollectionSchema,
} from './collections.js';
import { createTagSchema, sessionTagSchema } from './tags.js';
import { savePromptSchema } from './prompts.js';
import {
  createQuickNoteSchema,
  updateQuickNoteSchema,
  setQuickNoteStatusSchema,
  noteStatusQuerySchema,
} from './notes.js';
import { getNotificationsSchema } from './notifications.js';
import {
  createKnowledgeEntrySchema,
  updateKnowledgeEntrySchema,
} from './knowledge.js';
import {
  searchQuerySchema,
  advancedSearchOptionsSchema,
  saveSearchSchema,
} from './search.js';

// ============================================================================
// PRIMITIVE SCHEMA TESTS
// ============================================================================

describe('numericIdSchema', () => {
  it('accepts positive integers', () => {
    expect(numericIdSchema.safeParse(1).success).toBe(true);
    expect(numericIdSchema.safeParse(100).success).toBe(true);
    expect(numericIdSchema.safeParse(999999).success).toBe(true);
  });

  it('rejects zero and negative numbers', () => {
    expect(numericIdSchema.safeParse(0).success).toBe(false);
    expect(numericIdSchema.safeParse(-1).success).toBe(false);
    expect(numericIdSchema.safeParse(-100).success).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(numericIdSchema.safeParse(1.5).success).toBe(false);
    expect(numericIdSchema.safeParse(0.1).success).toBe(false);
  });

  it('rejects non-numbers', () => {
    expect(numericIdSchema.safeParse('1').success).toBe(false);
    expect(numericIdSchema.safeParse(null).success).toBe(false);
    expect(numericIdSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('sessionIdSchema', () => {
  it('accepts valid UUID format', () => {
    expect(sessionIdSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(true);
    expect(sessionIdSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
  });

  it('accepts agent- prefixed IDs', () => {
    expect(sessionIdSchema.safeParse('agent-abc123').success).toBe(true);
    expect(sessionIdSchema.safeParse('agent-xyz789').success).toBe(true);
  });

  it('rejects invalid formats', () => {
    expect(sessionIdSchema.safeParse('').success).toBe(false);
    expect(sessionIdSchema.safeParse('invalid').success).toBe(false);
    expect(sessionIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(sessionIdSchema.safeParse(123).success).toBe(false);
    expect(sessionIdSchema.safeParse(null).success).toBe(false);
  });
});

describe('hexColorSchema', () => {
  it('accepts valid hex colors', () => {
    expect(hexColorSchema.safeParse('#000000').success).toBe(true);
    expect(hexColorSchema.safeParse('#FFFFFF').success).toBe(true);
    expect(hexColorSchema.safeParse('#ff5733').success).toBe(true);
  });

  it('rejects invalid hex colors', () => {
    expect(hexColorSchema.safeParse('#fff').success).toBe(false);
    expect(hexColorSchema.safeParse('000000').success).toBe(false);
    expect(hexColorSchema.safeParse('#GGGGGG').success).toBe(false);
    expect(hexColorSchema.safeParse('#12345').success).toBe(false);
    expect(hexColorSchema.safeParse('#1234567').success).toBe(false);
  });
});

// ============================================================================
// ACTIVITY LOG SCHEMA TESTS
// ============================================================================

describe('activityTypeSchema', () => {
  it('accepts valid activity types', () => {
    expect(activityTypeSchema.safeParse('session_started').success).toBe(true);
    expect(activityTypeSchema.safeParse('user.action').success).toBe(true);
    expect(activityTypeSchema.safeParse('Task-Complete').success).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(activityTypeSchema.safeParse('').success).toBe(false);
  });

  it('rejects strings starting with non-letter', () => {
    expect(activityTypeSchema.safeParse('123type').success).toBe(false);
    expect(activityTypeSchema.safeParse('_type').success).toBe(false);
  });

  it('rejects overly long strings', () => {
    expect(activityTypeSchema.safeParse('a'.repeat(101)).success).toBe(false);
  });
});

describe('activityDescriptionSchema', () => {
  it('accepts valid descriptions', () => {
    expect(activityDescriptionSchema.safeParse('User created a new session').success).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(activityDescriptionSchema.safeParse('').success).toBe(false);
  });

  it('rejects overly long strings', () => {
    expect(activityDescriptionSchema.safeParse('a'.repeat(5001)).success).toBe(false);
  });
});

describe('logActivityInputSchema', () => {
  it('accepts valid activity log input', () => {
    const result = logActivityInputSchema.safeParse({
      type: 'session_started',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Session started',
      metadata: { key: 'value' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts null sessionId', () => {
    const result = logActivityInputSchema.safeParse({
      type: 'app_started',
      sessionId: null,
      description: 'Application started',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(logActivityInputSchema.safeParse({}).success).toBe(false);
    expect(logActivityInputSchema.safeParse({ type: 'test' }).success).toBe(false);
  });
});

describe('recentActivityLimitSchema', () => {
  it('accepts valid limits', () => {
    expect(recentActivityLimitSchema.safeParse(10).success).toBe(true);
    expect(recentActivityLimitSchema.safeParse(100).success).toBe(true);
    expect(recentActivityLimitSchema.safeParse(1000).success).toBe(true);
  });

  it('accepts undefined', () => {
    expect(recentActivityLimitSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejects invalid limits', () => {
    expect(recentActivityLimitSchema.safeParse(0).success).toBe(false);
    expect(recentActivityLimitSchema.safeParse(-1).success).toBe(false);
    expect(recentActivityLimitSchema.safeParse(1001).success).toBe(false);
    expect(recentActivityLimitSchema.safeParse(1.5).success).toBe(false);
  });
});

// ============================================================================
// COLLECTION SCHEMA TESTS
// ============================================================================

describe('createCollectionSchema', () => {
  it('accepts valid collection data', () => {
    expect(createCollectionSchema.safeParse({ name: 'My Collection' }).success).toBe(true);
    expect(createCollectionSchema.safeParse({ name: 'Test', color: '#ff0000' }).success).toBe(true);
    expect(createCollectionSchema.safeParse({ name: 'Test', color: '#ff0000', icon: 'folder' }).success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(createCollectionSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects overly long name', () => {
    expect(createCollectionSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });

  it('rejects invalid color', () => {
    expect(createCollectionSchema.safeParse({ name: 'Test', color: 'red' }).success).toBe(false);
  });
});

describe('updateCollectionSchema', () => {
  it('accepts valid update data', () => {
    const result = updateCollectionSchema.safeParse({
      id: 1,
      name: 'Updated Collection',
      color: '#ff0000',
      icon: 'folder',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid id', () => {
    const result = updateCollectionSchema.safeParse({
      id: -1,
      name: 'Test',
      color: '#ff0000',
      icon: 'folder',
    });
    expect(result.success).toBe(false);
  });
});

describe('sessionCollectionSchema', () => {
  it('accepts valid session-collection data', () => {
    const result = sessionCollectionSchema.safeParse({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      collectionId: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid session ID', () => {
    const result = sessionCollectionSchema.safeParse({
      sessionId: 'invalid',
      collectionId: 1,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// TAG SCHEMA TESTS
// ============================================================================

describe('createTagSchema', () => {
  it('accepts valid tag data', () => {
    expect(createTagSchema.safeParse({ name: 'Important', color: '#ff0000' }).success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(createTagSchema.safeParse({ name: '', color: '#ff0000' }).success).toBe(false);
  });

  it('rejects invalid color', () => {
    expect(createTagSchema.safeParse({ name: 'Test', color: 'invalid' }).success).toBe(false);
  });
});

describe('sessionTagSchema', () => {
  it('accepts valid session-tag data', () => {
    const result = sessionTagSchema.safeParse({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      tagId: 1,
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// PROMPT SCHEMA TESTS
// ============================================================================

describe('savePromptSchema', () => {
  it('accepts valid prompt data', () => {
    expect(savePromptSchema.safeParse({ title: 'My Prompt', content: 'Content here' }).success).toBe(true);
    expect(savePromptSchema.safeParse({ title: 'Test', content: 'Test', category: 'General' }).success).toBe(true);
  });

  it('rejects empty title', () => {
    expect(savePromptSchema.safeParse({ title: '', content: 'Content' }).success).toBe(false);
  });

  it('rejects empty content', () => {
    expect(savePromptSchema.safeParse({ title: 'Title', content: '' }).success).toBe(false);
  });

  it('rejects overly long content', () => {
    expect(savePromptSchema.safeParse({ title: 'Title', content: 'a'.repeat(50001) }).success).toBe(false);
  });
});

// ============================================================================
// NOTES SCHEMA TESTS
// ============================================================================

describe('noteStatusQuerySchema', () => {
  it('accepts valid status values', () => {
    expect(noteStatusQuerySchema.safeParse('active').success).toBe(true);
    expect(noteStatusQuerySchema.safeParse('completed').success).toBe(true);
    expect(noteStatusQuerySchema.safeParse('archived').success).toBe(true);
  });

  it('rejects invalid status values', () => {
    expect(noteStatusQuerySchema.safeParse('invalid').success).toBe(false);
    expect(noteStatusQuerySchema.safeParse('').success).toBe(false);
  });
});

describe('createQuickNoteSchema', () => {
  it('accepts valid note data', () => {
    expect(createQuickNoteSchema.safeParse({ content: 'My note' }).success).toBe(true);
    expect(createQuickNoteSchema.safeParse({ content: 'Note', priority: 'high' }).success).toBe(true);
  });

  it('rejects empty content', () => {
    expect(createQuickNoteSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('rejects invalid priority', () => {
    expect(createQuickNoteSchema.safeParse({ content: 'Test', priority: 'urgent' }).success).toBe(false);
  });
});

// ============================================================================
// NOTIFICATION SCHEMA TESTS
// ============================================================================

describe('getNotificationsSchema', () => {
  it('accepts valid query parameters', () => {
    expect(getNotificationsSchema.safeParse({}).success).toBe(true);
    expect(getNotificationsSchema.safeParse({ includeRead: true }).success).toBe(true);
    expect(getNotificationsSchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(getNotificationsSchema.safeParse({ includeRead: false, limit: 100 }).success).toBe(true);
  });

  it('rejects invalid limit', () => {
    expect(getNotificationsSchema.safeParse({ limit: -1 }).success).toBe(false);
    expect(getNotificationsSchema.safeParse({ limit: 1001 }).success).toBe(false);
  });
});

// ============================================================================
// KNOWLEDGE SCHEMA TESTS
// ============================================================================

describe('createKnowledgeEntrySchema', () => {
  it('accepts valid knowledge entry data', () => {
    expect(createKnowledgeEntrySchema.safeParse({ title: 'Title', content: 'Content' }).success).toBe(true);
    expect(createKnowledgeEntrySchema.safeParse({
      title: 'Title',
      content: 'Content',
      category: 'Category',
      tags: 'tag1,tag2',
    }).success).toBe(true);
  });

  it('rejects empty title', () => {
    expect(createKnowledgeEntrySchema.safeParse({ title: '', content: 'Content' }).success).toBe(false);
  });

  it('rejects empty content', () => {
    expect(createKnowledgeEntrySchema.safeParse({ title: 'Title', content: '' }).success).toBe(false);
  });
});

// ============================================================================
// SEARCH SCHEMA TESTS
// ============================================================================

describe('searchQuerySchema', () => {
  it('accepts valid search queries', () => {
    expect(searchQuerySchema.safeParse('search term').success).toBe(true);
    expect(searchQuerySchema.safeParse('').success).toBe(true);
  });

  it('rejects overly long queries', () => {
    expect(searchQuerySchema.safeParse('a'.repeat(1001)).success).toBe(false);
  });
});

describe('advancedSearchOptionsSchema', () => {
  it('accepts valid search options', () => {
    expect(advancedSearchOptionsSchema.safeParse({}).success).toBe(true);
    expect(advancedSearchOptionsSchema.safeParse({ query: 'test' }).success).toBe(true);
    expect(advancedSearchOptionsSchema.safeParse({
      query: 'test',
      sortBy: 'date',
      sortOrder: 'desc',
      limit: 50,
    }).success).toBe(true);
  });

  it('rejects invalid sort values', () => {
    expect(advancedSearchOptionsSchema.safeParse({ sortBy: 'invalid' }).success).toBe(false);
    expect(advancedSearchOptionsSchema.safeParse({ sortOrder: 'invalid' }).success).toBe(false);
  });
});

describe('saveSearchSchema', () => {
  it('accepts valid saved search data', () => {
    expect(saveSearchSchema.safeParse({ name: 'My Search', query: 'test' }).success).toBe(true);
    expect(saveSearchSchema.safeParse({
      name: 'My Search',
      query: 'test',
      filters: { project: 'myproject' },
    }).success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(saveSearchSchema.safeParse({ name: '', query: 'test' }).success).toBe(false);
  });
});

// ============================================================================
// SQL INJECTION PREVENTION TESTS
// ============================================================================

describe('SQL Injection Prevention', () => {
  it('searchQuerySchema allows but does not execute SQL', () => {
    // These should be accepted as strings (the actual SQL protection is at the database layer)
    // but we verify they don't cause parse errors
    const result = searchQuerySchema.safeParse("'; DROP TABLE users; --");
    expect(result.success).toBe(true);
    // The value is just a string, not executed SQL
    if (result.success) {
      expect(typeof result.data).toBe('string');
    }
  });

  it('searchTermSchema trims input', () => {
    const result = searchTermSchema.safeParse('  test  ');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('test');
    }
  });

  it('activityTypeSchema rejects suspicious patterns', () => {
    // Activity type must start with a letter and only allow alphanumeric, underscore, dot, dash
    expect(activityTypeSchema.safeParse("'; DROP TABLE --").success).toBe(false);
    expect(activityTypeSchema.safeParse('<script>').success).toBe(false);
  });
});
