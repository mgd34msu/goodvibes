import type { Tool } from '../types/tools.js';

let projectFilesEpoch = 0;

/**
 * Called whenever project files may have changed, so a cached import graph
 * built earlier is not reused. The write and edit tools call it after a write;
 * {@link withProjectFilesEpoch} covers a tool whose changes are not known file
 * by file (a shell command, a file move). Anything else that changes project
 * files outside those tools calls it when it is done.
 */
export function noteProjectFilesChanged(): void {
  projectFilesEpoch += 1;
}

/** Changes whenever {@link noteProjectFilesChanged} is called. */
export function currentProjectFilesEpoch(): number {
  return projectFilesEpoch;
}

/**
 * The same tool, noting a project-files change when each call ends, whatever
 * its outcome: a command can change files and still fail, or be cancelled
 * part way. Costs one integer increment per call; the import graph is rebuilt
 * only when a relationship query next asks for it.
 */
export function withProjectFilesEpoch(tool: Tool): Tool {
  const execute = tool.execute.bind(tool);
  tool.execute = async (args, opts) => {
    try {
      return await execute(args, opts);
    } finally {
      noteProjectFilesChanged();
    }
  };
  return tool;
}
