import { createSkillDiscovery, type TerminalSkillRecord } from '@goodvibes-jev/engine/terminal-shell/skill-discovery';
export type { SkillOrigin } from '@goodvibes-jev/engine/terminal-shell/skill-discovery';
export type SkillRecord = TerminalSkillRecord;
export const discoverSkills = createSkillDiscovery<SkillRecord>('tui', (record) => record, true);
