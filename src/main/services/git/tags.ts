// ============================================================================
// GIT SERVICE - TAG MANAGEMENT
// ============================================================================

import type { GitStatus, GitTag } from '../../../shared/types/index.js';
import { runGitCommand, validateCommitHash, validateRemoteName, logger } from './core.js';

/**
 * List all tags with their details
 */
export async function gitTags(cwd: string): Promise<{ success: boolean; tags: GitTag[]; error?: string }> {
  if (!cwd) return { success: false, tags: [], error: 'No working directory specified' };

  // Get all tags with their commit hashes
  const result = await runGitCommand(cwd, ['tag', '-l', '--format=%(refname:short)|%(objecttype)|%(objectname:short)']);

  if (!result.success) {
    // Empty output is ok - means no tags
    if (result.error?.includes('No names found')) {
      return { success: true, tags: [] };
    }
    return { success: false, tags: [], error: result.error };
  }

  const tags: GitTag[] = [];
  const lines = (result.output || '').split('\n').filter(Boolean);

  for (const line of lines) {
    const [name, objectType, hash] = line.split('|');
    if (!name) continue;

    const tag: GitTag = {
      name,
      hash: hash || '',
      isAnnotated: objectType === 'tag',
    };

    // For annotated tags, get additional details
    if (tag.isAnnotated) {
      const detailResult = await runGitCommand(cwd, ['tag', '-l', name, '-n1', '--format=%(taggername)|%(taggerdate:iso)|%(contents:subject)']);
      if (detailResult.success && detailResult.output) {
        const [tagger, date, message] = detailResult.output.split('|');
        tag.tagger = tagger?.trim();
        tag.date = date?.trim();
        tag.message = message?.trim();
      }
    }

    tags.push(tag);
  }

  return { success: true, tags };
}

/**
 * Validate tag name
 */
function validateTagName(name: string): { valid: boolean; error?: string } {
  if (!/^[\w./-]+$/.test(name)) {
    return { valid: false, error: 'Invalid tag name' };
  }
  return { valid: true };
}

/**
 * Create a new tag
 * @param annotated If true, creates an annotated tag with a message
 */
export async function gitCreateTag(
  cwd: string,
  name: string,
  options?: { message?: string; commit?: string }
): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!name) return { success: false, error: 'No tag name specified' };

  const tagValidation = validateTagName(name);
  if (!tagValidation.valid) {
    return { success: false, error: tagValidation.error };
  }

  const args = ['tag'];

  if (options?.message) {
    args.push('-a', name, '-m', options.message);
  } else {
    args.push(name);
  }

  if (options?.commit) {
    const commitValidation = validateCommitHash(options.commit);
    if (!commitValidation.valid) {
      return { success: false, error: commitValidation.error };
    }
    args.push(options.commit);
  }

  logger.info(`Creating tag: ${name}`);
  return runGitCommand(cwd, args);
}

/**
 * Delete a tag
 */
export async function gitDeleteTag(cwd: string, name: string): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!name) return { success: false, error: 'No tag name specified' };

  const validation = validateTagName(name);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  logger.info(`Deleting tag: ${name}`);
  return runGitCommand(cwd, ['tag', '-d', name]);
}

/**
 * Push a tag to remote
 */
export async function gitPushTag(cwd: string, name: string, remote: string = 'origin'): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!name) return { success: false, error: 'No tag name specified' };

  const tagValidation = validateTagName(name);
  if (!tagValidation.valid) {
    return { success: false, error: tagValidation.error };
  }

  const remoteValidation = validateRemoteName(remote);
  if (!remoteValidation.valid) {
    return { success: false, error: remoteValidation.error };
  }

  logger.info(`Pushing tag ${name} to ${remote}`);
  return runGitCommand(cwd, ['push', remote, name]);
}

/**
 * Push all tags to remote
 */
export async function gitPushAllTags(cwd: string, remote: string = 'origin'): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };

  const validation = validateRemoteName(remote);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  logger.info(`Pushing all tags to ${remote}`);
  return runGitCommand(cwd, ['push', remote, '--tags']);
}

/**
 * Delete a tag from remote
 */
export async function gitDeleteRemoteTag(cwd: string, name: string, remote: string = 'origin'): Promise<GitStatus> {
  if (!cwd) return { success: false, error: 'No working directory specified' };
  if (!name) return { success: false, error: 'No tag name specified' };

  const tagValidation = validateTagName(name);
  if (!tagValidation.valid) {
    return { success: false, error: tagValidation.error };
  }

  const remoteValidation = validateRemoteName(remote);
  if (!remoteValidation.valid) {
    return { success: false, error: remoteValidation.error };
  }

  logger.info(`Deleting remote tag ${name} from ${remote}`);
  return runGitCommand(cwd, ['push', remote, '--delete', `refs/tags/${name}`]);
}
