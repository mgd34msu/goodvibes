import { promises as fsPromises } from 'node:fs';
import { join, sep } from 'node:path';
import {
  listInstalledEcosystemEntries,
  type EcosystemCatalogPathOptions,
  type ShellPathService,
} from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { parseMarkdownFrontmatter, stripMarkdownFrontmatter } from './markdown-frontmatter.js';
export type SkillOrigin = 'project-local' | 'global' | 'custom';
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
export function createSkillDiscovery<Record extends TerminalSkillRecord>(
  surfaceRoot: string,
  makeRecord: (record: TerminalSkillRecord, body: string) => Record,
  includeMarketplace: boolean,
) {
  function getSkillDirectories(
    cwd: string,
    homeDir: string,
  ): Array<{
    root: string;
    origin: SkillOrigin;
  }> {
    return [
      { root: join(cwd, '.goodvibes', 'skills'), origin: 'project-local' },
      { root: join(cwd, '.goodvibes', surfaceRoot, 'skills'), origin: 'project-local' },
      { root: join(homeDir, '.goodvibes', 'skills'), origin: 'global' },
      { root: join(homeDir, '.goodvibes', surfaceRoot, 'skills'), origin: 'global' },
    ];
  }
  async function readSkillFile(path: string, origin: SkillOrigin): Promise<Record | null> {
    let content = '';
    try {
      content = await fsPromises.readFile(path, 'utf-8');
    } catch {
      return null;
    }
    const frontmatter = parseMarkdownFrontmatter(content);
    const body = stripMarkdownFrontmatter(content, false);
    const name = frontmatter.name ?? path.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? 'skill';
    const description = frontmatter.description ?? frontmatter.summary ?? '';
    const dependencies = frontmatter.depends_on
      ? frontmatter.depends_on
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const includes: string[] = [];
    const includeRegex = /^@([\w/-]+)/gm;
    let match: RegExpExecArray | null;
    while ((match = includeRegex.exec(body)) !== null) {
      if (match[1] !== undefined) includes.push(match[1]);
    }
    return makeRecord(
      {
        name,
        description,
        path,
        origin,
        dependencies,
        includes,
        frontmatter,
      },
      body,
    );
  }
  async function scanSkillDirectory(root: string, origin: SkillOrigin): Promise<Record[]> {
    let entries: string[] = [];
    try {
      entries = await fsPromises.readdir(root);
    } catch {
      return [];
    }
    const records: Record[] = [];
    for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
      if (entry.endsWith('.md')) {
        const record = await readSkillFile(join(root, entry), origin);
        if (record) records.push(record);
        continue;
      }
      const markerPath = join(root, entry, 'SKILL.md');
      const record = await readSkillFile(markerPath, origin);
      if (record) records.push(record);
    }
    return records;
  }
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
    const cwd = shellPaths.workingDirectory;
    const homeDir = shellPaths.homeDirectory;
    const seen = new Set<string>();
    const records: Record[] = [];
    for (const { root, origin } of getSkillDirectories(cwd, homeDir)) {
      for (const record of await scanSkillDirectory(root, origin)) {
        if (seen.has(record.name.toLowerCase())) continue;
        seen.add(record.name.toLowerCase());
        records.push(record);
      }
    }
    const tagged = includeMarketplace && ecosystemPaths ? applyMarketplaceProvenance(records, ecosystemPaths) : records;
    return tagged.sort((a, b) => {
      const originRank = a.origin === b.origin ? 0 : a.origin === 'project-local' ? -1 : 1;
      return originRank || a.name.localeCompare(b.name);
    });
  }
  return discoverSkills;
}

export function compareLocalLibraryRecords(
  left: { readonly origin: string; readonly name: string },
  right: { readonly origin: string; readonly name: string },
): number {
  const originRank = left.origin === right.origin ? 0 : left.origin === 'project-local' ? -1 : 1;
  return originRank || left.name.localeCompare(right.name);
}
