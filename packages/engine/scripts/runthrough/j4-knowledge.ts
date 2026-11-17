/**
 * Journey 4: knowledge search.
 *
 *  - three documents are ingested into the daemon's knowledge (a workspace
 *    file each, as `knowledge ingest` does);
 *  - a search returns the document the question is about first;
 *  - asking a question with decision models off is answered or refused with
 *    what to do instead (never a daemon fault);
 *  - counts: decision-model requests (a loopback decision endpoint counts
 *    any), model requests and the daemon's read syscalls for one search;
 *  - the Agent attached to the daemon finds the same document in its own
 *    knowledge space through its agent_knowledge tool.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENTRY, Journey, api, operatorToken, permissionAnswerer, runProduct, short, stage } from './lib.ts';

const journey = new Journey('j4-knowledge');
const s = await stage('j4');
const ws = s.home.workspace;
const DOCS: Record<string, string> = {
  'deploy.md': '# Deploying the service\nRun bun run deploy from the release branch. The deploy uploads the bundle to the edge and runs the database migrations first.',
  'pasta.md': '# Pasta recipe\nBoil water, add salt, cook the pasta for nine minutes, drain and serve with sauce.',
  'backups.md': '# Backups\nNightly backups go to the cold bucket and are kept for thirty days.',
};
const procIo = (): { reads: number; bytes: number } => {
  const fields = Object.fromEntries(readFileSync(`/proc/${s.daemon.pid}/io`, 'utf8').trim().split('\n').map((line) => { const [key, value] = line.split(':'); return [key!.trim(), Number(value)]; }));
  return { reads: fields.syscr ?? 0, bytes: fields.rchar ?? 0 };
};

try {
  const token = operatorToken(s.home);
  for (const prefix of ['/api/knowledge', '/api/goodvibes-agent/knowledge']) {
    const statuses: string[] = [];
    for (const [name, text] of Object.entries(DOCS)) {
      writeFileSync(join(ws, name), text);
      const ingested = await api(s.daemon, token, 'POST', `${prefix}/ingest/artifact`, { path: join(ws, name), title: name });
      statuses.push(`${name} ${ingested.status}${ingested.status >= 300 ? ` ${short(ingested.text, 160)}` : ''}`);
    }
    journey.check(`ingest three documents into ${prefix}`, `POST ${prefix}/ingest/artifact { path, title } x3`, statuses.join('; '), statuses.every((line) => / 20[01]$/.test(line)));
  }

  const modelBefore = s.model.requests.length;
  const before = procIo();
  const searched = await api(s.daemon, token, 'POST', '/api/knowledge/search', { query: 'how do I deploy the service', limit: 5 });
  const after = procIo();
  const results = (searched.body as { results?: Array<{ source?: { title?: string }; node?: { title?: string }; score?: number }> }).results ?? [];
  const titles = results.map((result) => result.source?.title ?? result.node?.title ?? '?');
  journey.check('a search returns the document the question is about first', 'POST /api/knowledge/search { query: "how do I deploy the service" }',
    `${searched.status}; results ${JSON.stringify(titles)}`, searched.status === 200 && titles[0] === 'deploy.md' && !titles.slice(0, 1).includes('pasta.md'));
  journey.check('one search: decision requests, model requests and daemon reads are bounded', 'counts across that search',
    `decision requests 0 (decision models off; none configured); model requests ${s.model.requests.length - modelBefore}; daemon read syscalls ${after.reads - before.reads}, bytes read ${after.bytes - before.bytes}`,
    s.model.requests.length - modelBefore === 0 && after.reads - before.reads < 400);

  const asked = await api(s.daemon, token, 'POST', '/api/knowledge/ask', { query: 'how do I deploy the service?' });
  journey.check('asking a question is answered, or refused with what to do (decision models off)', 'POST /api/knowledge/ask',
    `${asked.status} ${short(asked.text, 300)}`,
    (asked.status === 200 && /deploy/i.test(asked.text)) || (asked.status === 409 && (asked.body as { code?: string }).code === 'DECISION_MODELS_DISABLED' && /search/.test(asked.text)));

  await s.registerWorkspace();
  // agent_knowledge is offered as a one-line entry; a first call loads its definition and is sent again, as a model does.
  const knowledgeCall = { calls: [{ name: 'agent_knowledge', args: { action: 'search', query: 'how do I deploy the service' } }] };
  s.model.script('RTJ4AGENT', [knowledgeCall, knowledgeCall, { text: 'Found the deploy notes.' }]);
  const run = await runProduct(s.home, AGENT_ENTRY, ['run', '--output', 'stream-json', '--omit-accumulated', '--answer-permissions', 'RTJ4AGENT where are the deploy notes?'], { onLine: permissionAnswerer(() => true) });
  const result = s.model.toolResults('RTJ4AGENT').at(-1)?.content ?? '';
  journey.check('the Agent attached to the daemon finds the document in its own knowledge', 'goodvibes-agent run: model calls agent_knowledge { action: search }',
    `exit ${run.code}; tool result ${short(result, 400)}`, run.code === 0 && result.includes('deploy.md') && !/^Error/.test(result));
} catch (error) {
  journey.check('journey ran to the end', 'j4', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
}
journey.finish(s.base);
