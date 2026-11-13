/**
 * create-release-tag.ts
 *
 * Creates an annotated git tag for the current engine version.
 * Usage: bun scripts/create-release-tag.ts [--push]
 *
 * See docs/release-and-publishing.md for the full release workflow.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');

export type ExistingTagDecision = 'create' | 'resume' | 'conflict';

/**
 * What to do about a tag that may already exist. A tag already on the commit
 * being released is the state a failed push leaves behind, so the run resumes
 * at the push; a tag on any other commit is somebody else's release and stays
 * an error.
 */
export function decideExistingTag(tagCommit: string | null, headCommit: string): ExistingTagDecision {
  if (tagCommit === null) return 'create';
  return tagCommit === headCommit ? 'resume' : 'conflict';
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: ENGINE_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

function main(): void {
  const enginePkg = JSON.parse(readFileSync(resolve(ENGINE_ROOT, 'package.json'), 'utf8'));
  const version: string = enginePkg.version;
  const tag = `v${version}`;
  const PUSH = process.argv.includes('--push');

  // Verify working tree is clean
  try {
    const status = run('git', ['status', '--porcelain']);
    if (status.trim()) {
      console.error(`[release:tag] ERROR: Working tree is not clean. Commit or stash changes before tagging.`);
      console.error(status);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[release:tag] ERROR: Could not read git status. (${e instanceof Error ? e.message : String(e)})`);
    process.exit(1);
  }

  // Check whether the tag already exists, and where it points
  let created = false;
  let decision: ExistingTagDecision = 'create';
  try {
    const existing = run('git', ['tag', '-l', tag]).trim();
    if (existing === tag) {
      const tagCommit = run('git', ['rev-parse', `${tag}^{commit}`]).trim();
      const headCommit = run('git', ['rev-parse', 'HEAD']).trim();
      decision = decideExistingTag(tagCommit, headCommit);
      if (decision === 'conflict') {
        console.error(`[release:tag] ERROR: Tag ${tag} already exists on ${tagCommit}, not on the current commit ${headCommit}. Nothing was changed. Delete it first (git tag -d ${tag}) if you need to re-tag.`);
        process.exit(1);
      }
    }
  } catch {
    // ignore
  }

  if (decision === 'resume') {
    console.log(`[release:tag] Tag ${tag} already exists on the current commit; resuming without re-creating it.`);
  } else {
    console.log(`[release:tag] Creating annotated tag ${tag} for v${version} …`);
    try {
      run('git', ['tag', '-a', tag, '-m', `release ${version}`]);
      created = true;
      console.log(`[release:tag] Tag ${tag} created successfully.`);
    } catch (e) {
      console.error(`[release:tag] ERROR: Failed to create tag ${tag}. (${e instanceof Error ? e.message : String(e)})`);
      process.exit(1);
    }
  }

  if (PUSH) {
    console.log(`[release:tag] Pushing ${tag} to origin …`);
    try {
      run('git', ['push', 'origin', tag]);
    } catch (e) {
      console.error(`[release:tag] ERROR: Push of ${tag} failed; the local tag ${created ? 'was created and ' : ''}is kept. (${e instanceof Error ? e.message : String(e)})`);
      console.error(`[release:tag] Re-run to resume at the push: bun scripts/create-release-tag.ts --push`);
      process.exit(1);
    }
    console.log(`[release:tag] Pushed. This will trigger the Release workflow.`);
  } else {
    console.log(`[release:tag] Tag created locally. To push and trigger release:`);
    console.log(`  git push origin ${tag}`);
  }
}

if (import.meta.main) main();
