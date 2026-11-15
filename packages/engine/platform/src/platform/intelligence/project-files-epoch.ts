let projectFilesEpoch = 0;

/** Called by the tools that write project files, so a cached import graph built earlier is not reused. */
export function noteProjectFilesChanged(): void {
  projectFilesEpoch += 1;
}

/** Changes whenever {@link noteProjectFilesChanged} is called. */
export function currentProjectFilesEpoch(): number {
  return projectFilesEpoch;
}
