import { z, toJSONSchema } from 'zod/v4';
import { methodDescriptor, type GatewayMethodEffect } from './method-catalog-shared.js';
import { WORK_LEDGER_WRITE_SCOPE } from './method-catalog-native-work-submission.js';
import { delegatedTelegramResultSchemas, delegatedTelegramConfigureSchema, delegatedTelegramDecisionSchema, delegatedTelegramLookupSchema, delegatedTelegramRevokeSchema, delegatedTelegramReleaseSchema, type DelegatedTelegramOperation } from './delegated-inbound-wire.js';

/**
 * Delegated Telegram intake, one method per owner command. A selected chat's
 * messages wait for the owner: each raises an approval (answered in the
 * approvals view), an approved message enters the review queue
 * (`accepted-for-review`), reading its original marks it `reviewed`, and the
 * owner closes it with cancel, or it expires. Nothing is executed.
 */
const operations: Readonly<Record<DelegatedTelegramOperation, { readonly input: z.ZodType; readonly effect: GatewayMethodEffect; readonly description: string }>> = {
  configure: { input: delegatedTelegramConfigureSchema, effect: 'write', description: 'Select one Telegram chat (and thread) for delegated intake: its messages stop being handled normally and each one waits for the owner instead, held in memory only for pendingRetentionMs. The configuration ends after configurationLifetimeMs; the chat stays selected and held until released.' },
  decide: { input: delegatedTelegramDecisionSchema, effect: 'write', description: 'Answer one waiting message: approve it with explicit retention choices (it enters the review queue as accepted-for-review) or deny it (its original is released). One decision per message; nothing is executed.' },
  status: { input: delegatedTelegramLookupSchema, effect: 'read', description: 'Where one message stands: waiting for the owner, in the review queue (accepted-for-review or reviewed, with whether its original is still in memory), or held with the reason and next step.' },
  read: { input: delegatedTelegramLookupSchema, effect: 'read', description: 'Read the original text of a message in the review queue while it is still in memory; the review is marked reviewed. Held with the reason when the original expired or was released.' },
  list: { input: z.object({}).strict(), effect: 'read', description: 'The review queue (accepted-for-review and reviewed rows) and the messages still waiting for the owner\'s decision, for the calling owner.' },
  cancel: { input: delegatedTelegramLookupSchema, effect: 'write', description: 'Close a review: the row leaves the queue at once, its place is freed and its original is released. Also withdraws a message still waiting for a decision.' },
  revoke: { input: delegatedTelegramRevokeSchema, effect: 'write', description: 'End a configuration: no new message is captured. The chat stays selected and held (not answered normally) until inbound.telegram.release.' },
  release: { input: delegatedTelegramReleaseSchema, effect: 'write', description: 'Stop routing this chat through delegated intake and return it to normal handling. Pass the configurationId, or the chatId (and threadId) when no configuration exists.' },
};

export const builtinDelegatedInboundMethodDescriptors = (Object.keys(operations) as DelegatedTelegramOperation[]).map((operation) => methodDescriptor({
  id: `inbound.telegram.${operation}`, title: `Telegram Delegated Intake ${operation}`, category: 'inbound',
  description: operations[operation].description,
  effects: ['work-ledger.inspect', 'work-ledger.administer'],
  // A second configure selects the chat again under a new configuration; every other call settles what is already settled.
  repeat: operation === 'configure' ? 'unsafe' : 'safe',
  http: { method: 'POST', path: `/api/inbound/telegram/${operation}` },
  inputSchema: toJSONSchema(operations[operation].input), outputSchema: toJSONSchema(delegatedTelegramResultSchemas[operation]),
}));
