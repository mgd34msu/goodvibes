/**
 * The methods of Work (the ledger, the plans, the native runs): the owner's own daemon turn (his web chat, his
 * schedules, his triggers: security/turn-input-party.ts) uses his Work as he does at his own machine, with his local
 * authority, whether it reaches a method through a capability (daemon/capability-wiring.ts) or by the method's id
 * (tools/capability/daemon-tools.ts). Someone else's turn never does.
 */
export const OWNER_WORK_METHOD = /^(?:work\.|workLedger\.)/u;

/** True for a method of Work. */
export function isOwnerWorkMethod(methodId: string): boolean {
  return OWNER_WORK_METHOD.test(methodId);
}
