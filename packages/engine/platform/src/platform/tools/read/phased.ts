import { ReadTool } from './index.js';
import { asPhasedTool } from '../../runtime/tools/adapter.js';
import type { PhasedTool } from '../../runtime/tools/adapter.js';
import type { FileStateCache } from '../../state/file-cache.js';
import type { ProjectIndex } from '../../state/project-index.js';

/**
 * Creates a phased version of the read tool.
 *
 * The read tool is categorised as `read`, it only reads file contents and
 * produces no persistent side effects. Pre/post hooks are skipped because:
 *   - No write permissions need to be checked before reading.
 *   - Reads are fast and low-risk, making audit overhead disproportionate.
 *
 * The tool is not cancellable: each file is read in one synchronous call, and
 * files past the read size limit are refused before they are loaded.
 *
 * @param fileCache    - Shared FileStateCache instance for this session.
 * @param projectIndex - Shared ProjectIndex instance for this session.
 * @returns A PhasedTool wrapping a ReadTool constructed with the given deps.
 */
export function createPhasedReadTool(
  fileCache: FileStateCache,
  projectIndex: ProjectIndex,
): PhasedTool {
  const readTool = new ReadTool(projectIndex, fileCache);
  return asPhasedTool(readTool, {
    category: 'read',
    cancellable: false,
    skipPhases: ['prehook', 'posthook'],
  });
}
