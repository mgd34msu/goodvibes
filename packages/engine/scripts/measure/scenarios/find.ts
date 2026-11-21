/**
 * Content searches (`find` mode content) and file listings (`find` mode files)
 * over a seeded project of 1,800 files in 150 directories, through the tool's
 * own execute (tools/find/executor.ts): the per-project file list a repeated
 * search reuses (tools/find/file-list.ts) and the ripgrep first pass
 * (tools/find/ripgrep.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFindTool } from '../../../platform/src/platform/tools/find/executor.ts';
import { FindRuntimeService } from '../../../platform/src/platform/tools/find/shared.ts';
import { assertOutcome, clockAhead, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';

const P = 'packages/engine/platform/src/platform';
const TOP_DIRS = 30;
const SUB_DIRS = 4;
const FILES_PER_DIR = 12;
/** Each needle is written into this many files. */
const NEEDLE_FILES = 6;
const FILE_COUNT = TOP_DIRS * (1 + SUB_DIRS) * FILES_PER_DIR;
const NEEDLES = FILE_COUNT / NEEDLE_FILES;

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

/** A nested ignore file the seeded project gets for the files-mode scenarios, which must report it. */
const NESTED_IGNORE = join('area-3', 'part-1', '.gitignore');

/** Writes the nested ignore file into a seeded project at `root`. */
function seedNestedIgnore(root: string): void {
  writeFileSync(join(root, NESTED_IGNORE), 'generated/\n');
}

/**
 * One files-mode listing of one file name; checks that it listed that name in
 * every seeded directory and reported the nested ignore file.
 */
async function listFiles(tool: ReturnType<typeof createFindTool>, name: string, path?: string): Promise<Record<string, number>> {
  const result = await tool.execute({ queries: [{ id: 'q', mode: 'files', patterns: [`**/${name}`], ...(path ? { path } : {}) }], output: { format: 'count_only' } });
  assertOutcome(result.success, `the listing failed: ${result.error ?? result.output ?? '(no text)'}`);
  const answer = (JSON.parse(String(result.output)) as { q?: { count?: number; error?: string; warnings?: string[] } }).q;
  const directories = TOP_DIRS * (1 + SUB_DIRS);
  assertOutcome(answer?.count === directories, `listing ${name} found ${answer?.count ?? answer?.error ?? 'nothing'} file(s), expected ${directories}`);
  assertOutcome(answer.warnings?.some((warning) => warning.includes(NESTED_IGNORE)) === true, `listing ${name} did not report the nested ignore file ${NESTED_IGNORE}`);
  return { listedFiles: answer.count ?? 0 };
}

const FILES_ENTRIES = [
  `${P}/tools/find/executor.ts:28 createFindTool (execute)`,
  `${P}/tools/find/files.ts scanFilesQuery`,
  `${P}/tools/find/shared.ts heldSearchFiles`,
  `${P}/tools/find/file-list.ts projectFileList`,
];

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
      const restoreClock = clockAhead();
      const tool = createFindTool(env.workspace, null, service(ripgrep));
      return { op: (run) => search(tool, `needle${run + 1}x`, NEEDLE_FILES), dispose: restoreClock };
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
      const restoreClock = clockAhead();
      const tool = createFindTool(env.workspace, null, service('none'));
      return { op: (run) => search(tool, 'needle7x', NEEDLE_FILES, `project-${run + 1}`), dispose: restoreClock };
    },
  },
  repeatScenario('find-content-repeat', 'none', `Repeated content searches of one project (${FILE_COUNT} files in ${TOP_DIRS * (1 + SUB_DIRS)} directories), a different identifier each run, nothing changed in between; no ripgrep. The held file list is checked by one stat per directory and nothing is walked; every file is read.`),
  repeatScenario('find-content-repeat-ripgrep', 'host', `As find-content-repeat, with the host's ripgrep as the first pass: rg is handed the held file list and only the ${NEEDLE_FILES} files it names are read.`),
  {
    name: 'find-files-first',
    drives: `The first files-mode listing of a project: a fresh copy of the seeded project (${FILE_COUNT} files in ${TOP_DIRS * (1 + SUB_DIRS)} directories, one nested .gitignore) per run, listed for one file name under the default ignore rules. Walks the project once, noting the nested ignore file as it lists; opens no file.`,
    entries: FILES_ENTRIES,
    async setup(env: MeasureEnv): Promise<Instance> {
      for (let copy = 0; copy <= 5; copy++) {
        seedProject(join(env.workspace, `project-${copy}`));
        seedNestedIgnore(join(env.workspace, `project-${copy}`));
      }
      const restoreClock = clockAhead();
      const tool = createFindTool(env.workspace, null, service('none'));
      return { op: (run) => listFiles(tool, 'file-7.ts', `project-${run + 1}`), dispose: restoreClock };
    },
  },
  {
    name: 'find-files-repeat',
    drives: `Repeated files-mode listings of one project (${FILE_COUNT} files in ${TOP_DIRS * (1 + SUB_DIRS)} directories, one nested .gitignore), a different file name each run, nothing changed in between. The held file list is checked by one stat per directory; nothing is walked and the nested ignore file is reported from the list.`,
    entries: FILES_ENTRIES,
    async setup(env: MeasureEnv): Promise<Instance> {
      seedProject(env.workspace);
      seedNestedIgnore(env.workspace);
      const restoreClock = clockAhead();
      const tool = createFindTool(env.workspace, null, service('none'));
      return { op: (run) => listFiles(tool, `file-${(run + 1) % FILES_PER_DIR}.ts`), dispose: restoreClock };
    },
  },
  {
    name: 'find-content-after-edit',
    drives: `A content search of the seeded project (${FILE_COUNT} files) right after one new file was written into one directory (unmeasured, before each run); no ripgrep. Only that directory is listed again, and the search finds the new file.`,
    entries: ENTRIES,
    async setup(env: MeasureEnv): Promise<Instance> {
      const directories = seedProject(env.workspace);
      const restoreClock = clockAhead();
      const tool = createFindTool(env.workspace, null, service('none'));
      const edited = directories[Math.floor(directories.length / 2)]!;
      return {
        dispose: restoreClock,
        prepare(run) { writeFileSync(join(edited, `added-${run + 1}.ts`), `export const added = 'fresh${run + 1}y';\n`); },
        op: (run) => search(tool, `fresh${run + 1}y`, 1),
      };
    },
  },
];
