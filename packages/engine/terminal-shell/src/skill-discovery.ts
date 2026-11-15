import { sep } from 'node:path';
import {
  listInstalledEcosystemEntries,
  type EcosystemCatalogPathOptions,
  type ShellPathService,
} from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import {
  compareSkillsByOrigin,
  listSkills,
  resolveSkillRoots,
  type LocatedSkill,
  type SkillOrigin,
} from '@goodvibes-jev/engine/platform/platform/skills';
export type { SkillOrigin } from '@goodvibes-jev/engine/platform/platform/skills';
export interface TerminalSkillRecord {
  name: string;
  description: string;
  path: string;
  origin: SkillOrigin;
  dependencies: string[];
  includes: string[];
  frontmatter: Record<string, string>;
  /**
   * Set when this skill's file lives under an installed ecosystem-marketplace
   * receipt's targetPath, the receipt's provenance summary (e.g. curated
   * source / signature info), so marketplace-installed skills read as such
   * instead of looking identical to hand-authored ones.
   */
  marketplaceProvenance?: string | undefined;
}

/** The frontmatter as text values: a list value reads back as its items joined with ", ". */
function frontmatterText(skill: LocatedSkill): Record<string, string> {
  const out: Record<string, string> = { name: skill.name, description: skill.description };
  for (const [key, value] of Object.entries(skill.metadata)) {
    out[key] = typeof value === 'string' ? value : value.join(', ');
  }
  return out;
}

function toTerminalRecord(skill: LocatedSkill): TerminalSkillRecord {
  const dependsOn = skill.metadata.depends_on;
  const dependencies = (typeof dependsOn === 'string' ? dependsOn.split(',') : [...(dependsOn ?? [])])
    .map((item) => item.trim())
    .filter(Boolean);
  const includes: string[] = [];
  const includeRegex = /^@([\w/-]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = includeRegex.exec(skill.body)) !== null) {
    if (match[1] !== undefined) includes.push(match[1]);
  }
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    origin: skill.origin,
    dependencies,
    includes,
    frontmatter: frontmatterText(skill),
  };
}

/**
 * Skill discovery for a terminal product. Directories, formats, names and precedence come
 * from platform/skills, the same reader the daemon's skills.* verbs use.
 */
export function createSkillDiscovery<Record extends TerminalSkillRecord>(
  surfaceRoot: string,
  makeRecord: (record: TerminalSkillRecord, body: string) => Record,
  includeMarketplace: boolean,
) {
  function applyMarketplaceProvenance(records: Record[], ecosystemPaths: EcosystemCatalogPathOptions): Record[] {
    let receipts: ReturnType<typeof listInstalledEcosystemEntries>;
    try {
      receipts = listInstalledEcosystemEntries('skill', ecosystemPaths);
    } catch {
      return records;
    }
    if (receipts.length === 0) return records;
    return records.map((record) => {
      const receipt = receipts.find(
        (candidate) => record.path === candidate.targetPath || record.path.startsWith(`${candidate.targetPath}${sep}`),
      );
      if (!receipt) return record;
      return { ...record, marketplaceProvenance: receipt.provenanceSummary };
    });
  }
  async function discoverSkills(
    shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>,
    ecosystemPaths?: EcosystemCatalogPathOptions | undefined,
  ): Promise<Record[]> {
    const skills = await listSkills(resolveSkillRoots(shellPaths, surfaceRoot));
    const records = skills.map((skill) => makeRecord(toTerminalRecord(skill), skill.body));
    return includeMarketplace && ecosystemPaths ? applyMarketplaceProvenance(records, ecosystemPaths) : records;
  }
  return discoverSkills;
}

export function compareLocalLibraryRecords(
  left: { readonly origin: string; readonly name: string },
  right: { readonly origin: string; readonly name: string },
): number {
  return compareSkillsByOrigin(left, right);
}
