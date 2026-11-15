/**
 * `engine.ecosystem.catalog-search`: is this catalog entry something the
 * person searching for `query` is looking for? Read by Jev in place of the
 * substring match searchEcosystemCatalog used to make: the lowercased query
 * contained in the id, name, summary, source, trust notes, install hint and
 * tags joined into one string. That rule missed entries described in other
 * words ("github" never found a "pull request tools" entry) and kept entries
 * that only shared letters with the query ("auth" matched "author").
 *
 * One yes/no per entry, asked for a page of entries at once: the state carries
 * the query and the page, and the question names one entry by its index
 * ({@link catalogSearchAt}), so a page costs one request instead of one per
 * entry. Other entries on the page are context, never an alternative target.
 * An empty query lists everything with no reading; that guard, the paging, the
 * cache and the name order stay code in catalog.ts.
 *
 * Band: low stakes. The result only filters a listing; installing an entry
 * still takes an explicit review and `/marketplace install`.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';
import type { EcosystemCatalogEntry } from '../catalog.js';

/** What the question sees of an entry: its words, never its source path, signature or version. */
export function catalogSearchEntryView(entry: EcosystemCatalogEntry): { [field: string]: string | string[] } {
  return {
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    tags: [...entry.tags],
    ...(entry.installHint ? { installHint: entry.installHint } : {}),
    ...(entry.trustNotes ? { trustNotes: entry.trustNotes } : {}),
  };
}

const entry = (fields: Pick<EcosystemCatalogEntry, 'id' | 'kind' | 'name' | 'summary' | 'tags'> & { installHint?: string; trustNotes?: string }) =>
  catalogSearchEntryView({ source: 'catalog', ...fields });

const PR_TOOLS = entry({
  id: 'pr-tools',
  kind: 'plugin',
  name: 'Pull request tools',
  summary: 'Lets the agent open, comment on and merge pull requests and read CI checks on GitHub.',
  tags: ['vcs', 'code-host'],
});
const AUTHOR_STATS = entry({
  id: 'author-stats',
  kind: 'plugin',
  name: 'Author stats',
  summary: 'Counts commits and changed lines per author for a weekly contribution report.',
  tags: ['git', 'report'],
});
const OAUTH_HELPER = entry({
  id: 'oauth-helper',
  kind: 'hook-pack',
  name: 'OAuth helper',
  summary: 'Signs in to MCP servers that ask for OAuth and refreshes their tokens before they expire.',
  tags: ['mcp', 'login'],
});
const SOLARIZED_THEME = entry({
  id: 'solarized-theme',
  kind: 'plugin',
  name: 'Solarized theme',
  summary: 'Solarized light and dark color schemes for the terminal UI.',
  tags: ['theme', 'ui'],
});
const DOCS_WRITER = entry({
  id: 'docs-writer',
  kind: 'skill',
  name: 'Docs writer',
  summary: 'Writes and updates README files, API reference pages and changelogs from the code.',
  tags: ['writing'],
});
const TEST_RUNNER_HOOKS = entry({
  id: 'test-on-save',
  kind: 'hook-pack',
  name: 'Test on save',
  summary: 'Runs the unit tests that cover a file after the agent edits it.',
  tags: ['testing', 'hooks'],
});
const READONLY_SHELL = entry({
  id: 'readonly-shell',
  kind: 'policy-pack',
  name: 'Read-only shell',
  summary: 'Allows shell commands that only read files and asks before anything that writes or deletes.',
  tags: ['policy', 'shell'],
});
const DOCKER_DEPLOY = entry({
  id: 'container-deploy',
  kind: 'plugin',
  name: 'Container deploy',
  summary: 'Builds images and pushes them to a registry, then rolls out the new version to Kubernetes.',
  tags: ['deploy', 'containers'],
  installHint: 'Needs docker and kubectl on PATH.',
});
const RECIPE_SKILL = entry({
  id: 'recipe-scaling',
  kind: 'skill',
  name: 'Recipe scaling',
  summary: 'Scales cooking recipes to a different number of servings and converts units.',
  tags: ['cooking'],
});
const SECRET_SCAN = entry({
  id: 'secret-scan',
  kind: 'hook-pack',
  name: 'Secret scan',
  summary: 'Blocks a commit when a staged file contains an API key, token or private key.',
  tags: ['commit', 'credentials'],
});

const one = (query: string, entry: { [field: string]: string | string[] }) => ({ query, entries: [entry] });

/** The question about `entries[index]` of a page; the index names evidence, nothing else. */
export function catalogSearchAt(index: number) {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid catalog page index.');
  return defineBattery({
    name: 'engine.ecosystem.catalog-search',
    version: 2,
    description: 'Whether an ecosystem catalog entry is something the person searching the catalog with a query is looking for.',
    accuracyFloor: 0.9,
    items: {
      wanted: yesNo(
        `\`query\` is what a person typed to search the ecosystem catalog. \`entries\` is a page of catalog entries. Is entries[${index}] something the person searching for \`query\` is looking for? The other entries are context, not alternatives.`,
        STAKES_BANDS.low.yesNo,
        {
          true: "The entry's name, summary, tags or notes describe what the query asks for, in the same or other words.",
          false: 'The entry is about something else, or only shares letters or a word with the query.',
        },
      ),
    },
    fixtures: [
      { name: 'github finds pull request tools described in other words', state: one('github', PR_TOOLS), expect: { wanted: 'yes' } },
      { name: 'pull requests finds pull request tools by name', state: one('pull requests', PR_TOOLS), expect: { wanted: 'yes' } },
      { name: 'auth does not find author stats that only share letters', state: one('auth', AUTHOR_STATS), expect: { wanted: 'no' } },
      { name: 'auth finds the OAuth sign-in hooks', state: one('auth', OAUTH_HELPER), expect: { wanted: 'yes' } },
      { name: 'dark mode finds the solarized color schemes', state: one('dark mode', SOLARIZED_THEME), expect: { wanted: 'yes' } },
      { name: 'dark mode does not find pull request tools', state: one('dark mode', PR_TOOLS), expect: { wanted: 'no' } },
      { name: 'documentation finds the docs writer skill', state: one('documentation', DOCS_WRITER), expect: { wanted: 'yes' } },
      { name: 'documentation does not find the recipe skill', state: one('documentation', RECIPE_SKILL), expect: { wanted: 'no' } },
      { name: 'run tests finds the test on save hooks', state: one('run tests', TEST_RUNNER_HOOKS), expect: { wanted: 'yes' } },
      { name: 'run tests does not find the read-only shell policy', state: one('run tests', READONLY_SHELL), expect: { wanted: 'no' } },
      { name: 'docker finds the container deploy plugin', state: one('docker', DOCKER_DEPLOY), expect: { wanted: 'yes' } },
      { name: 'docs does not find the container deploy plugin', state: one('docs', DOCKER_DEPLOY), expect: { wanted: 'no' } },
      { name: 'leaked credentials finds the secret scan hooks', state: one('leaked credentials', SECRET_SCAN), expect: { wanted: 'yes' } },
      { name: 'shell permissions finds the read-only shell policy', state: one('shell permissions', READONLY_SHELL), expect: { wanted: 'yes' } },
      { name: 'kubernetes does not find the recipe skill', state: one('kubernetes', RECIPE_SKILL), expect: { wanted: 'no' } },
      { name: 'theme does not find the secret scan hooks', state: one('theme', SECRET_SCAN), expect: { wanted: 'no' } },
      { name: 'a matching entry later on the page does not make the first one a match', state: { query: 'auth', entries: [AUTHOR_STATS, OAUTH_HELPER] }, expect: { wanted: 'no' } },
    ],
  });
}

/** The registered reading: the question about the first entry of a page. */
export const catalogSearch = catalogSearchAt(0);
