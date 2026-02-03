// ============================================================================
// INPUT SANITIZER TESTS
// ============================================================================
//
// These tests verify that the input sanitization functions correctly block
// command injection payloads while allowing legitimate inputs.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  validateCommandName,
  validateCommandArgument,
  validateCommandArguments,
  validatePath,
  validateEnvVarName,
  validateEnvVarValue,
  validateEnvironment,
  validateHookCommand,
  escapeShellArg,
  isAllowedCommand,
  createCommandChecker,
} from './inputSanitizer.js';

// ============================================================================
// COMMAND NAME VALIDATION TESTS
// ============================================================================

describe('validateCommandName', () => {
  describe('should accept valid commands', () => {
    const validCommands = [
      'node',
      'npm',
      'git',
      'claude',
      'claude.cmd',
      'claude.exe',
      'npx',
      '/usr/bin/git',
      '/usr/local/bin/node',
      // Note: Paths with spaces are intentionally rejected to prevent injection via spaces
      // Use short paths or paths without spaces for commands
      'C:/Users/test/bin/command',
      'my-command',
      'my_command',
      'command.v2',
    ];

    validCommands.forEach((cmd) => {
      it(`accepts "${cmd}"`, () => {
        const result = validateCommandName(cmd);
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('should reject injection payloads', () => {
    const injectionPayloads = [
      // Command chaining
      'node; rm -rf /',
      'node && cat /etc/passwd',
      'node || cat /etc/passwd',
      'node | cat /etc/passwd',
      // Command substitution
      '$(cat /etc/passwd)',
      '`cat /etc/passwd`',
      'node$(whoami)',
      // Newline injection
      'node\nrm -rf /',
      'node\r\nrm -rf /',
      // Redirect operators
      'node > /etc/passwd',
      'node < /etc/passwd',
      // Shell metacharacters
      'node; whoami',
      'node & whoami',
      "node' OR '1'='1",
      'node" OR "1"="1',
      // Path traversal
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
    ];

    injectionPayloads.forEach((payload) => {
      it(`rejects "${payload.substring(0, 30)}..."`, () => {
        const result = validateCommandName(payload);
        expect(result.valid).toBe(false);
      });
    });
  });

  describe('should handle edge cases', () => {
    it('rejects empty string', () => {
      expect(validateCommandName('').valid).toBe(false);
    });

    it('rejects null-like values', () => {
      expect(validateCommandName(null as unknown as string).valid).toBe(false);
      expect(validateCommandName(undefined as unknown as string).valid).toBe(false);
    });

    it('rejects whitespace-only strings', () => {
      expect(validateCommandName('   ').valid).toBe(false);
    });
  });
});

// ============================================================================
// COMMAND ARGUMENT VALIDATION TESTS
// ============================================================================

describe('validateCommandArgument', () => {
  describe('should accept valid arguments', () => {
    const validArgs = [
      '--version',
      '-v',
      '--output=file.txt',
      '/path/to/file',
      // Note: Backslashes are rejected because they can be escape characters
      // Use forward slashes or relative paths
      'C:/Users/test/file.txt',
      'simple-arg',
      'arg_with_underscore',
      'arg.with.dots',
      '12345',
      'file name with spaces',
    ];

    validArgs.forEach((arg) => {
      it(`accepts "${arg}"`, () => {
        const result = validateCommandArgument(arg);
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('should reject injection payloads', () => {
    const injectionPayloads = [
      // Command substitution
      '$(cat /etc/passwd)',
      '`whoami`',
      '${PATH}',
      // Command chaining
      '; rm -rf /',
      '&& cat /etc/passwd',
      '|| whoami',
      '| grep password',
      // Newline injection
      'arg\nrm -rf /',
      'arg\r\nwhoami',
      // Quotes that could break out
      "arg' OR '1",
      'arg" OR "1',
      // Backticks
      'arg`whoami`',
    ];

    injectionPayloads.forEach((payload) => {
      it(`rejects "${payload.substring(0, 30)}..."`, () => {
        const result = validateCommandArgument(payload);
        expect(result.valid).toBe(false);
      });
    });
  });
});

describe('validateCommandArguments', () => {
  it('accepts valid argument arrays', () => {
    const result = validateCommandArguments(['--version', '-o', 'output.txt']);
    expect(result.valid).toBe(true);
  });

  it('rejects arrays with injection payloads', () => {
    const result = validateCommandArguments(['--version', '; rm -rf /']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('index 1');
  });

  it('rejects non-arrays', () => {
    expect(validateCommandArguments('not an array' as unknown as string[]).valid).toBe(false);
  });
});

// ============================================================================
// PATH VALIDATION TESTS
// ============================================================================

describe('validatePath', () => {
  describe('should accept valid paths', () => {
    const validPaths = [
      '/home/user/project',
      '/var/log/app.log',
      'C:\\Users\\test\\Documents',
      'C:/Users/test/Documents',
      './relative/path',
      'relative/path',
      '/path/with spaces/allowed',
    ];

    validPaths.forEach((p) => {
      it(`accepts "${p}"`, () => {
        const result = validatePath(p);
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('should reject dangerous paths', () => {
    const dangerousPaths = [
      // Path traversal
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      '/home/user/../../etc/passwd',
      // Null byte injection
      '/home/user/file\x00.txt',
    ];

    dangerousPaths.forEach((p) => {
      it(`rejects "${p.split('\x00').join('\\x00')}"`, () => {
        const result = validatePath(p);
        expect(result.valid).toBe(false);
      });
    });
  });

  it('can reject absolute paths when configured', () => {
    expect(validatePath('/absolute/path', false).valid).toBe(false);
    expect(validatePath('C:\\absolute\\path', false).valid).toBe(false);
  });
});

// ============================================================================
// ENVIRONMENT VARIABLE VALIDATION TESTS
// ============================================================================

describe('validateEnvVarName', () => {
  describe('should accept valid names', () => {
    const validNames = ['PATH', 'HOME', 'MY_VAR', 'NODE_ENV', '_PRIVATE', 'var123'];

    validNames.forEach((name) => {
      it(`accepts "${name}"`, () => {
        expect(validateEnvVarName(name).valid).toBe(true);
      });
    });
  });

  describe('should reject invalid names', () => {
    const invalidNames = [
      '123VAR',  // Can't start with number
      'VAR-NAME', // No hyphens
      'VAR NAME', // No spaces
      'VAR=VALUE', // No equals
      '',
    ];

    invalidNames.forEach((name) => {
      it(`rejects "${name}"`, () => {
        expect(validateEnvVarName(name).valid).toBe(false);
      });
    });
  });
});

describe('validateEnvVarValue', () => {
  describe('should accept safe values', () => {
    const safeValues = [
      '/usr/bin:/usr/local/bin',
      'production',
      'true',
      '12345',
      '/path/to/something',
    ];

    safeValues.forEach((value) => {
      it(`accepts "${value}"`, () => {
        expect(validateEnvVarValue(value).valid).toBe(true);
      });
    });
  });

  describe('should reject command substitution', () => {
    const dangerousValues = [
      '$(whoami)',
      '`whoami`',
      '${HOME}',
    ];

    dangerousValues.forEach((value) => {
      it(`rejects "${value}"`, () => {
        expect(validateEnvVarValue(value).valid).toBe(false);
      });
    });
  });
});

describe('validateEnvironment', () => {
  it('accepts valid environment objects', () => {
    const result = validateEnvironment({
      NODE_ENV: 'production',
      PATH: '/usr/bin',
      MY_VAR: 'value',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects environments with invalid names', () => {
    const result = validateEnvironment({
      'INVALID-NAME': 'value',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects environments with dangerous values', () => {
    const result = validateEnvironment({
      PATH: '$(whoami)',
    });
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// HOOK COMMAND VALIDATION TESTS
// ============================================================================

describe('validateHookCommand', () => {
  describe('should accept valid hook commands', () => {
    const validCommands = [
      'echo "Hello World"',
      'node script.js',
      'npm run test',
      'curl -X POST http://example.com',
      'git status',
      // Allow shell features since hooks are intentionally shell commands
      'echo $PATH',
      'cat file.txt | grep pattern',
    ];

    validCommands.forEach((cmd) => {
      it(`accepts "${cmd}"`, () => {
        expect(validateHookCommand(cmd).valid).toBe(true);
      });
    });
  });

  describe('should reject dangerous commands', () => {
    const dangerousCommands = [
      '', // Empty
      '   ', // Whitespace only
      'a'.repeat(5000), // Too long
      'echo\x00hello', // Null byte
      'echo \\x41\\x42', // Hex escapes
    ];

    dangerousCommands.forEach((cmd) => {
      it(`rejects dangerous command`, () => {
        expect(validateHookCommand(cmd).valid).toBe(false);
      });
    });
  });
});

// ============================================================================
// SHELL ESCAPE TESTS
// ============================================================================

describe('escapeShellArg', () => {
  it('escapes strings safely for shell use', () => {
    // The exact escaping depends on platform, but it should produce output
    const result = escapeShellArg('hello world');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan('hello world'.length);
  });

  it('handles special characters', () => {
    const input = "test'string\"with`special$chars";
    const result = escapeShellArg(input);
    expect(typeof result).toBe('string');
    // Should be wrapped in quotes of some kind
    expect(result.includes('"') || result.includes("'")).toBe(true);
  });
});

// ============================================================================
// COMMAND ALLOWLIST TESTS
// ============================================================================

describe('isAllowedCommand', () => {
  it('recognizes allowed commands in existence_check category', () => {
    expect(isAllowedCommand('where', 'existence_check')).toBe(true);
    expect(isAllowedCommand('which', 'existence_check')).toBe(true);
    expect(isAllowedCommand('rm', 'existence_check')).toBe(false);
  });

  it('recognizes allowed commands in git category', () => {
    expect(isAllowedCommand('git', 'git')).toBe(true);
    expect(isAllowedCommand('/usr/bin/git', 'git')).toBe(true);
  });

  it('recognizes allowed commands in shells category', () => {
    expect(isAllowedCommand('/bin/sh', 'shells')).toBe(true);
    expect(isAllowedCommand('/bin/bash', 'shells')).toBe(true);
    expect(isAllowedCommand('cmd.exe', 'shells')).toBe(true);
  });

  it('returns false for unknown categories', () => {
    expect(isAllowedCommand('anything', 'nonexistent' as keyof typeof import('./inputSanitizer.js').ALLOWED_COMMANDS)).toBe(false);
  });
});

describe('createCommandChecker', () => {
  it('creates a working command checker', () => {
    const checker = createCommandChecker(['node', 'npm', 'npx']);
    expect(checker('node')).toBe(true);
    expect(checker('npm')).toBe(true);
    expect(checker('npx')).toBe(true);
    expect(checker('rm')).toBe(false);
    expect(checker('git')).toBe(false);
  });

  it('handles paths correctly', () => {
    const checker = createCommandChecker(['node']);
    expect(checker('/usr/bin/node')).toBe(true);
    expect(checker('C:\\Program Files\\node\\node')).toBe(true);
  });

  it('is case-insensitive', () => {
    const checker = createCommandChecker(['Node', 'NPM']);
    expect(checker('node')).toBe(true);
    expect(checker('NODE')).toBe(true);
    expect(checker('npm')).toBe(true);
  });
});

// ============================================================================
// COMPREHENSIVE INJECTION PAYLOAD TESTS
// ============================================================================

describe('Comprehensive injection payload testing', () => {
  // Collection of real-world command injection payloads
  // Note: URL-encoded payloads are not included because Node.js spawn()
  // doesn't automatically decode them - they would be passed literally.
  // URL decoding should be handled at the input validation layer before
  // reaching command execution.
  const realWorldPayloads = [
    // Basic command chaining
    '; ls',
    '| ls',
    '|| ls',
    '&& ls',
    '& ls',
    // Command substitution
    '$(ls)',
    '`ls`',
    '${ls}',
    // Newlines
    '\nls',
    '\rls',
    '\r\nls',
    // Quotes
    "'; ls'",
    '"; ls"',
    // Backticks
    '`id`',
    // Complex payloads
    "test' && ls && '",
    'test" && ls && "',
    'test`ls`',
    'test$(ls)',
    // Mixed
    "test'; ls #",
    'test" ; ls #',
  ];

  describe('validateCommandName blocks all injection payloads', () => {
    realWorldPayloads.forEach((payload) => {
      it(`blocks "${payload.replace(/[\r\n]/g, '\\n').substring(0, 20)}..."`, () => {
        const result = validateCommandName(`safe${payload}`);
        expect(result.valid).toBe(false);
      });
    });
  });

  describe('validateCommandArgument blocks all injection payloads', () => {
    realWorldPayloads.forEach((payload) => {
      it(`blocks "${payload.replace(/[\r\n]/g, '\\n').substring(0, 20)}..."`, () => {
        const result = validateCommandArgument(payload);
        expect(result.valid).toBe(false);
      });
    });
  });
});
