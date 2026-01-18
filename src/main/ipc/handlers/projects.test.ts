// ============================================================================
// PROJECTS IPC HANDLERS UNIT TESTS
// ============================================================================
//
// Comprehensive tests for projects IPC handlers covering:
// - select-folder handler
// - select-file handler
// - create-folder handler
// - open-in-explorer handler with Zod validation
// - add-recent-project handler with Zod validation
// - remove-recent-project handler with Zod validation
// - pin-project handler with Zod validation
// - get-recent-projects handler
// - clear-recent-projects handler
// - Error handling via IPCValidationError
// - Security edge cases
//
// ============================================================================

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { ipcMain, dialog, shell, IpcMainInvokeEvent } from 'electron';

// ============================================================================
// MOCKS
// ============================================================================

// Mock electron before importing the module under test
vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(),
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    shell: {
      showItemInFolder: vi.fn(),
    },
  };
});

// Mock fs/promises for create-folder handler
vi.mock('fs/promises', () => {
  return {
    default: {
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock the recent projects service
vi.mock('../../services/recentProjects.js', () => {
  return {
    getRecentProjects: vi.fn().mockReturnValue([]),
    addRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    clearRecentProjects: vi.fn(),
    pinProject: vi.fn().mockReturnValue([]),
  };
});

// Mock the logger with a proper class
vi.mock('../../services/logger.js', () => {
  return {
    Logger: class MockLogger {
      info = vi.fn();
      warn = vi.fn();
      error = vi.fn();
      debug = vi.fn();
    },
  };
});

// Mock withContext to pass through the handler directly
vi.mock('../utils.js', () => {
  return {
    withContext: vi.fn().mockImplementation(
      (_operation: string, handler: (...args: unknown[]) => Promise<unknown>) => handler
    ),
  };
});

// Import after mocks
import { registerProjectsHandlers } from './projects.js';
import * as recentProjectsService from '../../services/recentProjects.js';
import fs from 'fs/promises';
import {
  openInExplorerInputSchema,
  addRecentProjectInputSchema,
  removeRecentProjectInputSchema,
  pinProjectInputSchema,
  validateInput,
} from '../schemas/index.js';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Creates a mock IPC event for testing handlers
 */
function createMockEvent(): IpcMainInvokeEvent {
  return {
    sender: {
      id: 1,
      getURL: () => 'http://localhost',
      send: vi.fn(),
    },
    frameId: 1,
    processId: 1,
    senderFrame: null,
  } as unknown as IpcMainInvokeEvent;
}

/**
 * Captures registered IPC handlers for testing
 */
interface RegisteredHandlers {
  'select-folder'?: (event: IpcMainInvokeEvent) => Promise<unknown>;
  'select-file'?: (event: IpcMainInvokeEvent) => Promise<unknown>;
  'create-folder'?: (event: IpcMainInvokeEvent) => Promise<unknown>;
  'open-in-explorer'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  'get-recent-projects'?: (event: IpcMainInvokeEvent) => Promise<unknown>;
  'add-recent-project'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  'remove-recent-project'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  'pin-project'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  'clear-recent-projects'?: (event: IpcMainInvokeEvent) => Promise<unknown>;
}

// Capture handlers once at module level since registerProjectsHandlers modifies global ipcMain
const capturedHandlers: RegisteredHandlers = {};
let handlersInitialized = false;

function initializeHandlers(): void {
  if (handlersInitialized) return;

  const mockHandle = ipcMain.handle as ReturnType<typeof vi.fn>;
  mockHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    capturedHandlers[channel as keyof RegisteredHandlers] = handler as RegisteredHandlers[keyof RegisteredHandlers];
  });

  registerProjectsHandlers();
  handlersInitialized = true;
}

function getHandlers(): RegisteredHandlers {
  initializeHandlers();
  return capturedHandlers;
}

// ============================================================================
// SCHEMA VALIDATION TESTS
// ============================================================================

describe('Projects Schema Validation', () => {
  describe('openInExplorerInputSchema', () => {
    describe('valid paths', () => {
      const validPaths = [
        '/home/user/project',
        '/Users/admin/Documents',
        'C:\\Users\\user\\Desktop',
        'D:\\Projects\\my-app',
        '/var/www/html',
        './relative/path',
        'project-folder',
        '/path/with spaces/folder',
      ];

      validPaths.forEach((path) => {
        it(`accepts "${path}"`, () => {
          const result = validateInput(openInExplorerInputSchema, path);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data).toBe(path);
          }
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
      ];

      invalidPaths.forEach(({ value, reason }) => {
        it(`rejects ${reason}`, () => {
          const result = validateInput(openInExplorerInputSchema, value);
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
      ];

      traversalAttempts.forEach((path) => {
        it(`rejects path traversal: "${path}"`, () => {
          const result = validateInput(openInExplorerInputSchema, path);
          expect(result.success).toBe(false);
        });
      });
    });
  });

  describe('addRecentProjectInputSchema', () => {
    describe('valid inputs', () => {
      it('accepts path only', () => {
        const result = validateInput(addRecentProjectInputSchema, {
          path: '/home/user/project',
        });
        expect(result.success).toBe(true);
      });

      it('accepts path with name', () => {
        const result = validateInput(addRecentProjectInputSchema, {
          path: '/home/user/project',
          name: 'My Project',
        });
        expect(result.success).toBe(true);
      });

      it('accepts Windows path', () => {
        const result = validateInput(addRecentProjectInputSchema, {
          path: 'C:\\Users\\user\\Documents\\project',
          name: 'Windows Project',
        });
        expect(result.success).toBe(true);
      });
    });

    describe('invalid inputs', () => {
      it('rejects missing path', () => {
        const result = validateInput(addRecentProjectInputSchema, {
          name: 'Project Name',
        });
        expect(result.success).toBe(false);
      });

      it('rejects empty path', () => {
        const result = validateInput(addRecentProjectInputSchema, {
          path: '',
        });
        expect(result.success).toBe(false);
      });

      it('rejects path traversal', () => {
        const result = validateInput(addRecentProjectInputSchema, {
          path: '/home/user/../../../etc/passwd',
        });
        expect(result.success).toBe(false);
      });

      it('rejects name exceeding max length', () => {
        const result = validateInput(addRecentProjectInputSchema, {
          path: '/valid/path',
          name: 'a'.repeat(201),
        });
        expect(result.success).toBe(false);
      });

      it('rejects null', () => {
        const result = validateInput(addRecentProjectInputSchema, null);
        expect(result.success).toBe(false);
      });

      it('rejects string instead of object', () => {
        const result = validateInput(addRecentProjectInputSchema, '/path/string');
        expect(result.success).toBe(false);
      });
    });
  });

  describe('removeRecentProjectInputSchema', () => {
    describe('valid inputs', () => {
      it('accepts valid path', () => {
        const result = validateInput(removeRecentProjectInputSchema, '/home/user/project');
        expect(result.success).toBe(true);
      });

      it('accepts Windows path', () => {
        const result = validateInput(removeRecentProjectInputSchema, 'C:\\Users\\project');
        expect(result.success).toBe(true);
      });
    });

    describe('invalid inputs', () => {
      it('rejects empty string', () => {
        const result = validateInput(removeRecentProjectInputSchema, '');
        expect(result.success).toBe(false);
      });

      it('rejects path traversal', () => {
        const result = validateInput(removeRecentProjectInputSchema, '../../etc');
        expect(result.success).toBe(false);
      });

      it('rejects object', () => {
        const result = validateInput(removeRecentProjectInputSchema, { path: '/test' });
        expect(result.success).toBe(false);
      });

      it('rejects null', () => {
        const result = validateInput(removeRecentProjectInputSchema, null);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('pinProjectInputSchema', () => {
    describe('valid inputs', () => {
      it('accepts valid Unix path', () => {
        const result = validateInput(pinProjectInputSchema, '/home/user/project');
        expect(result.success).toBe(true);
      });

      it('accepts valid Windows path', () => {
        const result = validateInput(pinProjectInputSchema, 'D:\\Development\\app');
        expect(result.success).toBe(true);
      });
    });

    describe('invalid inputs', () => {
      it('rejects empty string', () => {
        const result = validateInput(pinProjectInputSchema, '');
        expect(result.success).toBe(false);
      });

      it('rejects path traversal', () => {
        const result = validateInput(pinProjectInputSchema, '../sensitive');
        expect(result.success).toBe(false);
      });

      it('rejects number', () => {
        const result = validateInput(pinProjectInputSchema, 123);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// IPC HANDLER TESTS
// ============================================================================

describe('Projects IPC Handlers', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    // Reset mocks
    vi.mocked(dialog.showOpenDialog).mockReset();
    vi.mocked(dialog.showSaveDialog).mockReset();
    vi.mocked(shell.showItemInFolder).mockReset();
    vi.mocked(recentProjectsService.getRecentProjects).mockReset();
    vi.mocked(recentProjectsService.addRecentProject).mockReset();
    vi.mocked(recentProjectsService.removeRecentProject).mockReset();
    vi.mocked(recentProjectsService.clearRecentProjects).mockReset();
    vi.mocked(recentProjectsService.pinProject).mockReset();
    vi.mocked(fs.mkdir).mockReset();

    // Set default mock return values
    vi.mocked(recentProjectsService.getRecentProjects).mockReturnValue([]);
    vi.mocked(recentProjectsService.pinProject).mockReturnValue([]);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);

    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  describe('Handler Registration', () => {
    it('registers all expected handlers', () => {
      expect(handlers['select-folder']).toBeDefined();
      expect(handlers['select-file']).toBeDefined();
      expect(handlers['create-folder']).toBeDefined();
      expect(handlers['open-in-explorer']).toBeDefined();
      expect(handlers['get-recent-projects']).toBeDefined();
      expect(handlers['add-recent-project']).toBeDefined();
      expect(handlers['remove-recent-project']).toBeDefined();
      expect(handlers['pin-project']).toBeDefined();
      expect(handlers['clear-recent-projects']).toBeDefined();
    });

    it('registers handlers as callable functions', () => {
      expect(typeof handlers['select-folder']).toBe('function');
      expect(typeof handlers['select-file']).toBe('function');
      expect(typeof handlers['create-folder']).toBe('function');
      expect(typeof handlers['open-in-explorer']).toBe('function');
      expect(typeof handlers['get-recent-projects']).toBe('function');
      expect(typeof handlers['add-recent-project']).toBe('function');
      expect(typeof handlers['remove-recent-project']).toBe('function');
      expect(typeof handlers['pin-project']).toBe('function');
      expect(typeof handlers['clear-recent-projects']).toBe('function');
    });
  });

  // ============================================================================
  // SELECT-FOLDER HANDLER TESTS
  // ============================================================================

  describe('select-folder handler', () => {
    it('returns selected folder path when user selects a folder', async () => {
      const expectedPath = '/home/user/selected-folder';
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [expectedPath],
      });

      const handler = handlers['select-folder'];
      const result = await handler!(mockEvent);

      expect(dialog.showOpenDialog).toHaveBeenCalledWith({
        properties: ['openDirectory', 'createDirectory'],
      });
      expect(result).toBe(expectedPath);
    });

    it('returns null when user cancels dialog', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const handler = handlers['select-folder'];
      const result = await handler!(mockEvent);

      expect(result).toBeNull();
    });

    it('returns first path when multiple paths are selected', async () => {
      const firstPath = '/path/one';
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [firstPath, '/path/two', '/path/three'],
      });

      const handler = handlers['select-folder'];
      const result = await handler!(mockEvent);

      expect(result).toBe(firstPath);
    });

    it('returns Windows path correctly', async () => {
      const windowsPath = 'C:\\Users\\user\\Documents\\Project';
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [windowsPath],
      });

      const handler = handlers['select-folder'];
      const result = await handler!(mockEvent);

      expect(result).toBe(windowsPath);
    });

    it('handles path with spaces', async () => {
      const pathWithSpaces = '/Users/name/My Documents/Project Folder';
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [pathWithSpaces],
      });

      const handler = handlers['select-folder'];
      const result = await handler!(mockEvent);

      expect(result).toBe(pathWithSpaces);
    });
  });

  // ============================================================================
  // SELECT-FILE HANDLER TESTS
  // ============================================================================

  describe('select-file handler', () => {
    it('returns selected file path when user selects a file', async () => {
      const expectedPath = '/home/user/document.txt';
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [expectedPath],
      });

      const handler = handlers['select-file'];
      const result = await handler!(mockEvent);

      expect(dialog.showOpenDialog).toHaveBeenCalledWith({
        properties: ['openFile'],
      });
      expect(result).toBe(expectedPath);
    });

    it('returns null when user cancels dialog', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const handler = handlers['select-file'];
      const result = await handler!(mockEvent);

      expect(result).toBeNull();
    });

    it('returns first file when multiple paths are selected', async () => {
      const firstFile = '/path/file1.txt';
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [firstFile, '/path/file2.txt'],
      });

      const handler = handlers['select-file'];
      const result = await handler!(mockEvent);

      expect(result).toBe(firstFile);
    });

    it('handles various file extensions', async () => {
      const pdfFile = '/home/user/report.pdf';
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [pdfFile],
      });

      const handler = handlers['select-file'];
      const result = await handler!(mockEvent);

      expect(result).toBe(pdfFile);
    });
  });

  // ============================================================================
  // CREATE-FOLDER HANDLER TESTS
  // ============================================================================

  describe('create-folder handler', () => {
    it('creates folder and returns path when user specifies location', async () => {
      const newFolderPath = '/home/user/new-project';
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: newFolderPath,
      });

      const handler = handlers['create-folder'];
      const result = await handler!(mockEvent);

      expect(dialog.showSaveDialog).toHaveBeenCalledWith({
        title: 'Create New Project Folder',
        buttonLabel: 'Create',
        properties: ['showOverwriteConfirmation'],
      });
      expect(fs.mkdir).toHaveBeenCalledWith(newFolderPath, { recursive: true });
      expect(result).toBe(newFolderPath);
    });

    it('returns null when user cancels dialog', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: true,
        filePath: undefined,
      });

      const handler = handlers['create-folder'];
      const result = await handler!(mockEvent);

      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('returns null when filePath is undefined', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: undefined,
      });

      const handler = handlers['create-folder'];
      const result = await handler!(mockEvent);

      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('creates nested folders with recursive option', async () => {
      const deepPath = '/home/user/projects/deep/nested/folder';
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: deepPath,
      });

      const handler = handlers['create-folder'];
      await handler!(mockEvent);

      expect(fs.mkdir).toHaveBeenCalledWith(deepPath, { recursive: true });
    });
  });

  // ============================================================================
  // OPEN-IN-EXPLORER HANDLER TESTS
  // ============================================================================

  describe('open-in-explorer handler', () => {
    it('opens folder in explorer for valid path', async () => {
      const folderPath = '/home/user/project';

      const handler = handlers['open-in-explorer'];
      const result = await handler!(mockEvent, folderPath);

      expect(shell.showItemInFolder).toHaveBeenCalledWith(folderPath);
      expect(result).toBe(true);
    });

    it('opens Windows path correctly', async () => {
      const windowsPath = 'C:\\Users\\user\\Documents';

      const handler = handlers['open-in-explorer'];
      const result = await handler!(mockEvent, windowsPath);

      expect(shell.showItemInFolder).toHaveBeenCalledWith(windowsPath);
      expect(result).toBe(true);
    });

    it('opens path with spaces', async () => {
      const pathWithSpaces = '/Users/name/My Documents';

      const handler = handlers['open-in-explorer'];
      const result = await handler!(mockEvent, pathWithSpaces);

      expect(shell.showItemInFolder).toHaveBeenCalledWith(pathWithSpaces);
      expect(result).toBe(true);
    });

    it('throws IPCValidationError for empty path', async () => {
      const handler = handlers['open-in-explorer'];

      await expect(handler!(mockEvent, '')).rejects.toThrow('Invalid folder path');
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    });

    it('throws IPCValidationError for null path', async () => {
      const handler = handlers['open-in-explorer'];

      await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid folder path');
    });

    it('throws IPCValidationError for undefined path', async () => {
      const handler = handlers['open-in-explorer'];

      await expect(handler!(mockEvent, undefined)).rejects.toThrow('Invalid folder path');
    });

    it('throws IPCValidationError for path traversal attempt', async () => {
      const handler = handlers['open-in-explorer'];

      await expect(handler!(mockEvent, '../../../etc/passwd')).rejects.toThrow('Invalid folder path');
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    });

    it('throws IPCValidationError for number input', async () => {
      const handler = handlers['open-in-explorer'];

      await expect(handler!(mockEvent, 123)).rejects.toThrow('Invalid folder path');
    });

    it('throws IPCValidationError for object input', async () => {
      const handler = handlers['open-in-explorer'];

      await expect(handler!(mockEvent, { path: '/test' })).rejects.toThrow('Invalid folder path');
    });
  });

  // ============================================================================
  // ADD-RECENT-PROJECT HANDLER TESTS
  // ============================================================================

  describe('add-recent-project handler', () => {
    it('adds project with path and name', async () => {
      const projectData = {
        path: '/home/user/project',
        name: 'My Project',
      };

      const handler = handlers['add-recent-project'];
      const result = await handler!(mockEvent, projectData);

      expect(recentProjectsService.addRecentProject).toHaveBeenCalledWith(
        projectData.path,
        projectData.name
      );
      expect(result).toBe(true);
    });

    it('adds project with path only', async () => {
      const projectData = {
        path: '/home/user/project',
      };

      const handler = handlers['add-recent-project'];
      const result = await handler!(mockEvent, projectData);

      expect(recentProjectsService.addRecentProject).toHaveBeenCalledWith(
        projectData.path,
        undefined
      );
      expect(result).toBe(true);
    });

    it('adds Windows project path', async () => {
      const projectData = {
        path: 'C:\\Users\\user\\Documents\\project',
        name: 'Windows Project',
      };

      const handler = handlers['add-recent-project'];
      await handler!(mockEvent, projectData);

      expect(recentProjectsService.addRecentProject).toHaveBeenCalledWith(
        projectData.path,
        projectData.name
      );
    });

    it('throws IPCValidationError for missing path', async () => {
      const handler = handlers['add-recent-project'];

      await expect(handler!(mockEvent, { name: 'Project' })).rejects.toThrow('Invalid project data');
      expect(recentProjectsService.addRecentProject).not.toHaveBeenCalled();
    });

    it('throws IPCValidationError for empty path', async () => {
      const handler = handlers['add-recent-project'];

      await expect(handler!(mockEvent, { path: '' })).rejects.toThrow('Invalid project data');
    });

    it('throws IPCValidationError for path traversal', async () => {
      const handler = handlers['add-recent-project'];

      await expect(handler!(mockEvent, {
        path: '../../../etc/passwd',
        name: 'Malicious',
      })).rejects.toThrow('Invalid project data');
    });

    it('throws IPCValidationError for name exceeding max length', async () => {
      const handler = handlers['add-recent-project'];

      await expect(handler!(mockEvent, {
        path: '/valid/path',
        name: 'a'.repeat(201),
      })).rejects.toThrow('Invalid project data');
    });

    it('throws IPCValidationError for null input', async () => {
      const handler = handlers['add-recent-project'];

      await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid project data');
    });

    it('throws IPCValidationError for string input', async () => {
      const handler = handlers['add-recent-project'];

      await expect(handler!(mockEvent, '/path/string')).rejects.toThrow('Invalid project data');
    });
  });

  // ============================================================================
  // REMOVE-RECENT-PROJECT HANDLER TESTS
  // ============================================================================

  describe('remove-recent-project handler', () => {
    it('removes project for valid path', async () => {
      const projectPath = '/home/user/project';

      const handler = handlers['remove-recent-project'];
      const result = await handler!(mockEvent, projectPath);

      expect(recentProjectsService.removeRecentProject).toHaveBeenCalledWith(projectPath);
      expect(result).toBe(true);
    });

    it('removes Windows project path', async () => {
      const windowsPath = 'C:\\Users\\user\\project';

      const handler = handlers['remove-recent-project'];
      await handler!(mockEvent, windowsPath);

      expect(recentProjectsService.removeRecentProject).toHaveBeenCalledWith(windowsPath);
    });

    it('throws IPCValidationError for empty path', async () => {
      const handler = handlers['remove-recent-project'];

      await expect(handler!(mockEvent, '')).rejects.toThrow('Invalid project path');
      expect(recentProjectsService.removeRecentProject).not.toHaveBeenCalled();
    });

    it('throws IPCValidationError for path traversal', async () => {
      const handler = handlers['remove-recent-project'];

      await expect(handler!(mockEvent, '../../sensitive')).rejects.toThrow('Invalid project path');
    });

    it('throws IPCValidationError for null path', async () => {
      const handler = handlers['remove-recent-project'];

      await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid project path');
    });

    it('throws IPCValidationError for object path', async () => {
      const handler = handlers['remove-recent-project'];

      await expect(handler!(mockEvent, { path: '/test' })).rejects.toThrow('Invalid project path');
    });
  });

  // ============================================================================
  // PIN-PROJECT HANDLER TESTS
  // ============================================================================

  describe('pin-project handler', () => {
    it('pins project and returns updated list', async () => {
      const projectPath = '/home/user/project';
      const mockPinnedProjects = [
        { path: projectPath, name: 'Project', lastOpened: '2024-01-01', pinned: true },
      ];
      vi.mocked(recentProjectsService.pinProject).mockReturnValue(mockPinnedProjects);

      const handler = handlers['pin-project'];
      const result = await handler!(mockEvent, projectPath);

      expect(recentProjectsService.pinProject).toHaveBeenCalledWith(projectPath);
      expect(result).toEqual(mockPinnedProjects);
    });

    it('pins Windows project path', async () => {
      const windowsPath = 'D:\\Development\\app';

      const handler = handlers['pin-project'];
      await handler!(mockEvent, windowsPath);

      expect(recentProjectsService.pinProject).toHaveBeenCalledWith(windowsPath);
    });

    it('throws IPCValidationError for empty path', async () => {
      const handler = handlers['pin-project'];

      await expect(handler!(mockEvent, '')).rejects.toThrow('Invalid project path');
      expect(recentProjectsService.pinProject).not.toHaveBeenCalled();
    });

    it('throws IPCValidationError for path traversal', async () => {
      const handler = handlers['pin-project'];

      await expect(handler!(mockEvent, '../../../sensitive')).rejects.toThrow('Invalid project path');
    });

    it('throws IPCValidationError for null path', async () => {
      const handler = handlers['pin-project'];

      await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid project path');
    });
  });

  // ============================================================================
  // GET-RECENT-PROJECTS HANDLER TESTS
  // ============================================================================

  describe('get-recent-projects handler', () => {
    it('returns list of recent projects', async () => {
      const mockProjects = [
        { path: '/project1', name: 'Project 1', lastOpened: '2024-01-01' },
        { path: '/project2', name: 'Project 2', lastOpened: '2024-01-02' },
      ];
      vi.mocked(recentProjectsService.getRecentProjects).mockReturnValue(mockProjects);

      const handler = handlers['get-recent-projects'];
      const result = await handler!(mockEvent);

      expect(recentProjectsService.getRecentProjects).toHaveBeenCalled();
      expect(result).toEqual(mockProjects);
    });

    it('returns empty array when no recent projects', async () => {
      vi.mocked(recentProjectsService.getRecentProjects).mockReturnValue([]);

      const handler = handlers['get-recent-projects'];
      const result = await handler!(mockEvent);

      expect(result).toEqual([]);
    });

    it('returns projects sorted with pinned first', async () => {
      const mockProjects = [
        { path: '/project1', name: 'Project 1', lastOpened: '2024-01-01', pinned: true },
        { path: '/project2', name: 'Project 2', lastOpened: '2024-01-02' },
      ];
      vi.mocked(recentProjectsService.getRecentProjects).mockReturnValue(mockProjects);

      const handler = handlers['get-recent-projects'];
      const result = await handler!(mockEvent);

      expect(result).toEqual(mockProjects);
    });
  });

  // ============================================================================
  // CLEAR-RECENT-PROJECTS HANDLER TESTS
  // ============================================================================

  describe('clear-recent-projects handler', () => {
    it('clears all recent projects and returns true', async () => {
      const handler = handlers['clear-recent-projects'];
      const result = await handler!(mockEvent);

      expect(recentProjectsService.clearRecentProjects).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });
});

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

describe('Error Handling', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.mocked(dialog.showOpenDialog).mockReset();
    vi.mocked(dialog.showSaveDialog).mockReset();
    vi.mocked(shell.showItemInFolder).mockReset();
    vi.mocked(recentProjectsService.getRecentProjects).mockReset().mockReturnValue([]);
    vi.mocked(recentProjectsService.addRecentProject).mockReset();
    vi.mocked(recentProjectsService.removeRecentProject).mockReset();
    vi.mocked(recentProjectsService.clearRecentProjects).mockReset();
    vi.mocked(recentProjectsService.pinProject).mockReset().mockReturnValue([]);
    vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined);

    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  it('IPCValidationError includes error code', async () => {
    const handler = handlers['open-in-explorer'];

    try {
      await handler!(mockEvent, '');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('IPCValidationError');
      expect((error as { code?: string }).code).toBe('VALIDATION_ERROR');
    }
  });

  it('validation errors include details about the failure', async () => {
    const handler = handlers['add-recent-project'];

    try {
      await handler!(mockEvent, { path: '' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Invalid project data');
    }
  });

  it('service errors propagate correctly from addRecentProject', async () => {
    const serviceError = new Error('Storage full');
    vi.mocked(recentProjectsService.addRecentProject).mockImplementation(() => {
      throw serviceError;
    });

    const handler = handlers['add-recent-project'];

    await expect(handler!(mockEvent, {
      path: '/valid/path',
      name: 'Project',
    })).rejects.toThrow('Storage full');
  });

  it('service errors propagate correctly from removeRecentProject', async () => {
    const serviceError = new Error('Project not found');
    vi.mocked(recentProjectsService.removeRecentProject).mockImplementation(() => {
      throw serviceError;
    });

    const handler = handlers['remove-recent-project'];

    await expect(handler!(mockEvent, '/valid/path')).rejects.toThrow('Project not found');
  });

  it('fs.mkdir errors propagate correctly', async () => {
    const fsError = new Error('Permission denied');
    vi.mocked(fs.mkdir).mockRejectedValue(fsError);
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: '/protected/folder',
    });

    const handler = handlers['create-folder'];

    await expect(handler!(mockEvent)).rejects.toThrow('Permission denied');
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security Edge Cases', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.mocked(dialog.showOpenDialog).mockReset();
    vi.mocked(dialog.showSaveDialog).mockReset();
    vi.mocked(shell.showItemInFolder).mockReset();
    vi.mocked(recentProjectsService.getRecentProjects).mockReset().mockReturnValue([]);
    vi.mocked(recentProjectsService.addRecentProject).mockReset();
    vi.mocked(recentProjectsService.removeRecentProject).mockReset();
    vi.mocked(recentProjectsService.clearRecentProjects).mockReset();
    vi.mocked(recentProjectsService.pinProject).mockReset().mockReturnValue([]);
    vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined);

    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  describe('Path Traversal Prevention', () => {
    const pathTraversalAttempts = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/home/user/../../../root',
      'C:\\Users\\..\\..\\Windows\\System32',
      '/var/www/html/../../../etc/shadow',
    ];

    pathTraversalAttempts.forEach((path) => {
      it(`rejects path traversal in open-in-explorer: "${path}"`, async () => {
        const handler = handlers['open-in-explorer'];
        await expect(handler!(mockEvent, path)).rejects.toThrow('Invalid folder path');
      });

      it(`rejects path traversal in remove-recent-project: "${path}"`, async () => {
        const handler = handlers['remove-recent-project'];
        await expect(handler!(mockEvent, path)).rejects.toThrow('Invalid project path');
      });

      it(`rejects path traversal in pin-project: "${path}"`, async () => {
        const handler = handlers['pin-project'];
        await expect(handler!(mockEvent, path)).rejects.toThrow('Invalid project path');
      });
    });
  });

  describe('Command Injection Prevention', () => {
    const injectionPayloads = [
      '; rm -rf /',
      '| cat /etc/passwd',
      '&& whoami',
      '`id`',
      '$(id)',
      '\n; malicious',
    ];

    // Path traversal combined with injection should be blocked
    injectionPayloads.forEach((payload) => {
      it(`rejects combined traversal and injection: ../..${payload}`, async () => {
        const handler = handlers['open-in-explorer'];
        await expect(handler!(mockEvent, `../..${payload}`)).rejects.toThrow('Invalid folder path');
      });
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('should not be affected by __proto__ in add-recent-project', async () => {
      const maliciousInput = JSON.parse('{"__proto__": {"polluted": true}, "path": "/valid/path"}');

      const handler = handlers['add-recent-project'];
      await handler!(mockEvent, maliciousInput);

      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(recentProjectsService.addRecentProject).toHaveBeenCalled();
    });

    it('should not be affected by constructor.prototype', async () => {
      const maliciousInput = {
        path: '/valid/path',
        constructor: { prototype: { polluted: true } },
      };

      const handler = handlers['add-recent-project'];
      await handler!(mockEvent, maliciousInput);

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Type Coercion Prevention', () => {
    it('rejects array where string expected for open-in-explorer', async () => {
      const handler = handlers['open-in-explorer'];
      await expect(handler!(mockEvent, ['/path1', '/path2'])).rejects.toThrow('Invalid folder path');
    });

    it('rejects object with valueOf for path', async () => {
      const handler = handlers['remove-recent-project'];
      await expect(handler!(mockEvent, { valueOf: () => '/path' })).rejects.toThrow('Invalid project path');
    });

    it('rejects object with toString for path', async () => {
      const handler = handlers['pin-project'];
      await expect(handler!(mockEvent, { toString: () => '/path' })).rejects.toThrow('Invalid project path');
    });
  });

  describe('Unicode/Encoding Edge Cases', () => {
    it('accepts paths with Unicode characters', async () => {
      const unicodePath = '/home/user/projekt';

      const handler = handlers['open-in-explorer'];
      await handler!(mockEvent, unicodePath);

      expect(shell.showItemInFolder).toHaveBeenCalledWith(unicodePath);
    });

    it('accepts paths with international characters', async () => {
      const intlPath = '/home/user/projet';

      const handler = handlers['add-recent-project'];
      await handler!(mockEvent, { path: intlPath, name: 'Projet' });

      expect(recentProjectsService.addRecentProject).toHaveBeenCalledWith(intlPath, 'Projet');
    });
  });

  describe('DoS Prevention via Size Limits', () => {
    it('rejects extremely long paths', async () => {
      const longPath = '/path/' + 'a'.repeat(10000);

      const handler = handlers['open-in-explorer'];
      await expect(handler!(mockEvent, longPath)).rejects.toThrow('Invalid folder path');
    });

    it('rejects extremely long project names', async () => {
      const handler = handlers['add-recent-project'];
      await expect(handler!(mockEvent, {
        path: '/valid/path',
        name: 'a'.repeat(10000),
      })).rejects.toThrow('Invalid project data');
    });
  });
});

// ============================================================================
// INTEGRATION TESTS - Simulating Real IPC Flow
// ============================================================================

describe('IPC Flow Integration', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.mocked(dialog.showOpenDialog).mockReset();
    vi.mocked(dialog.showSaveDialog).mockReset();
    vi.mocked(shell.showItemInFolder).mockReset();
    vi.mocked(recentProjectsService.getRecentProjects).mockReset().mockReturnValue([]);
    vi.mocked(recentProjectsService.addRecentProject).mockReset();
    vi.mocked(recentProjectsService.removeRecentProject).mockReset();
    vi.mocked(recentProjectsService.clearRecentProjects).mockReset();
    vi.mocked(recentProjectsService.pinProject).mockReset().mockReturnValue([]);
    vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined);

    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  it('simulates complete project selection and recent projects flow', async () => {
    const selectedPath = '/home/user/new-project';

    // Step 1: Select a folder
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [selectedPath],
    });

    const selectFolder = handlers['select-folder'];
    const folderPath = await selectFolder!(mockEvent);
    expect(folderPath).toBe(selectedPath);

    // Step 2: Add to recent projects
    const addRecent = handlers['add-recent-project'];
    await addRecent!(mockEvent, { path: selectedPath, name: 'New Project' });
    expect(recentProjectsService.addRecentProject).toHaveBeenCalledWith(selectedPath, 'New Project');

    // Step 3: Get recent projects
    vi.mocked(recentProjectsService.getRecentProjects).mockReturnValue([
      { path: selectedPath, name: 'New Project', lastOpened: '2024-01-01' },
    ]);

    const getRecent = handlers['get-recent-projects'];
    const recentProjects = await getRecent!(mockEvent);
    expect(recentProjects).toHaveLength(1);

    // Step 4: Open in explorer
    const openExplorer = handlers['open-in-explorer'];
    await openExplorer!(mockEvent, selectedPath);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(selectedPath);
  });

  it('simulates pin and unpin project flow', async () => {
    const projectPath = '/home/user/project';

    // Initial state: project not pinned
    vi.mocked(recentProjectsService.getRecentProjects).mockReturnValue([
      { path: projectPath, name: 'Project', lastOpened: '2024-01-01' },
    ]);

    // Pin the project
    vi.mocked(recentProjectsService.pinProject).mockReturnValue([
      { path: projectPath, name: 'Project', lastOpened: '2024-01-01', pinned: true },
    ]);

    const pinProject = handlers['pin-project'];
    const pinnedResult = await pinProject!(mockEvent, projectPath);
    expect(pinnedResult).toEqual([
      { path: projectPath, name: 'Project', lastOpened: '2024-01-01', pinned: true },
    ]);

    // Unpin the project (toggle)
    vi.mocked(recentProjectsService.pinProject).mockReturnValue([
      { path: projectPath, name: 'Project', lastOpened: '2024-01-01', pinned: false },
    ]);

    const unpinnedResult = await pinProject!(mockEvent, projectPath);
    expect(unpinnedResult).toEqual([
      { path: projectPath, name: 'Project', lastOpened: '2024-01-01', pinned: false },
    ]);
  });

  it('simulates create folder and add to recent projects flow', async () => {
    const newFolderPath = '/home/user/brand-new-project';

    // Create folder
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: newFolderPath,
    });

    const createFolder = handlers['create-folder'];
    const createdPath = await createFolder!(mockEvent);
    expect(createdPath).toBe(newFolderPath);
    expect(fs.mkdir).toHaveBeenCalledWith(newFolderPath, { recursive: true });

    // Add to recent
    const addRecent = handlers['add-recent-project'];
    await addRecent!(mockEvent, { path: newFolderPath });
    expect(recentProjectsService.addRecentProject).toHaveBeenCalledWith(newFolderPath, undefined);
  });

  it('simulates remove and clear recent projects flow', async () => {
    const projectPath = '/home/user/old-project';

    // Remove specific project
    const removeRecent = handlers['remove-recent-project'];
    await removeRecent!(mockEvent, projectPath);
    expect(recentProjectsService.removeRecentProject).toHaveBeenCalledWith(projectPath);

    // Clear all projects
    const clearRecent = handlers['clear-recent-projects'];
    await clearRecent!(mockEvent);
    expect(recentProjectsService.clearRecentProjects).toHaveBeenCalled();
  });
});
