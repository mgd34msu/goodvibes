import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ApprovalRecord } from '../../lib/goodvibes';
import type { ApprovalActions } from './useApprovalActions';
import { ApprovalDetail } from './ApprovalDetail';

const idle = () => ({ mutate: mock(() => {}), isPending: false, variables: undefined });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

function record(status: string): ApprovalRecord {
  return {
    id: 'ap-1', callId: 'c1', status, claimedBy: 'phone', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, metadata: {},
    request: { callId: 'c1', tool: 'bash', args: { command: 'ls' }, category: 'shell', analysis: { riskLevel: 'low', summary: '', reasons: [] } },
  } as unknown as ApprovalRecord;
}

function mount(status: string) {
  const actions = { approve: idle(), deny: idle(), claim: idle(), cancel: idle() };
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  flushSync(() => root.render(<ApprovalDetail record={record(status)} actions={actions as unknown as ApprovalActions} />));
  cleanups.push(() => { flushSync(() => root.unmount()); el.remove(); });
  const button = (name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name);
  return { actions, button };
}

test('a claimed approval can still be approved or denied, and cannot be claimed again', () => {
  const { actions, button } = mount('claimed');
  expect(button('Claim')).toBeUndefined();
  button('Approve')!.click();
  button('Deny')!.click();
  expect(actions.approve.mutate).toHaveBeenCalledTimes(1);
  expect(actions.deny.mutate).toHaveBeenCalledTimes(1);
});

test('a resolved approval has no decision buttons', () => {
  const { button } = mount('approved');
  expect(button('Approve')).toBeUndefined();
  expect(button('Deny')).toBeUndefined();
});
