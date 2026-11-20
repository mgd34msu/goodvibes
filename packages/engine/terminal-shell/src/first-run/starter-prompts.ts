/**
 * The three starting prompts an empty conversation offers for the working
 * folder. One table, chosen from facts read with one directory listing and at
 * most two small manifest reads, once per process and folder (cached), when
 * an empty conversation is first drawn. A prompt is offered only where it can
 * be done: "Add a --verbose flag" needs a command-line entry and tests.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface FolderFacts {
  /** The folder holds at least one entry other than dot-files. */
  readonly hasFiles: boolean;
  /** Code files, a code manifest or a source folder at the top level. */
  readonly hasCode: boolean;
  /** A manifest declares a command-line entry. */
  readonly hasCommandLine: boolean;
  /** A test command is found. */
  readonly hasTests: boolean;
}

const CODE_EXTENSIONS = /\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|cjs|php|py|rb|rs|scala|sh|swift|ts|tsx|zig|lua|ex|exs|dart|vue|svelte)$/i;
const CODE_MANIFESTS = ['package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', 'mix.exs', 'Package.swift', 'CMakeLists.txt', 'Makefile', 'deno.json'];
const SOURCE_FOLDERS = ['src', 'lib', 'app', 'cmd', 'pkg'];
const TEST_FOLDERS = ['test', 'tests', '__tests__', 'spec'];
/** npm's placeholder test script is not a test command. */
const NPM_PLACEHOLDER_TEST = /no test specified/;

function readSmall(path: string): string | null {
  try {
    if (statSync(path).size > 256 * 1024) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Facts about `folder` from one listing and at most two manifest reads. */
export function readFolderFacts(folder: string): FolderFacts {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    names = [];
  }
  const visible = names.filter((name) => !name.startsWith('.'));
  const has = (name: string): boolean => names.includes(name);
  let hasCommandLine = false;
  let hasTests = TEST_FOLDERS.some(has);
  let reads = 0;
  if (has('package.json') && reads < 2) {
    reads += 1;
    const text = readSmall(join(folder, 'package.json'));
    try {
      const manifest = text ? JSON.parse(text) as { bin?: unknown; scripts?: Record<string, unknown> } : {};
      if (typeof manifest.bin === 'string' ? manifest.bin.length > 0 : manifest.bin !== null && typeof manifest.bin === 'object' && Object.keys(manifest.bin).length > 0) hasCommandLine = true;
      const test = manifest.scripts?.['test'];
      if (typeof test === 'string' && test.trim() !== '' && !NPM_PLACEHOLDER_TEST.test(test)) hasTests = true;
    } catch { /* an unreadable manifest declares nothing */ }
  }
  if (has('pyproject.toml') && reads < 2) {
    reads += 1;
    const text = readSmall(join(folder, 'pyproject.toml')) ?? '';
    if (/^\s*\[project\.scripts\]/m.test(text) || /^\s*\[tool\.poetry\.scripts\]/m.test(text)) hasCommandLine = true;
    if (/^\s*\[tool\.pytest/m.test(text)) hasTests = true;
  }
  if (has('Cargo.toml') && reads < 2) {
    reads += 1;
    const text = readSmall(join(folder, 'Cargo.toml')) ?? '';
    if (/^\s*\[\[bin\]\]/m.test(text) || existsSync(join(folder, 'src', 'main.rs'))) hasCommandLine = true;
    hasTests = true; // cargo test
  }
  if (has('go.mod')) {
    if (has('main.go') || has('cmd')) hasCommandLine = true;
    hasTests = true; // go test
  }
  const hasCode = visible.some((name) => CODE_EXTENSIONS.test(name)) || CODE_MANIFESTS.some(has) || SOURCE_FOLDERS.some(has);
  return { hasFiles: visible.length > 0, hasCode, hasCommandLine, hasTests };
}

/** The starting-prompt table. */
export function starterPromptsFor(facts: FolderFacts): readonly [string, string, string] {
  return [
    facts.hasFiles ? 'What does this project do, and how do I run its tests?' : 'This folder is empty. What should we build here?',
    facts.hasCode ? 'Find something in this code worth fixing and show me.' : 'Summarise what is in this folder.',
    facts.hasCommandLine && facts.hasTests
      ? 'Add a --verbose flag and run the tests.'
      : facts.hasTests
        ? 'Make one small improvement and run the tests.'
        : 'Make one small improvement and show me the change.',
  ];
}

const cache = new Map<string, readonly [string, string, string]>();

/** The starting prompts for `folder`, read once per process. */
export function starterPrompts(folder: string): readonly [string, string, string] {
  let prompts = cache.get(folder);
  if (!prompts) {
    prompts = starterPromptsFor(readFolderFacts(folder));
    cache.set(folder, prompts);
  }
  return prompts;
}
