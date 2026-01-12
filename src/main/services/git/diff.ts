// ============================================================================
// GIT SERVICE - DIFF AND PATCH OPERATIONS
// ============================================================================

import type { GitStatus, GitFileDiff, GitDiffHunk, GitDiffLine } from '../../../shared/types/index.js';
import { runGitCommand, validateCommitHash } from './core.js';
import type { GitBlameLine } from './types.js';

/**
 * Parse git diff output into structured format
 */
function parseDiffOutput(output: string, targetFile?: string): GitFileDiff {
  const lines = output.split('\n');
  const hunks: GitDiffHunk[] = [];
  let currentHunk: GitDiffHunk | null = null;
  let isBinary = false;
  let filePath = targetFile || '';
  let oldPath: string | undefined;

  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    // Check for binary file
    if (line.startsWith('Binary files')) {
      isBinary = true;
      continue;
    }

    // Extract file paths from diff header
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      if (match) {
        if (match[1] !== match[2]) {
          oldPath = match[1];
        }
        filePath = match[2];
      }
      continue;
    }

    // Parse hunk header
    if (line.startsWith('@@')) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      // Parse line numbers from hunk header: @@ -start,count +start,count @@
      const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldLineNum = parseInt(hunkMatch[1], 10);
        newLineNum = parseInt(hunkMatch[2], 10);
      }

      currentHunk = {
        header: line,
        lines: [{
          type: 'header',
          content: line,
        }],
      };
      continue;
    }

    // Skip diff metadata lines
    if (line.startsWith('---') || line.startsWith('+++') ||
        line.startsWith('index ') || line.startsWith('new file') ||
        line.startsWith('deleted file') || line.startsWith('old mode') ||
        line.startsWith('new mode') || line.startsWith('similarity') ||
        line.startsWith('rename ') || line.startsWith('copy ')) {
      continue;
    }

    // Parse diff content lines
    if (currentHunk) {
      let type: GitDiffLine['type'] = 'context';
      let oldNum: number | undefined = oldLineNum;
      let newNum: number | undefined = newLineNum;

      if (line.startsWith('+')) {
        type = 'addition';
        oldNum = undefined;
        newLineNum++;
      } else if (line.startsWith('-')) {
        type = 'deletion';
        newNum = undefined;
        oldLineNum++;
      } else if (line.startsWith(' ') || line === '') {
        type = 'context';
        oldLineNum++;
        newLineNum++;
      } else {
        // Skip lines that don't match expected format
        continue;
      }

      currentHunk.lines.push({
        type,
        content: line.substring(1) || '', // Remove the +/-/space prefix
        oldLineNumber: oldNum,
        newLineNumber: newNum,
      });
    }
  }

  // Push the last hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return {
    file: filePath,
    hunks,
    isBinary,
    oldPath,
  };
}

/**
 * Get diff for a specific file (optionally staged, or for a specific commit)
 */
export async function gitFileDiff(
  cwd: string,
  file?: string,
  options?: { staged?: boolean; commit?: string }
): Promise<{ success: boolean; diff?: GitFileDiff; rawDiff?: string; error?: string }> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args: string[] = ['diff'];

  if (options?.commit) {
    const validation = validateCommitHash(options.commit);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    // Show diff for a specific commit
    args.push(`${options.commit}^..${options.commit}`);
  } else if (options?.staged) {
    args.push('--staged');
  }

  args.push('--unified=3'); // Standard context lines

  if (file) {
    args.push('--', file);
  }

  const result = await runGitCommand(cwd, args);

  if (!result.success) {
    return { success: false, error: result.error };
  }

  if (!result.output || result.output.trim() === '') {
    return {
      success: true,
      diff: {
        file: file || '',
        hunks: [],
        isBinary: false,
      },
      rawDiff: '',
    };
  }

  // Parse the diff output
  const diff = parseDiffOutput(result.output, file);

  return {
    success: true,
    diff,
    rawDiff: result.output,
  };
}

/**
 * Get raw diff output (for simpler display)
 */
export async function gitDiffRaw(
  cwd: string,
  options?: { staged?: boolean; file?: string; commit?: string }
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const args: string[] = ['diff'];

  if (options?.commit) {
    const validation = validateCommitHash(options.commit);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    args.push(`${options.commit}^..${options.commit}`);
  } else if (options?.staged) {
    args.push('--staged');
  }

  if (options?.file) {
    args.push('--', options.file);
  }

  return runGitCommand(cwd, args);
}

/**
 * Get unified diff for a file that can be used for hunk staging
 * Returns diff with line numbers for selective staging
 */
export async function gitDiffForStaging(
  cwd: string,
  file: string,
  staged?: boolean
): Promise<{ success: boolean; diff?: string; error?: string }> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!file) return { success: false, error: 'No file specified' };

  const args = ['diff', '--no-color'];
  if (staged) args.push('--staged');
  args.push('--', file);

  const result = await runGitCommand(cwd, args);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true, diff: result.output };
}

/**
 * Stage specific lines from a file using git apply
 * @param patch The unified diff patch to apply to the index
 */
export async function gitApplyPatch(
  cwd: string,
  patch: string,
  options?: { cached?: boolean; reverse?: boolean }
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!patch) return { success: false, error: 'No patch content specified' };

  const args = ['apply'];
  if (options?.cached) args.push('--cached');
  if (options?.reverse) args.push('--reverse');
  args.push('-');

  // Use spawn to pass the patch via stdin
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (error: Error) => {
      resolve({
        success: false,
        error: error.message,
        stderr: stderr.trim(),
      });
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ success: true, output: stdout.trim(), stderr: stderr.trim() });
      } else {
        resolve({
          success: false,
          error: stderr.trim() || `Process exited with code ${code}`,
          stderr: stderr.trim(),
        });
      }
    });

    // Write the patch to stdin and close
    proc.stdin.write(patch);
    proc.stdin.end();
  });
}

/**
 * Get blame information for a file
 */
export async function gitBlame(
  cwd: string,
  file: string,
  options?: { startLine?: number; endLine?: number }
): Promise<{ success: boolean; lines: GitBlameLine[]; error?: string }> {
  if (!cwd) return { success: false, lines: [], error: 'No working directory specified' };
  if (!file) return { success: false, lines: [], error: 'No file specified' };

  const args = ['blame', '--porcelain'];

  if (options?.startLine && options?.endLine) {
    args.push(`-L${options.startLine},${options.endLine}`);
  }

  args.push('--', file);

  const result = await runGitCommand(cwd, args);
  if (!result.success) {
    return { success: false, lines: [], error: result.error };
  }

  // Parse porcelain blame output
  const lines: GitBlameLine[] = [];
  const output = result.output || '';
  const outputLines = output.split('\n');

  let currentHash = '';
  let currentAuthor = '';
  let currentTime = '';
  let lineNumber = 0;

  for (const line of outputLines) {
    // First line of a blame entry is: hash origLine finalLine [numLines]
    const hashMatch = line.match(/^([a-f0-9]{40})\s+\d+\s+(\d+)/);
    if (hashMatch) {
      currentHash = hashMatch[1];
      lineNumber = parseInt(hashMatch[2], 10);
      continue;
    }

    if (line.startsWith('author ')) {
      currentAuthor = line.substring(7);
      continue;
    }

    if (line.startsWith('author-time ')) {
      const timestamp = parseInt(line.substring(12), 10);
      currentTime = new Date(timestamp * 1000).toISOString();
      continue;
    }

    // The actual code line starts with a tab
    if (line.startsWith('\t')) {
      lines.push({
        hash: currentHash.substring(0, 8),
        author: currentAuthor,
        authorTime: currentTime,
        lineNumber,
        content: line.substring(1),
      });
    }
  }

  return { success: true, lines };
}
