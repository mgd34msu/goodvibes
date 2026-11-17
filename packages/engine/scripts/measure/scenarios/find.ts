/**
 * Content searches (`find` mode content) over a seeded project of 1,800 files
 * in 150 directories, through the tool's own execute (tools/find/executor.ts):
 * the per-project file list a repeated search reuses (tools/find/file-list.ts)
 * and the ripgrep first pass (tools/find/ripgrep.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFindTool } from '../../../platform/src/platform/tools/find/executor.ts';
import { FindRuntimeService } from '../../../platform/src/platform/tools/find/shared.ts';
import { assertOutcome, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';

const P = 'packages/engine/platform/src/platform';
const TOP_DIRS = 30;
const SUB_DIRS = 4;
const FILES_PER_DIR = 12;
/** Each needle is written into this many files. */
const NEEDLE_FILES = 6;
const FILE_COUNT = TOP_DIRS * (1 + SUB_DIRS) * FILES_PER_DIR;
const NEEDLES = FILE_COUNT / NEEDLE_FILES;
/**
 * The file list lists a directory again while its change time is this recent
 * (file-list.ts RACY_MS); the seeded project is left to age past it before the
 * first measured search, so a run's counts do not depend on how fast setup was.
 */
const SETTLE_AFTER_SEED_MS = 2_100;

function fileText(index: number): string {
  const lines = [`// module ${index}`, `export const value${index} = ${index};`];
  for (let i = 0; i < 40; i++) lines.push(`export function helper${index}_${i}(input: number): number { return input * ${i} + ${index}; }`);
  lines.push(`export const marker = 'needle${index % NEEDLES}x';`);
  return `${lines.join('\n')}\n`;
}

/** Writes the project under `root`; returns its directories. */
function seedProject(root: string): string[] {
  const directories: string[] = [];
  let index = 0;
  for (let top = 0; top < TOP_DIRS; top++) {
    const topDir = join(root, `area-${top}`);
    for (const directory of [topDir, ...Array.from({ length: SUB_DIRS }, (_, sub) => join(topDir, `part-${sub}`))]) {
      mkdirSync(directory, { recursive: true });
      directories.push(directory);
      for (let f = 0; f < FILES_PER_DIR; f++) writeFileSync(join(directory, `file-${f}.ts`), fileText(index++));
    }
  }
  return directories;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_SEED_MS));

type Ripgrep = 'none' | 'host';

function service(ripgrep: Ripgrep): FindRuntimeService {
  if (ripgrep === 'none') return new FindRuntimeService({ ripgrep: null });
  const rg = Bun.which('rg');
  assertOutcome(rg !== null, 'ripgrep (rg) is not installed on this host; this scenario measures the search with it');
  return new FindRuntimeService({ ripgrep: rg });
}

/** One content search; checks that it found the files holding `needle`. */
async function search(tool: ReturnType<typeof createFindTool>, needle: string, expectedFiles: number, path?: string): Promise<Record<string, number>> {
  const result = await tool.execute({ queries: [{ id: 'q', mode: 'content', pattern: needle, ...(path ? { path } : {}) }], output: { format: 'count_only' } });
  assertOutcome(result.success, `the search failed: ${result.error ?? result.output ?? '(no text)'}`);
  const answer = (JSON.parse(String(result.output)) as { q?: { count?: number; file_count?: number; error?: string } }).q;
  assertOutcome(answer?.file_count === expectedFiles, `searching for ${needle} found ${answer?.file_count ?? answer?.error ?? 'nothing'} file(s), expected ${expectedFiles}`);
  return { matchedFiles: answer.file_count ?? 0 };
}

const ENTRIES = [
  `${P}/tools/find/executor.ts:28 createFindTool (execute)`,
  `${P}/tools/find/content.ts scanContentQuery`,
  `${P}/tools/find/shared.ts collectFilesForSearch`,
  `${P}/tools/find/file-list.ts projectFileList`,
];

/** The same project searched again with a different needle each run. */
function repeatScenario(name: string, ripgrep: Ripgrep, drives: string): Scenario {
  return {
    name, drives, entries: [...ENTRIES, ...(ripgrep === 'host' ? [`${P}/tools/find/ripgrep.ts ripgrepCandidates`] : [])],
    async setup(env: MeasureEnv): Promise<Instance> {
      seedProject(env.workspace);
      await settle();
      const tool = createFindTool(env.workspace, null, service(ripgrep));
      return { op: (run) => search(tool, `needle${run + 1}x`, NEEDLE_FILES) };
    },
  };
}

export const scenarios: Scenario[] = [
  {
    name: 'find-content-first',
    drives: `The first content search of a project: a fresh copy of the seeded project (${FILE_COUNT} files in ${TOP_DIRS * (1 + SUB_DIRS)} directories) per run, searched for one identifier; no ripgrep. Walks the project and reads every file.`,
    entries: ENTRIES,
    async setup(env: MeasureEnv): Promise<Instance> {
      // One copy per run (the warm-up included), so each search is the first of its project.
      for (let copy = 0; copy <= 5; copy++) seedProject(join(env.workspace, `project-${copy}`));
      await settle();
      const tool = createFindTool(env.workspace, null, service('none'));
      return { op: (run) => search(tool, 'needle7x', NEEDLE_FILES, `project-${run + 1}`) };
    },
  },
  repeatScenario('find-content-repeat', 'none', `Repeated content searches of one project (${FILE_COUNT} files in ${TOP_DIRS * (1 + SUB_DIRS)} directories), a different identifier each run, nothing changed in between; no ripgrep. The held file list is checked by one stat per directory and nothing is walked; every file is read.`),
  repeatScenario('find-content-repeat-ripgrep', 'host', `As find-content-repeat, with the host's ripgrep as the first pass: rg is handed the held file list and only the ${NEEDLE_FILES} files it names are read.`),
  {
    name: 'find-content-after-edit',
    drives: `A content search of the seeded project (${FILE_COUNT} files) right after one new file was written into one directory (unmeasured, before each run); no ripgrep. Only that directory is listed again, and the search finds the new file.`,
    entries: ENTRIES,
    async setup(env: MeasureEnv): Promise<Instance> {
      const directories = seedProject(env.workspace);
      await settle();
      const tool = createFindTool(env.workspace, null, service('none'));
      const edited = directories[Math.floor(directories.length / 2)]!;
      return {
        prepare(run) { writeFileSync(join(edited, `added-${run + 1}.ts`), `export const added = 'fresh${run + 1}y';\n`); },
        op: (run) => search(tool, `fresh${run + 1}y`, 1),
      };
    },
  },
];
