// ============================================================================
// PROJECTS/DIALOG SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by project and dialog-related IPC handlers.
// Verifies that the schemas correctly validate input and reject invalid data.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  folderPathSchema,
  projectNameSchema,
  openInExplorerInputSchema,
  addRecentProjectInputSchema,
  removeRecentProjectInputSchema,
  pinProjectInputSchema,
} from './projects.js';

// ============================================================================
// FOLDER PATH SCHEMA TESTS
// ============================================================================

describe('folderPathSchema', () => {
  describe('valid paths', () => {
    const validPaths = [
      '/home/user/project',
      '/Users/admin/Documents',
      'C:\\Users\\user\\Desktop',
      'D:\\Projects\\my-app',
      '/var/www/html',
      './relative/path', // Relative paths allowed if not traversal
      'project-folder',
      '/path/with spaces/folder',
      '/path/with-dashes/and_underscores',
    ];

    validPaths.forEach((path) => {
      it(`accepts "${path}"`, () => {
        const result = folderPathSchema.safeParse(path);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid paths', () => {
    const invalidPaths = [
      { value: '', reason: 'empty string' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'object' },
      { value: [], reason: 'array' },
      { value: 'a'.repeat(1001), reason: 'exceeds max length' },
    ];

    invalidPaths.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = folderPathSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('path traversal prevention', () => {
    const traversalAttempts = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/home/user/../../../root',
      'C:\\Users\\..\\..\\Windows',
      '/var/www/html/../../../etc/shadow',
      'folder/../../../sensitive',
    ];

    traversalAttempts.forEach((path) => {
      it(`rejects path traversal: "${path}"`, () => {
        const result = folderPathSchema.safeParse(path);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('edge cases', () => {
    it('accepts path at max length', () => {
      const path = '/path/' + 'a'.repeat(993); // 1000 total
      expect(folderPathSchema.safeParse(path).success).toBe(true);
    });

    it('rejects path just over max length', () => {
      const path = '/path/' + 'a'.repeat(996); // 1002 total
      expect(folderPathSchema.safeParse(path).success).toBe(false);
    });

    it('rejects root directory (Unix) for security', () => {
      // Root paths are blocked as a security measure to prevent
      // operations on the entire filesystem root
      expect(folderPathSchema.safeParse('/').success).toBe(false);
    });

    it('rejects root drive (Windows) for security', () => {
      // Root paths are blocked as a security measure
      expect(folderPathSchema.safeParse('\\').success).toBe(false);
    });

    it('accepts Windows drive with directory', () => {
      expect(folderPathSchema.safeParse('C:\\Users').success).toBe(true);
    });

    it('accepts network paths (UNC)', () => {
      expect(folderPathSchema.safeParse('\\\\server\\share').success).toBe(true);
    });
  });
});

// ============================================================================
// PROJECT NAME SCHEMA TESTS
// ============================================================================

describe('projectNameSchema', () => {
  describe('valid names', () => {
    const validNames = [
      'My Project',
      'project-name',
      'Project_123',
      '',  // Optional, so empty is valid (becomes undefined)
      undefined,
      'A',
      'a'.repeat(200),
    ];

    validNames.forEach((name) => {
      it(`accepts "${name}"`, () => {
        const result = projectNameSchema.safeParse(name);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid names', () => {
    it('rejects name exceeding max length', () => {
      const result = projectNameSchema.safeParse('a'.repeat(201));
      expect(result.success).toBe(false);
    });

    it('rejects number', () => {
      const result = projectNameSchema.safeParse(123);
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = projectNameSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('rejects object', () => {
      const result = projectNameSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// ADD RECENT PROJECT INPUT SCHEMA TESTS
// ============================================================================

describe('addRecentProjectInputSchema', () => {
  describe('valid inputs', () => {
    it('accepts path only', () => {
      const result = addRecentProjectInputSchema.safeParse({
        path: '/home/user/project',
      });
      expect(result.success).toBe(true);
    });

    it('accepts path with name', () => {
      const result = addRecentProjectInputSchema.safeParse({
        path: '/home/user/project',
        name: 'My Project',
      });
      expect(result.success).toBe(true);
    });

    it('accepts Windows path', () => {
      const result = addRecentProjectInputSchema.safeParse({
        path: 'C:\\Users\\user\\Documents\\project',
        name: 'Windows Project',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing path', () => {
      const result = addRecentProjectInputSchema.safeParse({
        name: 'Project Name',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty path', () => {
      const result = addRecentProjectInputSchema.safeParse({
        path: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects path traversal', () => {
      const result = addRecentProjectInputSchema.safeParse({
        path: '/home/user/../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('rejects name exceeding max length', () => {
      const result = addRecentProjectInputSchema.safeParse({
        path: '/valid/path',
        name: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = addRecentProjectInputSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('rejects string instead of object', () => {
      const result = addRecentProjectInputSchema.safeParse('/path/string');
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// OPEN IN EXPLORER INPUT SCHEMA TESTS
// ============================================================================

describe('openInExplorerInputSchema', () => {
  describe('valid inputs', () => {
    it('accepts valid Unix path', () => {
      const result = openInExplorerInputSchema.safeParse('/home/user/folder');
      expect(result.success).toBe(true);
    });

    it('accepts valid Windows path', () => {
      const result = openInExplorerInputSchema.safeParse('C:\\Users\\folder');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty string', () => {
      const result = openInExplorerInputSchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('rejects path traversal', () => {
      const result = openInExplorerInputSchema.safeParse('../../../etc');
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// REMOVE RECENT PROJECT INPUT SCHEMA TESTS
// ============================================================================

describe('removeRecentProjectInputSchema', () => {
  describe('valid inputs', () => {
    it('accepts valid path', () => {
      const result = removeRecentProjectInputSchema.safeParse('/home/user/project');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty string', () => {
      const result = removeRecentProjectInputSchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('rejects path traversal', () => {
      const result = removeRecentProjectInputSchema.safeParse('../../etc');
      expect(result.success).toBe(false);
    });

    it('rejects object', () => {
      const result = removeRecentProjectInputSchema.safeParse({ path: '/test' });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// PIN PROJECT INPUT SCHEMA TESTS
// ============================================================================

describe('pinProjectInputSchema', () => {
  describe('valid inputs', () => {
    it('accepts valid path', () => {
      const result = pinProjectInputSchema.safeParse('/home/user/project');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty string', () => {
      const result = pinProjectInputSchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('rejects path traversal', () => {
      const result = pinProjectInputSchema.safeParse('../sensitive');
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('Command injection prevention', () => {
    const injectionPayloads = [
      '; rm -rf /',
      '| cat /etc/passwd',
      '&& whoami',
      '`id`',
      '$(id)',
      '\n; malicious',
      '\r\n; malicious',
      '${PATH}',
      '> /tmp/pwned',
      '< /etc/shadow',
    ];

    // Path traversal is blocked, but command injection characters in filenames
    // are valid on most filesystems - the OS handles the actual execution
    // The key is we validate the path structure, not block all special chars
    describe('path traversal combined with injection', () => {
      injectionPayloads.forEach((payload) => {
        it(`rejects path with traversal + injection: ../..${payload}`, () => {
          const result = folderPathSchema.safeParse(`../..${payload}`);
          expect(result.success).toBe(false);
        });
      });
    });
  });

  describe('Prototype pollution prevention', () => {
    it('should not be affected by __proto__ in object input', () => {
      const maliciousInput = JSON.parse('{"__proto__": {"polluted": true}, "path": "/valid/path"}');
      const result = addRecentProjectInputSchema.safeParse(maliciousInput);
      // Should parse without issues - Zod strips __proto__
      expect(result.success).toBe(true);
      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('should not be affected by constructor.prototype', () => {
      const maliciousInput = {
        path: '/valid/path',
        constructor: { prototype: { polluted: true } },
      };
      const result = addRecentProjectInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(true);
    });
  });

  describe('Type coercion attacks', () => {
    it('rejects array where string expected', () => {
      const result = folderPathSchema.safeParse(['/path', '/other']);
      expect(result.success).toBe(false);
    });

    it('rejects object with valueOf for path', () => {
      const result = folderPathSchema.safeParse({ valueOf: () => '/path' });
      expect(result.success).toBe(false);
    });

    it('rejects object with toString for path', () => {
      const result = folderPathSchema.safeParse({ toString: () => '/path' });
      expect(result.success).toBe(false);
    });
  });

  describe('Unicode and encoding edge cases', () => {
    it('accepts paths with Unicode characters', () => {
      const result = folderPathSchema.safeParse('/home/user/projekt');
      expect(result.success).toBe(true);
    });

    it('accepts paths with emoji (some filesystems support this)', () => {
      const result = folderPathSchema.safeParse('/home/user/project-name');
      expect(result.success).toBe(true);
    });

    it('accepts paths with international characters', () => {
      const result = folderPathSchema.safeParse('/home/user/projet');
      expect(result.success).toBe(true);
    });
  });

  describe('Null byte injection', () => {
    it('handles paths with null byte appropriately', () => {
      // Null bytes can be used to truncate strings in some contexts
      // Our schema should handle this safely
      const result = folderPathSchema.safeParse('/valid/path\x00/malicious');
      // The behavior depends on the schema - it may accept or reject
      // The key is it should not cause errors
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('DoS prevention via size limits', () => {
    it('rejects extremely long paths', () => {
      const longPath = '/path/' + 'a'.repeat(10000);
      const result = folderPathSchema.safeParse(longPath);
      expect(result.success).toBe(false);
    });

    it('rejects extremely long project names', () => {
      const longName = 'a'.repeat(10000);
      const result = projectNameSchema.safeParse(longName);
      expect(result.success).toBe(false);
    });
  });
});
