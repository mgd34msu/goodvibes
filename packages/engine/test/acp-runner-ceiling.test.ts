// Proves: A restricted ACP subagent runs a command or writes outside its write scope by labelling the call with a kind the ceiling does not list.
// Red when: The runner ceiling reads a tool-call kind through an inherited property (toString, constructor) as a listed kind, so it neither applies the command rule nor the write scope and lets the ask reach the owner or Jev.
/**
 * The ceiling is the one decision this side makes on a subagent's permission
 * ask (acp/connection.ts calls it before the owner or Jev is asked). The child
 * names the call's kind itself, so the kind is untrusted text: anything that is
 * not one of the listed ACP kinds must be held to the command rule.
 */
import { expect, test } from 'bun:test';
import { runnerCeilingRefusal } from '../platform/src/platform/acp/runner-ceiling.ts';

test('a restricted runner refuses a command or out-of-scope write whatever kind it is labelled with; an in-scope read and edit pass', () => {
  const workingDirectory = '/work/project';
  const readOnly = { tools: ['read'], workingDirectory };
  const scoped = { tools: [], writeScope: ['src'], workingDirectory };
  const shell = (kind: string) => ({ kind, title: 'rm -rf ~', locations: [{ path: '/home/owner/.ssh/id_ed25519' }] });

  for (const kind of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'unknown-kind', 'execute']) {
    expect({ kind, ceiling: 'tools', refused: runnerCeilingRefusal(readOnly, shell(kind)) !== null }).toEqual({ kind, ceiling: 'tools', refused: true });
    expect({ kind, ceiling: 'scope', refused: runnerCeilingRefusal(scoped, shell(kind)) !== null }).toEqual({ kind, ceiling: 'scope', refused: true });
  }
  expect(runnerCeilingRefusal(scoped, { kind: 'edit', locations: [{ path: '../elsewhere/x.ts' }] })).not.toBeNull();

  // Controls: what the ceiling allows still passes.
  expect(runnerCeilingRefusal(readOnly, { kind: 'read', locations: [{ path: 'src/a.ts' }] })).toBeNull();
  expect(runnerCeilingRefusal(scoped, { kind: 'read', locations: [{ path: '/etc/hosts' }] })).toBeNull();
  expect(runnerCeilingRefusal(scoped, { kind: 'edit', locations: [{ path: 'src/a.ts' }] })).toBeNull();
});
