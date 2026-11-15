/**
 * Pin the model catalog to one models.dev commit: resolve the repository's
 * development head, download that commit's archive, and write its commit id
 * and SHA-256 into platform/src/platform/providers/model-catalog-pin.ts.
 * Run it, review the diff, and ship it with a release; the product then reads
 * only that archive and refuses any other bytes.
 *
 *   bun packages/engine/scripts/model-catalog-pin.ts [commit]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PIN_FILE = fileURLToPath(new URL('../platform/src/platform/providers/model-catalog-pin.ts', import.meta.url));

async function resolveCommit(requested: string | undefined): Promise<string> {
  if (requested) {
    if (!/^[0-9a-f]{40}$/.test(requested)) throw new Error(`Not a full commit id: ${requested}`);
    return requested;
  }
  const response = await fetch('https://api.github.com/repos/anomalyco/models.dev/commits/dev', {
    headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'goodvibes-model-catalog-pin' },
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for the dev head`);
  const commit = (await response.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`GitHub returned an unexpected commit id: ${commit.slice(0, 80)}`);
  return commit;
}

async function archiveSha256(commit: string): Promise<string> {
  const response = await fetch(`https://codeload.github.com/anomalyco/models.dev/tar.gz/${commit}`, { headers: { Accept: 'application/gzip' } });
  if (!response.ok) throw new Error(`codeload answered HTTP ${response.status} for ${commit}`);
  return createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
}

const commit = await resolveCommit(process.argv[2]);
const sha256 = await archiveSha256(commit);
const source = readFileSync(PIN_FILE, 'utf8');
const declaration = /export const MODEL_CATALOG_PIN: ModelCatalogPin \| null = [^;]*;/;
if (!declaration.test(source)) throw new Error(`No MODEL_CATALOG_PIN declaration found in ${PIN_FILE}`);
writeFileSync(PIN_FILE, source.replace(declaration, `export const MODEL_CATALOG_PIN: ModelCatalogPin | null = {\n  commit: '${commit}',\n  sha256: '${sha256}',\n};`));
process.stdout.write(`Pinned the model catalog to ${commit} (sha256 ${sha256}).\n`);
