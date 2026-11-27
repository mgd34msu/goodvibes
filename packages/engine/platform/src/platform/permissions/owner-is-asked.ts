/**
 * owner-is-asked.ts, the owner's stored permission mode in force for a project, for the daemon's few readers that are not a
 * tool call through the permission manager (products/daemon service-graph: whether YOLO is in force for a folder).
 *
 * The mode is the one in force for the PROJECT (config/project-view.ts `projectSettingsInForce`: the owner's settings
 * with the project's own file over them), the same settings the permission manager decides that project's calls by:
 * `project` when the reader names one, else the project of the decision in scope (permissions/call-project.ts
 * `projectOfDecision`), else the daemon's own settings for a step of no project. Set by the daemon's composition.
 */
let readMode: ((project: string | undefined) => unknown) | undefined;

/** The daemon's reader of the `permissions.mode` value in force for a project. */
export function setOwnerModeInForce(reader: (project: string | undefined) => unknown): void { readMode = reader; }

/**
 * The stored `permissions.mode` value in force for `project` (default: the project in scope), where the composition set
 * a reader; undefined where none is set (a program reads its own settings, which hold its project's file).
 */
export function ownerModeInForce(project?: string | undefined): unknown {
  return readMode?.(project);
}
