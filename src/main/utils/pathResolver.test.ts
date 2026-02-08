/**
 * Test suite for pathResolver.ts
 * 
 * Tests filesystem-aware path resolution that handles ambiguous encoded project names
 * where hyphens could represent either path separators or literal hyphens in directory names.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveEncodedProjectPath } from './pathResolver';
import fs from 'fs';
import path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
  },
  existsSync: vi.fn(),
}));

// Mock project registry
vi.mock('../database/projectRegistry/projects.js', () => ({
  getAllRegisteredProjects: vi.fn(),
}));

import { getAllRegisteredProjects } from '../database/projectRegistry/projects.js';

/**
 * Helper to mock filesystem state.
 * @param existingPaths - Array of paths that should exist
 */
function mockFilesystem(existingPaths: string[]) {
  const existsSet = new Set(existingPaths);
  vi.mocked(fs.existsSync).mockImplementation((p) => existsSet.has(String(p)));
}

/**
 * Helper to mock registered projects.
 * @param projects - Array of project objects with path property
 */
function mockRegistry(projects: Array<{ path: string }>) {
  vi.mocked(getAllRegisteredProjects).mockReturnValue(projects);
}

describe('resolveEncodedProjectPath', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    vi.mocked(getAllRegisteredProjects).mockReturnValue([]);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  describe('Registry lookup strategy', () => {
    it('returns registered project path when encoded name matches', () => {
      mockRegistry([
        { path: '/home/buzzkill/Projects/goodvibes-plugin' },
        { path: '/home/buzzkill/Projects/another-project' },
      ]);

      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-goodvibes-plugin');
      expect(result).toBe('/home/buzzkill/Projects/goodvibes-plugin');
    });

    it('handles multiple registered projects', () => {
      mockRegistry([
        { path: '/home/user/first' },
        { path: '/home/user/second-project' },
        { path: '/home/user/third' },
      ]);

      const result = resolveEncodedProjectPath('-home-user-second-project');
      expect(result).toBe('/home/user/second-project');
    });

    it('falls through to backtracking when no registry match', () => {
      mockRegistry([
        { path: '/home/user/other-project' },
      ]);

      // Mock filesystem for backtracking
      mockFilesystem([
        '/', '/home', '/home/user', '/home/user/my-project',
      ]);

      const result = resolveEncodedProjectPath('-home-user-my-project');
      expect(result).toBe(path.normalize('/home/user/my-project'));
    });

    it('gracefully handles registry errors and falls through to backtracking', () => {
      vi.mocked(getAllRegisteredProjects).mockImplementation(() => {
        throw new Error('Database not initialized');
      });

      // Mock filesystem for backtracking
      mockFilesystem([
        '/', '/home', '/home/user', '/home/user/project',
      ]);

      const result = resolveEncodedProjectPath('-home-user-project');
      expect(result).toBe(path.normalize('/home/user/project'));
    });
  });

  describe('Backtracking resolver - basic paths', () => {
    it('resolves simple path with no hyphens in directory names', () => {
      mockFilesystem([
        '/', '/home', '/home/buzzkill', '/home/buzzkill/Projects', '/home/buzzkill/Projects/myproject',
      ]);

      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-myproject');
      expect(result).toBe(path.normalize('/home/buzzkill/Projects/myproject'));
    });

    it('resolves short paths', () => {
      mockFilesystem([
        '/', '/home', '/home/user',
      ]);

      const result = resolveEncodedProjectPath('-home-user');
      expect(result).toBe(path.normalize('/home/user'));
    });

    it('resolves deeply nested paths', () => {
      mockFilesystem([
        '/', '/home', '/home/user', '/home/user/Projects',
        '/home/user/Projects/web', '/home/user/Projects/web/frontend',
        '/home/user/Projects/web/frontend/app',
      ]);

      const result = resolveEncodedProjectPath('-home-user-Projects-web-frontend-app');
      expect(result).toBe(path.normalize('/home/user/Projects/web/frontend/app'));
    });
  });

  describe('Backtracking resolver - hyphenated directory names', () => {
    it('resolves path with single hyphenated directory', () => {
      // When goodvibes-plugin exists but goodvibes/plugin does not
      mockFilesystem([
        '/', '/home', '/home/buzzkill', '/home/buzzkill/Projects',
        '/home/buzzkill/Projects/goodvibes-plugin',
      ]);

      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-goodvibes-plugin');
      expect(result).toBe(path.normalize('/home/buzzkill/Projects/goodvibes-plugin'));
    });

    it('resolves goodvibes-sh when it exists', () => {
      mockFilesystem([
        '/', '/home', '/home/buzzkill', '/home/buzzkill/Projects',
        '/home/buzzkill/Projects/goodvibes-sh',
      ]);

      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-goodvibes-sh');
      expect(result).toBe(path.normalize('/home/buzzkill/Projects/goodvibes-sh'));
    });

    it('resolves goodvibes-landing when it exists', () => {
      mockFilesystem([
        '/', '/home', '/home/buzzkill', '/home/buzzkill/Projects',
        '/home/buzzkill/Projects/goodvibes-landing',
      ]);

      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-goodvibes-landing');
      expect(result).toBe(path.normalize('/home/buzzkill/Projects/goodvibes-landing'));
    });

    it('resolves path with multiple hyphens in single directory', () => {
      mockFilesystem([
        '/', '/home', '/home/user', '/home/user/my-awesome-project',
      ]);

      const result = resolveEncodedProjectPath('-home-user-my-awesome-project');
      expect(result).toBe(path.normalize('/home/user/my-awesome-project'));
    });
  });

  describe('Backtracking resolver - coexisting directories (THE critical case)', () => {
    beforeEach(() => {
      // Mock ALL coexisting directories
      mockFilesystem([
        '/', '/home', '/home/buzzkill', '/home/buzzkill/Projects',
        '/home/buzzkill/Projects/goodvibes',
        '/home/buzzkill/Projects/goodvibes-plugin',
        '/home/buzzkill/Projects/goodvibes-sh',
        '/home/buzzkill/Projects/goodvibes-landing',
      ]);
    });

    it('resolves to base directory when it exists', () => {
      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-goodvibes');
      expect(result).toBe(path.normalize('/home/buzzkill/Projects/goodvibes'));
    });

    it('resolves to goodvibes-plugin when all variants exist', () => {
      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-goodvibes-plugin');
      expect(result).toBe(path.normalize('/home/buzzkill/Projects/goodvibes-plugin'));
    });

    it('resolves to goodvibes-sh when all variants exist', () => {
      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-goodvibes-sh');
      expect(result).toBe(path.normalize('/home/buzzkill/Projects/goodvibes-sh'));
    });

    it('resolves to goodvibes-landing when all variants exist', () => {
      const result = resolveEncodedProjectPath('-home-buzzkill-Projects-goodvibes-landing');
      expect(result).toBe(path.normalize('/home/buzzkill/Projects/goodvibes-landing'));
    });
  });

  describe('Backtracking resolver - deeply nested hyphens', () => {
    it('resolves multiple hyphenated segments at different levels', () => {
      mockFilesystem([
        '/', '/home', '/home/user', '/home/user/my-cool-projects',
        '/home/user/my-cool-projects/my-awesome-app',
      ]);

      const result = resolveEncodedProjectPath('-home-user-my-cool-projects-my-awesome-app');
      expect(result).toBe(path.normalize('/home/user/my-cool-projects/my-awesome-app'));
    });

    it('resolves complex nested structure with multiple hyphenated levels', () => {
      mockFilesystem([
        '/', '/work', '/work/client-projects',
        '/work/client-projects/acme-corp',
        '/work/client-projects/acme-corp/web-dashboard',
      ]);

      const result = resolveEncodedProjectPath('-work-client-projects-acme-corp-web-dashboard');
      expect(result).toBe(path.normalize('/work/client-projects/acme-corp/web-dashboard'));
    });
  });

  describe('Edge cases', () => {
    it('returns null for empty string', () => {
      const result = resolveEncodedProjectPath('');
      expect(result).toBeNull();
    });

    it('returns null for null input', () => {
      const result = resolveEncodedProjectPath(null as any);
      expect(result).toBeNull();
    });

    it('returns null for undefined input', () => {
      const result = resolveEncodedProjectPath(undefined as any);
      expect(result).toBeNull();
    });

    it('returns naive fallback when path does not exist at all', () => {
      // Empty filesystem - nothing exists
      mockFilesystem([]);

      const result = resolveEncodedProjectPath('-nonexistent-path-to-project');
      // Should fall back to naive join
      expect(result).toBe(path.normalize('/nonexistent/path/to/project'));
    });

    it('handles very long encoded names', () => {
      const longPath = '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z';
      const segments = longPath.split('/').filter(Boolean);
      mockFilesystem(['/', ...segments.map((_, i) => '/' + segments.slice(0, i + 1).join('/'))]);

      const encodedName = '-' + segments.join('-');
      const result = resolveEncodedProjectPath(encodedName);
      expect(result).toBe(path.normalize(longPath));
    });

    it('handles consecutive hyphens', () => {
      // Consecutive hyphens would split into empty segments, filtered out
      mockFilesystem([
        '/', '/home', '/home/user', '/home/user/project',
      ]);

      const result = resolveEncodedProjectPath('-home--user---project');
      expect(result).toBe(path.normalize('/home/user/project'));
    });

    it('handles single segment path', () => {
      mockFilesystem([
        '/', '/tmp',
      ]);

      const result = resolveEncodedProjectPath('-tmp');
      expect(result).toBe(path.normalize('/tmp'));
    });

    it('handles root path', () => {
      mockFilesystem(['/']);

      const result = resolveEncodedProjectPath('-');
      expect(result).toBe(path.normalize('/'));
    });
  });

  describe('Windows paths', () => {
    it('resolves basic Windows path', () => {
      mockFilesystem([
        'C:', 'C:/Users', 'C:/Users/buzzkill', 'C:/Users/buzzkill/Documents',
        'C:/Users/buzzkill/Documents/my-project',
      ]);

      const result = resolveEncodedProjectPath('C--Users-buzzkill-Documents-my-project');
      expect(result).toBe(path.normalize('C:/Users/buzzkill/Documents/my-project'));
    });

    it('resolves Windows path with hyphenated directory', () => {
      mockFilesystem([
        'C:', 'C:/Users', 'C:/Users/buzzkill', 'C:/Users/buzzkill/Documents',
        'C:/Users/buzzkill/Documents/web-app',
      ]);

      const result = resolveEncodedProjectPath('C--Users-buzzkill-Documents-web-app');
      expect(result).toBe(path.normalize('C:/Users/buzzkill/Documents/web-app'));
    });

    it('handles Windows path with multiple hyphenated directories', () => {
      mockFilesystem([
        'D:', 'D:/work-stuff', 'D:/work-stuff/client-projects',
        'D:/work-stuff/client-projects/big-company',
      ]);

      const result = resolveEncodedProjectPath('D--work-stuff-client-projects-big-company');
      expect(result).toBe(path.normalize('D:/work-stuff/client-projects/big-company'));
    });

    it('returns null for invalid Windows format', () => {
      const result = resolveEncodedProjectPath('C-Users-Documents');
      expect(result).toBeNull();
    });

    it('returns null for unsupported encoded path format (no leading dash, no double dash)', () => {
      const result = resolveEncodedProjectPath('some-random-string');
      expect(result).toBeNull();

    });
    it('handles different drive letters', () => {
      mockFilesystem([
        'E:', 'E:/backup', 'E:/backup/projects',
      ]);

      const result = resolveEncodedProjectPath('E--backup-projects');
      expect(result).toBe(path.normalize('E:/backup/projects'));
    });
  });

  describe('Fallback behavior', () => {
    it('returns naive join when backtracking finds no valid path', () => {
      // Only partial path exists
      mockFilesystem([
        '/', '/home', '/home/user',
      ]);

      const result = resolveEncodedProjectPath('-home-user-nonexistent-project');
      // Falls back to naive path since backtracking fails
      expect(result).toBe(path.normalize('/home/user/nonexistent/project'));
    });

    it('uses naive join for completely non-existent paths', () => {
      mockFilesystem([]);

      const result = resolveEncodedProjectPath('-totally-fake-path');
      expect(result).toBe(path.normalize('/totally/fake/path'));
    });

    it('prefers filesystem-validated path over naive join', () => {
      mockFilesystem([
        '/', '/home', '/home/user', '/home/user/my-project',
      ]);

      const result = resolveEncodedProjectPath('-home-user-my-project');
      // Should NOT be /home/user/my/project (naive), should be validated path
      expect(result).toBe(path.normalize('/home/user/my-project'));
      expect(result).not.toBe(path.normalize('/home/user/my/project'));
    });
  });

  describe('Integration scenarios', () => {
    it('registry takes precedence over filesystem backtracking', () => {
      // Registry says one thing
      mockRegistry([
        { path: '/home/user/correct-path' },
      ]);

      // Filesystem has a different path that would also match
      mockFilesystem([
        '/', '/home', '/home/user', '/home/user/correct', '/home/user/correct/path',
      ]);

      const result = resolveEncodedProjectPath('-home-user-correct-path');
      // Should use registry result, not backtracking
      expect(result).toBe('/home/user/correct-path');
    });

    it('handles mixed hyphenated and non-hyphenated directories in real scenario', () => {
      mockFilesystem([
        '/', '/home', '/home/dev', '/home/dev/work',
        '/home/dev/work/client-a', '/home/dev/work/client-a/project-x',
        '/home/dev/work/client-a/project-x/frontend',
      ]);

      const result = resolveEncodedProjectPath('-home-dev-work-client-a-project-x-frontend');
      expect(result).toBe(path.normalize('/home/dev/work/client-a/project-x/frontend'));
    });

    it('correctly chooses longest match first (greedy approach)', () => {
      // When both 'a-b-c' and 'a-b/c' exist, should prefer 'a-b-c' (longest match)
      mockFilesystem([
        '/', '/parent', '/parent/a-b-c',
        '/parent/a-b', '/parent/a-b/c', // Also exists but less preferred
      ]);

      const result = resolveEncodedProjectPath('-parent-a-b-c');
      // Backtracking tries longest first, so should get a-b-c
      expect(result).toBe(path.normalize('/parent/a-b-c'));
    });
  });
});
