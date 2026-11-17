/**
 * Journey 13: the person can tell whether a decision model is in use.
 *
 * Run under the run's decision policy (RUNTHROUGH_POLICY, and the scripted
 * decision model when RUNTHROUGH_DECISION_URL is set; see lib.ts). For both
 * headless products:
 *  - `status` names the policy and says whether a decision model is in use;
 *  - a turn's result carries the no-model notice exactly when none is in use,
 *    and says why (none chosen, or none set).
 */
import { AGENT_ENTRY, TUI_ENTRY, Journey, runProduct, short, stage } from './lib.ts';

const journey = new Journey('j13-decision-notice');
const policy = process.env.RUNTHROUGH_POLICY || 'No Decision Model';
const scripted = Boolean(process.env.RUNTHROUGH_DECISION_URL);
const inUse = policy !== 'No Decision Model' && scripted;
const expected = inUse ? 'A decision model is in use'
  : policy === 'No Decision Model' ? 'judgment.policy is No Decision Model' : 'none is set';
const label = `${policy}, ${scripted ? 'scripted decision model' : 'nothing configured'}`;
const s = await stage(`j13-${policy.replace(/\s+/g, '-').toLowerCase()}-${scripted ? 'scripted' : 'none'}`);

try {
  s.model.script('RTJ13', [{ text: 'Hello from the run-through.' }]);
  await s.registerWorkspace();
  for (const [app, entry] of [['goodvibes', TUI_ENTRY], ['goodvibes-agent', AGENT_ENTRY]] as const) {
    const status = await runProduct(s.home, entry, ['status'], { timeoutMs: 60_000 });
    const statusText = `${status.stdout}\n${status.stderr}`;
    const block = statusText.split('\n').filter((line) => /decision model|judgment\.policy/i.test(line)).map((line) => line.trim());
    journey.check(`${label}: ${app} status says whether a decision model is in use`, `${app} status`,
      `exit ${status.code}; ${short(block.join(' | '), 400)}`, status.code === 0 && block.some((line) => line.includes(expected)) && block.some((line) => line.includes(policy)));

    const run = await runProduct(s.home, entry, ['run', '--output', 'json', 'RTJ13 say hello'], { timeoutMs: 90_000 });
    type Notice = { inUse?: boolean; line?: string; reason?: string };
    const result = (run.json ?? {}) as { decisionModel?: Notice; diagnostics?: { decisionModel?: Notice }; native?: { decisionModel?: Notice }; response?: string };
    const notice = result.diagnostics?.decisionModel ?? result.decisionModel ?? result.native?.decisionModel;
    journey.check(`${label}: a ${app} turn tells the person when no decision model is used`, `${app} run --output json`,
      `exit ${run.code}; decisionModel ${short(notice ?? 'absent', 300)}; response ${short(result.response ?? run.stdout, 120)}`,
      inUse ? notice === undefined && run.code === 0 : notice?.inUse === false && (notice.line ?? '').includes(expected));
  }
} catch (error) {
  journey.check(`${label}: journey ran to the end`, 'j13', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
}
journey.finish(s.base);
