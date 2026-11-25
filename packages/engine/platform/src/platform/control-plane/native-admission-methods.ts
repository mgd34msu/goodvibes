/**
 * The daemon methods the daemon admits natively when the GoodVibes Agent's credential calls them
 * (`runNativeMutation`, native-mutation.ts): for such a call the daemon's own admission, under the owner's mode, is
 * the decision. A model's call that becomes one of them is therefore not decided again by the program that sends it
 * (the `hostDecides` declaration of the nested method tool): exactly one decision, at the daemon. Every method here is
 * one a `runNativeMutation` call names; a method added there is added here.
 */
export const NATIVELY_ADMITTED_METHOD_IDS: ReadonlySet<string> = new Set([
  // daemon/http/native-automation.ts
  'automation.jobs.create', 'automation.schedules.create', 'automation.jobs.update',
  'automation.jobs.enable', 'automation.jobs.disable', 'automation.jobs.delete',
  'automation.schedules.resume', 'automation.schedules.pause', 'automation.schedules.delete',
  // channels/host-routing/registration.ts, channels/host-drafts/register.ts
  'channels.routing.assign', 'channels.routing.delete', 'channels.drafts.save', 'channels.drafts.delete',
  // control-plane/routes/owner-profile.ts and occasions.ts, through native-profile-mutation.ts
  'profile.set', 'profile.append', 'profile.forget', 'profile.undo',
  'occasions.confirm', 'occasions.plans.confirm', 'occasions.remove', 'occasions.conflict.resolve',
  'occasions.update', 'occasions.plans.update', 'occasions.plans.remove',
  'occasions.answer', 'occasions.acknowledge', 'occasions.interview.answer', 'occasions.interview.record',
  'occasions.sweep', 'occasions.sweep.deliver',
]);
