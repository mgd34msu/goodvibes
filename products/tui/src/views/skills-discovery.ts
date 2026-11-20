import { createSkillDiscovery, type TerminalSkillRecord } from '@goodvibes/engine/terminal-shell/skill-discovery';
export type { SkillOrigin } from '@goodvibes/engine/terminal-shell/skill-discovery';
export type SkillRecord = TerminalSkillRecord;
export const discoverSkills = createSkillDiscovery<SkillRecord>('tui', (record) => record, true);
