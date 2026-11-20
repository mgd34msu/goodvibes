import type { WorkspaceActionTarget } from '../workspace-actions.ts';

const to = (action: string): WorkspaceActionTarget => ({ command: 'my-skills', action });

/** The workspace's skill rows open the actions of `/my-skills` (commands/agent-skills-runtime.ts). */
export const MY_SKILLS_WORKSPACE_ACTIONS: Readonly<Record<string, WorkspaceActionTarget>> = {
  'skills-create': to('create'),
  'skills-edit': to('update'), 'skill-edit': to('update'),
  'skills-delete': to('delete'), 'skill-delete': to('delete'),
  'skills-enable': to('enable'), 'skill-enable': to('enable'),
  'skills-disable': to('disable'), 'skill-disable': to('disable'),
  'skills-review': to('review'), 'skill-review': to('review'),
  'skills-search': to('search'), 'skill-search': to('search'),
  'skills-show': to('show'), 'skill-show': to('show'),
  'skills-import-discovered': to('import-discovered'), 'skill-discovery-import': to('import-discovered'),
  'skills-import-standard': to('import-standard'), 'skill-standard-import': to('import-standard'),
  'skills-export-standard': to('export-standard'), 'skill-standard-export': to('export-standard'),
  'skills-create-bundle': to('bundle-create'),
  'skills-delete-bundle': to('bundle-delete'), 'skill-bundle-delete': to('bundle-delete'),
  'skills-enable-bundle': to('bundle-enable'), 'skill-bundle-enable': to('bundle-enable'),
  'skills-disable-bundle': to('bundle-disable'), 'skill-bundle-disable': to('bundle-disable'),
  'skills-review-bundle': to('bundle-review'), 'skill-bundle-review': to('bundle-review'),
  'skills-search-bundle': to('bundle-search'), 'skill-bundle-search': to('bundle-search'),
  'skills-show-bundle': to('bundle-show'), 'skill-bundle-show': to('bundle-show'),
  'skills-stale-bundle': to('bundle-stale'), 'skill-bundle-stale': to('bundle-stale'),
  'skills-update-bundle': to('bundle-update'), 'skill-bundle-update': to('bundle-update'),
};
