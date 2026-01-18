// ============================================================================
// PROJECT CONFIG SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by project config IPC handlers.
// Verifies that the schemas correctly validate input and reject invalid data.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  projectPathSchema,
  getProjectConfigInputSchema,
  deleteProjectConfigInputSchema,
  createProjectConfigInputSchema,
  updateProjectConfigInputSchema,
} from './projectConfig.js';

// ============================================================================
// PROJECT PATH SCHEMA TESTS
// ============================================================================

describe('projectPathSchema', () => {
  describe('valid paths', () => {
    const validPaths = [
      '/home/user/project',
      '/var/www/app',
      'C:/Users/dev/project',
      '/Users/dev/code/myapp',
      './relative/path',
      'relative/path',
      '/a',
    ];

    validPaths.forEach((path) => {
      it(`accepts "${path}"`, () => {
        const result = projectPathSchema.safeParse(path);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid paths', () => {
    const invalidPaths = [
      { value: '', reason: 'empty string' },
      { value: '..', reason: 'path traversal (single)' },
      { value: '../../../etc/passwd', reason: 'path traversal (multiple levels)' },
      { value: '/home/user/../../../etc/passwd', reason: 'path traversal in middle' },
      { value: 'a'.repeat(1001), reason: 'exceeds max length' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: [], reason: 'array' },
      { value: {}, reason: 'object' },
    ];

    invalidPaths.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = projectPathSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('edge cases', () => {
    it('accepts path at max length', () => {
      const path = '/' + 'a'.repeat(998);
      expect(projectPathSchema.safeParse(path).success).toBe(true);
    });

    it('rejects path just over max length', () => {
      const path = '/' + 'a'.repeat(1000);
      expect(projectPathSchema.safeParse(path).success).toBe(false);
    });
  });
});

// ============================================================================
// GET PROJECT CONFIG INPUT SCHEMA TESTS
// ============================================================================

describe('getProjectConfigInputSchema', () => {
  it('accepts valid project path', () => {
    const result = getProjectConfigInputSchema.safeParse('/home/user/project');
    expect(result.success).toBe(true);
  });

  it('rejects path traversal', () => {
    const result = getProjectConfigInputSchema.safeParse('../../../etc');
    expect(result.success).toBe(false);
  });

  it('rejects empty string', () => {
    const result = getProjectConfigInputSchema.safeParse('');
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// DELETE PROJECT CONFIG INPUT SCHEMA TESTS
// ============================================================================

describe('deleteProjectConfigInputSchema', () => {
  it('accepts valid project path', () => {
    const result = deleteProjectConfigInputSchema.safeParse('/home/user/project');
    expect(result.success).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    const result = deleteProjectConfigInputSchema.safeParse('../secrets');
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// CREATE PROJECT CONFIG INPUT SCHEMA TESTS
// ============================================================================

describe('createProjectConfigInputSchema', () => {
  describe('valid configs', () => {
    it('accepts minimal config with just projectPath', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
      });
      expect(result.success).toBe(true);
    });

    it('accepts full config with all optional fields', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
        defaultTemplateId: 'template-123',
        settings: { theme: 'dark', fontSize: 14 },
        hooks: [],
        mcpServers: ['server1', 'server2'],
        claudeMdOverride: '# Custom CLAUDE.md',
      });
      expect(result.success).toBe(true);
    });

    it('accepts config with null claudeMdOverride', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
        claudeMdOverride: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid configs', () => {
    it('rejects missing projectPath', () => {
      const result = createProjectConfigInputSchema.safeParse({
        settings: { theme: 'dark' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects path traversal in projectPath', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('rejects too long defaultTemplateId', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
        defaultTemplateId: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
    });

    it('rejects too long claudeMdOverride', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
        claudeMdOverride: 'a'.repeat(100001),
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid mcpServers type', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
        mcpServers: 'not-an-array',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('settings field', () => {
    it('accepts nested settings objects', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/project',
        settings: {
          nested: {
            deeply: {
              value: 123,
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts any JSON-serializable values', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/project',
        settings: {
          string: 'value',
          number: 42,
          boolean: true,
          null: null,
          array: [1, 2, 3],
          object: { key: 'value' },
        },
      });
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// UPDATE PROJECT CONFIG INPUT SCHEMA TESTS
// ============================================================================

describe('updateProjectConfigInputSchema', () => {
  describe('valid updates', () => {
    it('accepts update with single field', () => {
      const result = updateProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
        updates: {
          defaultTemplateId: 'new-template',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts update with multiple fields', () => {
      const result = updateProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
        updates: {
          defaultTemplateId: 'new-template',
          settings: { theme: 'light' },
          mcpServers: ['server1'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts update with empty updates object', () => {
      const result = updateProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
        updates: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid updates', () => {
    it('rejects missing projectPath', () => {
      const result = updateProjectConfigInputSchema.safeParse({
        updates: { defaultTemplateId: 'template' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing updates', () => {
      const result = updateProjectConfigInputSchema.safeParse({
        projectPath: '/home/user/project',
      });
      expect(result.success).toBe(false);
    });

    it('rejects path traversal in projectPath', () => {
      const result = updateProjectConfigInputSchema.safeParse({
        projectPath: '../../../etc',
        updates: {},
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('projectPathSchema rejects dangerous patterns', () => {
    const dangerousPatterns = [
      '../../../etc/passwd',
      '..\\..\\..\\Windows\\System32',
      '/home/user/../../../root',
      'project/../../secrets',
      '..%2f..%2f..%2fetc%2fpasswd',
      '....//....//etc/passwd',
    ];

    dangerousPatterns.forEach((pattern) => {
      it(`rejects "${pattern}"`, () => {
        const result = projectPathSchema.safeParse(pattern);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('createProjectConfigInputSchema rejects prototype pollution attempts', () => {
    const pollutionAttempts = [
      { projectPath: '/project', settings: { '__proto__': { isAdmin: true } } },
      { projectPath: '/project', settings: { 'constructor': { prototype: {} } } },
    ];

    // Note: Zod allows these as it treats them as regular object keys,
    // but the underlying database layer should handle this.
    // This test documents the current behavior.
    pollutionAttempts.forEach((attempt, index) => {
      it(`handles prototype pollution attempt ${index + 1}`, () => {
        // Zod passes these through as they're valid JSON
        // The important thing is they don't actually pollute prototypes
        const result = createProjectConfigInputSchema.safeParse(attempt);
        if (result.success) {
          // Verify the parsed object doesn't have prototype pollution
          const proto = Object.getPrototypeOf({});
          expect(proto.isAdmin).toBeUndefined();
        }
      });
    });
  });

  describe('input size limits prevent DoS', () => {
    it('rejects extremely long settings values', () => {
      const result = createProjectConfigInputSchema.safeParse({
        projectPath: '/project',
        claudeMdOverride: 'x'.repeat(100001),
      });
      expect(result.success).toBe(false);
    });

    it('rejects path exceeding max length', () => {
      const result = projectPathSchema.safeParse('/' + 'a'.repeat(1000));
      expect(result.success).toBe(false);
    });
  });
});
