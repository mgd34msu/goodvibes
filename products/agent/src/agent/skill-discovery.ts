import { createSkillDiscovery, type TerminalSkillRecord } from '@goodvibes-jev/engine/terminal-shell/skill-discovery';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
export type { SkillOrigin } from '@goodvibes-jev/engine/terminal-shell/skill-discovery';
export type SkillRecord = TerminalSkillRecord & { body: string };
export const discoverSkills = createSkillDiscovery<SkillRecord>(
  GOODVIBES_AGENT_SURFACE_ROOT,
  (record, body) => ({ ...record, body: body.trim() }),
  false,
);
