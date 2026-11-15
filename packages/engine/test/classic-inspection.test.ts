import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { createRegistryTool } from '../platform/src/platform/tools/registry-tool/index.js';
import { detectProject } from '../platform/src/platform/tools/inspect/project.js';
import { inspectApi } from '../platform/src/platform/tools/inspect/project-routes.js';
import { inspectAccessibility } from '../platform/src/platform/tools/inspect/frontend-readings.js';
import { runEnvAudit } from '../platform/src/platform/tools/analyze/scan-modes.js';
import { runSecurity, runPermissions } from '../platform/src/platform/tools/analyze/scan-findings.js';
import { summarizeAnalyzeResult } from '../platform/src/platform/tools/analyze/shared.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); });
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  return fake.requests;
}

test.each(['Classic - Off', 'Preferred'] as const)('%s project inspection retains manifest facts with unassessed entry points', async policy => {
  const requests = outage();
  const root = makeProjectTempDir('classic-project');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-project', scripts: { test: 'custom-test-driver' } }));
  writeFileSync(join(root, 'candidate.ts'), 'export const value = 1;');
  await withDecisionModelPolicy(() => policy, async () => {
    const project = await detectProject(root);
    expect(project).toMatchObject({ type: 'nodejs', name: 'synthetic-project', provenance: 'classic', entryPointsSource: 'unassessed', entryPoints: [] });
    const attempted = requests.length;
    expect(attempted).toBe(policy === 'Preferred' ? 1 : 0);
    await detectProject(root);
    expect(requests).toHaveLength(attempted);
  });
});

test('Classic registry discovery uses local terms and leaves tool execution untouched', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({ definition: { name: 'inspect_source', description: 'Inspect source files', parameters: { type: 'object', properties: {} } },
      async execute() { executions++; return { success: true }; } });
    const tool = createRegistryTool(registry, { workingDirectory: '/synthetic/classic-registry' });
    const result = await tool.execute({ mode: 'search', type: 'tools', query: 'source' });
    expect(result.success).toBe(true);
    expect(JSON.parse(String(result.output))).toMatchObject({ provenance: 'classic', match_source: 'literal-token-overlap', results: [{ name: 'inspect_source' }] });
    expect(executions).toBe(0);
  });
  expect(requests).toHaveLength(0);
});

test('Classic env comparisons use an explicit filename convention and local secret candidates stay redacted', async () => {
  const requests = outage();
  const root = makeProjectTempDir('classic-analysis');
  writeFileSync(join(root, '.env.example'), 'PUBLIC_SETTING=\nOTHER_SETTING=\n');
  writeFileSync(join(root, '.env'), 'PUBLIC_SETTING=synthetic\n');
  const candidate = 'sk-' + 'synthetic'.repeat(8);
  writeFileSync(join(root, 'source.ts'), `const token = '${candidate}';`);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect(await runEnvAudit({ mode: 'env_audit' }, root)).toMatchObject({ provenance: 'classic', reference_source: 'filename-convention', reference: '.env.example' });
    const security = await runSecurity({ mode: 'security', securityScope: 'secrets' }, root);
    expect(security).toMatchObject({ provenance: 'classic', secrets: { assessment: 'local-patterns-only', semanticVerification: false } });
    expect(JSON.stringify(security)).not.toContain(candidate);
    expect(summarizeAnalyzeResult('security', security)).toMatchObject({ provenance: 'classic', secret_assessment: 'local-patterns-only' });
    const permissions = await runPermissions({ mode: 'permissions' }, root);
    expect(permissions).toMatchObject({ provenance: 'classic', assessment: 'call-shapes-only', findings: [] });
    expect(summarizeAnalyzeResult('permissions', permissions)).toMatchObject({ provenance: 'classic', assessment: 'call-shapes-only' });
  });
  expect(requests).toHaveLength(0);
});

test('Classic inspection lists the candidates code found as unassessed instead of returning a clean report', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const accessibility = await inspectAccessibility('<img src="test.png">');
    expect(accessibility.issues).toEqual([expect.objectContaining({ line: 1, code: 'img-alt', reading: 'unassessed' })]);
    expect(accessibility.assessment_note).toContain('unassessed');
    const notes: string[] = [];
    const root = makeProjectTempDir('classic-api');
    writeFileSync(join(root, 'server.ts'), "app.get('/health', handler);\n");
    expect(await inspectApi(root, 'express', [], notes)).toEqual([{ method: 'GET', path: '/health', file: 'server.ts', line: 1, reading: 'uncertain' }]);
    expect(notes.join(' ')).toContain('decision models are off');
  });
  expect(requests).toHaveLength(0);
});
