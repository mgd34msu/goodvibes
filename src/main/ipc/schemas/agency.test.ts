// ============================================================================
// AGENCY SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by agency IPC handlers.
// Agency handlers manage agent/skill indexing and context injection,
// so proper validation is critical for data integrity.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  entityTypeSchema,
  slugSchema,
  categoryPathSchema,
  searchQuerySchema,
  prioritySchema,
  agencyInitConfigSchema,
  searchAgentsSchema,
  searchSkillsSchema,
  activateAgentSchema,
  deactivateAgentSchema,
  queueSkillSchema,
  clearSkillQueueSchema,
  contextInjectionSchema,
  workingDirectorySchema,
} from './agency.js';
import { paginationLimitSchema } from './primitives.js';

// ============================================================================
// ENTITY TYPE SCHEMA TESTS
// ============================================================================

describe('entityTypeSchema', () => {
  describe('valid entity types', () => {
    it('accepts "agent"', () => {
      const result = entityTypeSchema.safeParse('agent');
      expect(result.success).toBe(true);
    });

    it('accepts "skill"', () => {
      const result = entityTypeSchema.safeParse('skill');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid entity types', () => {
    const invalidTypes = [
      { value: '', reason: 'empty string' },
      { value: 'Agent', reason: 'capitalized' },
      { value: 'AGENT', reason: 'uppercase' },
      { value: 'template', reason: 'unknown type' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'object' },
    ];

    invalidTypes.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = entityTypeSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// SLUG SCHEMA TESTS
// ============================================================================

describe('slugSchema', () => {
  describe('valid slugs', () => {
    const validSlugs = [
      'simple',
      'with-dashes',
      'with123numbers',
      'a',
      'test-agent-1',
      'some-very-long-slug-name-here',
    ];

    validSlugs.forEach((slug) => {
      it(`accepts valid slug: "${slug}"`, () => {
        const result = slugSchema.safeParse(slug);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid slugs', () => {
    const invalidSlugs = [
      { value: '', reason: 'empty string' },
      { value: 'With-Caps', reason: 'contains uppercase' },
      { value: 'with_underscore', reason: 'contains underscore' },
      { value: 'with spaces', reason: 'contains spaces' },
      { value: 'with.dots', reason: 'contains dots' },
      { value: 'special!@#$', reason: 'special characters' },
      { value: 'a'.repeat(201), reason: 'exceeds max length' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
    ];

    invalidSlugs.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = slugSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('edge cases', () => {
    it('accepts slug at max length (200 chars)', () => {
      const slug = 'a'.repeat(200);
      const result = slugSchema.safeParse(slug);
      expect(result.success).toBe(true);
    });

    it('rejects slug just over max length', () => {
      const slug = 'a'.repeat(201);
      const result = slugSchema.safeParse(slug);
      expect(result.success).toBe(false);
    });

    it('accepts single character slug', () => {
      const result = slugSchema.safeParse('a');
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// CATEGORY PATH SCHEMA TESTS
// ============================================================================

describe('categoryPathSchema', () => {
  describe('valid category paths', () => {
    const validPaths = [
      'webdev',
      'webdev/frontend',
      'webdev/frontend/react',
      'tools/testing',
      'a',
    ];

    validPaths.forEach((path) => {
      it(`accepts valid path: "${path}"`, () => {
        const result = categoryPathSchema.safeParse(path);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid category paths', () => {
    const invalidPaths = [
      { value: '', reason: 'empty string' },
      { value: 'a'.repeat(501), reason: 'exceeds max length' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
    ];

    invalidPaths.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = categoryPathSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// SEARCH QUERY SCHEMA TESTS
// ============================================================================

describe('searchQuerySchema', () => {
  describe('valid queries', () => {
    const validQueries = [
      'test',
      'react hooks',
      'frontend development',
      'a',
      'query with special-chars_and.dots',
    ];

    validQueries.forEach((query) => {
      it(`accepts valid query: "${query}"`, () => {
        const result = searchQuerySchema.safeParse(query);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid queries', () => {
    const invalidQueries = [
      { value: '', reason: 'empty string' },
      { value: 'a'.repeat(501), reason: 'exceeds max length' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
    ];

    invalidQueries.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = searchQuerySchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// PAGINATION LIMIT SCHEMA TESTS
// ============================================================================

describe('paginationLimitSchema', () => {
  describe('valid limits', () => {
    it('accepts undefined (optional)', () => {
      const result = paginationLimitSchema.safeParse(undefined);
      expect(result.success).toBe(true);
    });

    it('accepts valid positive integer', () => {
      const result = paginationLimitSchema.safeParse(100);
      expect(result.success).toBe(true);
    });

    it('accepts minimum value (1)', () => {
      const result = paginationLimitSchema.safeParse(1);
      expect(result.success).toBe(true);
    });

    it('accepts maximum value (1000)', () => {
      const result = paginationLimitSchema.safeParse(1000);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid limits', () => {
    const invalidLimits = [
      { value: 0, reason: 'zero' },
      { value: -1, reason: 'negative' },
      { value: 1001, reason: 'exceeds max' },
      { value: 1.5, reason: 'decimal' },
      { value: '100', reason: 'string number' },
      { value: NaN, reason: 'NaN' },
      { value: Infinity, reason: 'Infinity' },
    ];

    invalidLimits.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = paginationLimitSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// PRIORITY SCHEMA TESTS
// ============================================================================

describe('prioritySchema', () => {
  describe('valid priorities', () => {
    it('accepts undefined (optional)', () => {
      const result = prioritySchema.safeParse(undefined);
      expect(result.success).toBe(true);
    });

    it('accepts zero', () => {
      const result = prioritySchema.safeParse(0);
      expect(result.success).toBe(true);
    });

    it('accepts positive integer', () => {
      const result = prioritySchema.safeParse(100);
      expect(result.success).toBe(true);
    });

    it('accepts maximum (1000)', () => {
      const result = prioritySchema.safeParse(1000);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid priorities', () => {
    const invalidPriorities = [
      { value: -1, reason: 'negative' },
      { value: 1001, reason: 'exceeds max' },
      { value: 1.5, reason: 'decimal' },
    ];

    invalidPriorities.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = prioritySchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// AGENCY INIT CONFIG SCHEMA TESTS
// ============================================================================

describe('agencyInitConfigSchema', () => {
  describe('valid configs', () => {
    it('accepts valid config', () => {
      const result = agencyInitConfigSchema.safeParse({
        agencyPath: '/path/to/agency',
      });
      expect(result.success).toBe(true);
    });

    it('accepts Windows path', () => {
      const result = agencyInitConfigSchema.safeParse({
        agencyPath: 'C:\\Users\\user\\agency',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid configs', () => {
    it('rejects empty agencyPath', () => {
      const result = agencyInitConfigSchema.safeParse({
        agencyPath: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing agencyPath', () => {
      const result = agencyInitConfigSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects path with traversal', () => {
      const result = agencyInitConfigSchema.safeParse({
        agencyPath: '/path/../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// SEARCH SCHEMAS TESTS
// ============================================================================

describe('searchAgentsSchema', () => {
  describe('valid inputs', () => {
    it('accepts query with limit', () => {
      const result = searchAgentsSchema.safeParse({
        query: 'react',
        limit: 10,
      });
      expect(result.success).toBe(true);
    });

    it('accepts query without limit', () => {
      const result = searchAgentsSchema.safeParse({
        query: 'react',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty query', () => {
      const result = searchAgentsSchema.safeParse({
        query: '',
        limit: 10,
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing query', () => {
      const result = searchAgentsSchema.safeParse({
        limit: 10,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid limit', () => {
      const result = searchAgentsSchema.safeParse({
        query: 'react',
        limit: -1,
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('searchSkillsSchema', () => {
  describe('valid inputs', () => {
    it('accepts query with limit', () => {
      const result = searchSkillsSchema.safeParse({
        query: 'testing',
        limit: 20,
      });
      expect(result.success).toBe(true);
    });

    it('accepts query without limit', () => {
      const result = searchSkillsSchema.safeParse({
        query: 'testing',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty query', () => {
      const result = searchSkillsSchema.safeParse({
        query: '',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// AGENT ACTIVATION SCHEMAS TESTS
// ============================================================================

describe('activateAgentSchema', () => {
  const validSessionId = '550e8400-e29b-41d4-a716-446655440000';

  describe('valid inputs', () => {
    it('accepts minimal valid input', () => {
      const result = activateAgentSchema.safeParse({
        agentId: 1,
      });
      expect(result.success).toBe(true);
    });

    it('accepts full input', () => {
      const result = activateAgentSchema.safeParse({
        agentId: 1,
        sessionId: validSessionId,
        projectPath: '/path/to/project',
        priority: 10,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects negative agentId', () => {
      const result = activateAgentSchema.safeParse({
        agentId: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects zero agentId', () => {
      const result = activateAgentSchema.safeParse({
        agentId: 0,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid sessionId', () => {
      const result = activateAgentSchema.safeParse({
        agentId: 1,
        sessionId: 'invalid-session',
      });
      expect(result.success).toBe(false);
    });

    it('rejects path with traversal', () => {
      const result = activateAgentSchema.safeParse({
        agentId: 1,
        projectPath: '../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('deactivateAgentSchema', () => {
  describe('valid inputs', () => {
    it('accepts minimal valid input', () => {
      const result = deactivateAgentSchema.safeParse({
        agentId: 1,
      });
      expect(result.success).toBe(true);
    });

    it('accepts full input', () => {
      const result = deactivateAgentSchema.safeParse({
        agentId: 1,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        projectPath: '/path/to/project',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing agentId', () => {
      const result = deactivateAgentSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// SKILL QUEUE SCHEMAS TESTS
// ============================================================================

describe('queueSkillSchema', () => {
  describe('valid inputs', () => {
    it('accepts minimal valid input', () => {
      const result = queueSkillSchema.safeParse({
        skillId: 1,
      });
      expect(result.success).toBe(true);
    });

    it('accepts full input', () => {
      const result = queueSkillSchema.safeParse({
        skillId: 1,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        projectPath: '/path/to/project',
        priority: 5,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects invalid skillId', () => {
      const result = queueSkillSchema.safeParse({
        skillId: 0,
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('clearSkillQueueSchema', () => {
  describe('valid inputs', () => {
    it('accepts empty input', () => {
      const result = clearSkillQueueSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts sessionId only', () => {
      const result = clearSkillQueueSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('accepts projectPath only', () => {
      const result = clearSkillQueueSchema.safeParse({
        projectPath: '/path/to/project',
      });
      expect(result.success).toBe(true);
    });

    it('accepts both sessionId and projectPath', () => {
      const result = clearSkillQueueSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        projectPath: '/path/to/project',
      });
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// CONTEXT INJECTION SCHEMAS TESTS
// ============================================================================

describe('contextInjectionSchema', () => {
  const validInput = {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    projectPath: '/path/to/project',
    workingDirectory: '/path/to/working/dir',
  };

  describe('valid inputs', () => {
    it('accepts valid input', () => {
      const result = contextInjectionSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('accepts Windows paths', () => {
      const result = contextInjectionSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        projectPath: 'C:\\Users\\user\\project',
        workingDirectory: 'C:\\Users\\user\\working',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing sessionId', () => {
      const result = contextInjectionSchema.safeParse({
        projectPath: '/path/to/project',
        workingDirectory: '/path/to/working/dir',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing projectPath', () => {
      const result = contextInjectionSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        workingDirectory: '/path/to/working/dir',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing workingDirectory', () => {
      const result = contextInjectionSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        projectPath: '/path/to/project',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid sessionId', () => {
      const result = contextInjectionSchema.safeParse({
        ...validInput,
        sessionId: 'invalid',
      });
      expect(result.success).toBe(false);
    });

    it('rejects path with traversal', () => {
      const result = contextInjectionSchema.safeParse({
        ...validInput,
        projectPath: '../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('workingDirectorySchema', () => {
  describe('valid paths', () => {
    const validPaths = [
      '/home/user/project',
      'C:\\Users\\user\\project',
      '/tmp/test',
      'relative/path',
    ];

    validPaths.forEach((path) => {
      it(`accepts valid path: "${path}"`, () => {
        const result = workingDirectorySchema.safeParse(path);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid paths', () => {
    it('rejects empty string', () => {
      const result = workingDirectorySchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('rejects path traversal', () => {
      const result = workingDirectorySchema.safeParse('../../../etc/passwd');
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = workingDirectorySchema.safeParse(null);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('Path traversal prevention', () => {
    const traversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/path/../../../etc/passwd',
      'C:\\path\\..\\..\\..\\windows',
    ];

    traversalPayloads.forEach((payload) => {
      it(`rejects path traversal: "${payload}"`, () => {
        const result = workingDirectorySchema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Injection prevention in search queries', () => {
    // Search queries should be treated as literal text
    const injectionPayloads = [
      "'; DROP TABLE agents; --",
      '$(whoami)',
      '`cat /etc/passwd`',
      '<script>alert(1)</script>',
    ];

    injectionPayloads.forEach((payload) => {
      it(`accepts but treats literally: "${payload.substring(0, 30)}"`, () => {
        // Schema accepts these as strings - sanitization happens at query level
        const result = searchQuerySchema.safeParse(payload);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Prototype pollution prevention', () => {
    it('handles __proto__ safely in composite schema', () => {
      const maliciousInput = JSON.parse(
        '{"__proto__": {"polluted": true}, "agentId": 1}'
      );
      const result = activateAgentSchema.safeParse(maliciousInput);
      expect(result.success).toBe(true);
      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Type coercion attacks', () => {
    it('rejects array where object expected', () => {
      const result = activateAgentSchema.safeParse([{ agentId: 1 }]);
      expect(result.success).toBe(false);
    });

    it('rejects string where number expected for agentId', () => {
      const result = activateAgentSchema.safeParse({
        agentId: '1',
      });
      expect(result.success).toBe(false);
    });
  });
});
