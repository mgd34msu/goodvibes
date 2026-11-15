/**
 * Which pending ask an owner's reply answers, when several wait in one
 * conversation. The reply itself is read in the message's one inbound reading
 * (inbound-message.ts), where a conditional yes is an amendment, never
 * permission to run the original arguments.
 */
import { defineSelector, NONE, STAKES_BANDS } from '@goodvibes-jev/judgment';

const DEPLOY = { approvalId: 'deploy', tool: 'run_command', summary: 'Deploy the production application', arguments: { command: 'deploy production' } };
const EXPORT = { approvalId: 'export', tool: 'export_data', summary: 'Export the customer database', arguments: { destination: 'customers.csv' } };
const CANDIDATES = [{ id: 'export', content: EXPORT }, { id: 'deploy', content: DEPLOY }];

export const channelApprovalTarget = defineSelector({
  name: 'engine.daemon.approval-target',
  version: 1,
  description: 'Which one of the authorized pending asks the owner is answering, or none when the reply does not identify exactly one.',
  accuracyFloor: 0.9,
  instructions: 'Which single pending ask in candidates does context.reply answer? Match an explicit approval id, tool, or proposal meaning. Choose none when the reply is unrelated, refers to several asks, or could answer more than one. Candidate order is not conversational evidence: never default to the first, newest, or last ask.',
  fitInstructions: 'Does context.reply unambiguously answer this particular pending ask and no other offered ask? A bare yes or no when several asks are pending is not enough. Naming another ask to exclude it does not answer the excluded ask. Use the full reply, including corrections and exceptions.',
  band: STAKES_BANDS.high.confidence,
  fitBand: STAKES_BANDS.high.yesNo,
  fixtures: [
    { name: 'names older proposal rather than first candidate', context: { reply: 'Approve the production deployment.' }, candidates: CANDIDATES, expect: 'deploy' },
    { name: 'names export tool', context: { reply: 'Deny export_data; leave the deployment question open.' }, candidates: CANDIDATES, expect: 'export' },
    { name: 'explicit approval id', context: { reply: 'Approval deploy: yes.' }, candidates: CANDIDATES, expect: 'deploy' },
    { name: 'amendment identifies its target', context: { reply: 'For the deployment, only use staging.' }, candidates: CANDIDATES, expect: 'deploy' },
    { name: 'bare yes with two asks', context: { reply: 'yes' }, candidates: CANDIDATES, expect: NONE },
    { name: 'bare no with two asks', context: { reply: 'no' }, candidates: CANDIDATES, expect: NONE },
    { name: 'answers both asks', context: { reply: 'Approve both the export and the deployment.' }, candidates: CANDIDATES, expect: NONE },
    { name: 'unrelated new request', context: { reply: 'Can you check the weather tomorrow?' }, candidates: CANDIDATES, expect: NONE },
  ],
});
