import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { createSkillDiscovery, type TerminalSkillRecord } from '@goodvibes/engine/terminal-shell/skill-discovery';
export type { SkillOrigin } from '@goodvibes/engine/terminal-shell/skill-discovery';
export type SkillRecord = TerminalSkillRecord;
export const discoverSkills = createSkillDiscovery<SkillRecord>(GOODVIBES_TUI_SURFACE_ROOT, (record) => record, true);
