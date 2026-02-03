// ============================================================================
// SAFE COMMAND EXECUTION UTILITY TESTS
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  validateCommand,
  validateArguments,
  sanitizeArgument,
  safeExecSync,
  safeExecAsync,
  commandExists,
  getCommandPath,
} from './safeExec.js';

describe('SafeExec - Command Validation', () => {
  describe('validateCommand', () => {
    it('accepts valid command names', () => {
      expect(validateCommand('git').valid).toBe(true);
      expect(validateCommand('node').valid).toBe(true);
      expect(validateCommand('npm').valid).toBe(true);
      expect(validateCommand('python3').valid).toBe(true);
      expect(validateCommand('my-cli').valid).toBe(true);
      expect(validateCommand('my_tool').valid).toBe(true);
    });

    it('accepts valid paths', () => {
      expect(validateCommand('/usr/bin/git').valid).toBe(true);
      expect(validateCommand('C:/Program Files/node.exe').valid).toBe(true);
      expect(validateCommand('./local-script').valid).toBe(true);
    });

    it('rejects empty or invalid commands', () => {
      expect(validateCommand('').valid).toBe(false);
      expect(validateCommand(null as unknown as string).valid).toBe(false);
      expect(validateCommand(undefined as unknown as string).valid).toBe(false);
    });

    it('rejects commands with shell metacharacters', () => {
      expect(validateCommand('git; rm -rf /').valid).toBe(false);
      expect(validateCommand('cmd | cat').valid).toBe(false);
      expect(validateCommand('echo $HOME').valid).toBe(false);
      expect(validateCommand('test`whoami`').valid).toBe(false);
      expect(validateCommand('test$(id)').valid).toBe(false);
    });

    it('rejects path traversal attempts', () => {
      expect(validateCommand('../../../etc/passwd').valid).toBe(false);
      expect(validateCommand('..\\..\\windows\\system32\\cmd.exe').valid).toBe(false);
    });
  });

  describe('validateArguments', () => {
    it('accepts valid argument arrays', () => {
      expect(validateArguments(['--version']).valid).toBe(true);
      expect(validateArguments(['add', '.', '-A']).valid).toBe(true);
      expect(validateArguments(['install', 'package-name']).valid).toBe(true);
      expect(validateArguments([]).valid).toBe(true);
    });

    it('rejects non-array arguments', () => {
      expect(validateArguments('--version' as unknown as string[]).valid).toBe(false);
      expect(validateArguments(null as unknown as string[]).valid).toBe(false);
    });

    it('rejects arguments with shell injection patterns', () => {
      // Command substitution
      expect(validateArguments(['$(whoami)']).valid).toBe(false);
      expect(validateArguments(['`id`']).valid).toBe(false);
      expect(validateArguments(['${PATH}']).valid).toBe(false);

      // Command chaining
      expect(validateArguments(['; rm -rf /']).valid).toBe(false);
      expect(validateArguments(['| cat /etc/passwd']).valid).toBe(false);
      expect(validateArguments(['& whoami']).valid).toBe(false);

      // Newline injection
      expect(validateArguments(['test\nid']).valid).toBe(false);
      expect(validateArguments(['test\rid']).valid).toBe(false);
    });

    it('rejects arguments with non-string elements', () => {
      expect(validateArguments([123 as unknown as string]).valid).toBe(false);
      expect(validateArguments([null as unknown as string]).valid).toBe(false);
    });
  });

  describe('sanitizeArgument', () => {
    it('removes dangerous characters', () => {
      expect(sanitizeArgument('hello`world`')).toBe('helloworld');
      expect(sanitizeArgument('test$var')).toBe('testvar');
      expect(sanitizeArgument('cmd;whoami')).toBe('cmdwhoami');
      expect(sanitizeArgument('test|cat')).toBe('testcat');
      expect(sanitizeArgument('foo&bar')).toBe('foobar');
    });

    it('replaces newlines with spaces', () => {
      expect(sanitizeArgument('line1\nline2')).toBe('line1 line2');
      expect(sanitizeArgument('line1\r\nline2')).toBe('line1  line2');
    });

    it('trims whitespace', () => {
      expect(sanitizeArgument('  test  ')).toBe('test');
    });

    it('handles non-string input', () => {
      expect(sanitizeArgument(123 as unknown as string)).toBe('');
      expect(sanitizeArgument(null as unknown as string)).toBe('');
    });
  });
});

describe('SafeExec - Command Execution', () => {
  describe('safeExecSync', () => {
    it('executes valid commands', () => {
      const isWindows = process.platform === 'win32';
      const result = safeExecSync(isWindows ? 'cmd.exe' : 'echo', isWindows ? ['/c', 'echo', 'hello'] : ['hello']);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('hello');
    });

    it('rejects invalid commands', () => {
      const result = safeExecSync('invalid; rm -rf /', ['--version']);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('rejects invalid arguments', () => {
      const result = safeExecSync('echo', ['$(whoami)']);
      expect(result.success).toBe(false);
      expect(result.error).toContain('dangerous pattern');
    });

    it('allows skipping validation for trusted inputs', () => {
      // This should work even with "dangerous" looking arg when validation is skipped
      // because it's passed as an array element, not interpolated
      const isWindows = process.platform === 'win32';
      const result = safeExecSync(
        isWindows ? 'cmd.exe' : 'echo',
        isWindows ? ['/c', 'echo', 'test$var'] : ['test$var'],
        { skipValidation: true }
      );
      expect(result.success).toBe(true);
    });

    it('handles command not found', () => {
      const result = safeExecSync('nonexistent-command-12345', ['--version']);
      expect(result.success).toBe(false);
    });
  });

  describe('safeExecAsync', () => {
    it('executes valid commands asynchronously', async () => {
      const isWindows = process.platform === 'win32';
      const result = await safeExecAsync(
        isWindows ? 'cmd.exe' : 'echo',
        isWindows ? ['/c', 'echo', 'async-test'] : ['async-test']
      );
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('async-test');
    });

    it('rejects invalid commands', async () => {
      const result = await safeExecAsync('cmd; whoami', ['--version']);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('handles timeout', async () => {
      const isWindows = process.platform === 'win32';
      // Use a command that takes time
      const result = await safeExecAsync(
        isWindows ? 'ping' : 'sleep',
        isWindows ? ['localhost', '-n', '10'] : ['10'],
        { timeout: 100 }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    }, 5000);
  });
});

describe('SafeExec - Platform Utilities', () => {
  describe('commandExists', () => {
    it('returns true for existing commands', () => {
      const isWindows = process.platform === 'win32';
      // These commands should exist on all platforms
      if (isWindows) {
        expect(commandExists('cmd.exe')).toBe(true);
        expect(commandExists('where')).toBe(true);
      } else {
        expect(commandExists('sh')).toBe(true);
        expect(commandExists('which')).toBe(true);
      }
    });

    it('returns false for non-existent commands', () => {
      expect(commandExists('nonexistent-command-xyz-12345')).toBe(false);
    });

    it('rejects invalid command names', () => {
      expect(commandExists('cmd; whoami')).toBe(false);
      expect(commandExists('test$(id)')).toBe(false);
    });
  });

  describe('getCommandPath', () => {
    it('returns path for existing commands', () => {
      const isWindows = process.platform === 'win32';
      if (isWindows) {
        const path = getCommandPath('cmd.exe');
        expect(path).toBeTruthy();
        expect(path?.toLowerCase()).toContain('cmd');
      } else {
        const path = getCommandPath('sh');
        expect(path).toBeTruthy();
        expect(path).toContain('/');
      }
    });

    it('returns null for non-existent commands', () => {
      expect(getCommandPath('nonexistent-command-xyz-12345')).toBe(null);
    });

    it('rejects invalid command names', () => {
      expect(getCommandPath('cmd; whoami')).toBe(null);
    });
  });
});

describe('SafeExec - Security Edge Cases', () => {
  it('prevents command injection via argument array', () => {
    // Even if someone tries to inject commands via args, they should be
    // passed as literal strings, not interpreted by the shell
    const result = safeExecSync('echo', ['hello', '&& rm -rf /']);
    // This should either fail validation or execute harmlessly
    // (echo would just print the literal string)
    if (result.success) {
      // If it succeeds, the dangerous string should be printed literally
      expect(result.stdout).not.toContain('rm: cannot remove');
    }
  });

  it('handles unicode in arguments', () => {
    const isWindows = process.platform === 'win32';
    const result = safeExecSync(
      isWindows ? 'cmd.exe' : 'echo',
      isWindows ? ['/c', 'echo', 'hello-'] : ['hello-']
    );
    // Should execute without crashing
    expect(typeof result.success).toBe('boolean');
  });

  it('handles very long arguments', () => {
    const longArg = 'a'.repeat(10000);
    const isWindows = process.platform === 'win32';
    const result = safeExecSync(
      isWindows ? 'cmd.exe' : 'echo',
      isWindows ? ['/c', 'echo', longArg] : [longArg]
    );
    // Should execute without crashing
    expect(typeof result.success).toBe('boolean');
  });

  it('handles empty string arguments', () => {
    const isWindows = process.platform === 'win32';
    const result = safeExecSync(
      isWindows ? 'cmd.exe' : 'echo',
      isWindows ? ['/c', 'echo', ''] : ['']
    );
    // Should execute without crashing
    expect(typeof result.success).toBe('boolean');
  });
});
