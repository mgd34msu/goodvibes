/**
 * Whether a tool call of a turn needs somewhere to work. A chat with no project (a web chat or a channel conversation
 * made with none) does NOTHING in the daemon's own folder, reads included: the first call that needs a place gets the
 * chat its project first (workspace/automatic-projects.ts, on the owner's own message), or is refused; a call that needs
 * no place runs with no folder at all.
 *
 * Decided from what each tool touches. A place is needed by every tool that opens a path or names a folder (read,
 * find, inspect, repo_map, analyze, write, edit, exec, repl, the notebook tools), starts or reaches something that runs
 * in a folder or acts for a project (mcp: a tool server started in a folder; remote: runner contracts and artifacts kept
 * per project; channel: a send recorded with its project; agent, task, workflow, work_plan, trigger: work that runs
 * there later; state, control, goodvibes_settings, goodvibes_context: the project's session values, hooks, settings and
 * facts; capability_run: every capability is run naming the turn's project), and by any tool not named below (unknown
 * leans to needing one). No place is needed only by what reads nothing of any folder and keeps nothing: a web search, a
 * plain web fetch answered in the conversation (it writes no file), loading a tool's schema, finding a capability in
 * the catalogue, and the turn's own context accounting.
 */

/** The tools that need no place: they read no folder and keep nothing in one. */
export const PLACELESS_TOOLS: ReadonlySet<string> = new Set(['web_search', 'fetch', 'tool_schema', 'capability_find', 'context_accounting']);

export function callNeedsProject(name: string, _args?: Readonly<Record<string, unknown>> | undefined): boolean {
  return !PLACELESS_TOOLS.has(name);
}
