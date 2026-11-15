/**
 * The hint appended to a provider's own 400 when a reasoning level was sent
 * and the provider's text names the reasoning parameter. Decided in code: the
 * provider's message is shown as it wrote it, and nothing is read by a model
 * on the error path.
 */
const REASONING_PARAMETER = /reasoning|thinking|effort|budget_tokens/i;

export function reasoningRejectionHint(status: number, providerText: string, effort: string | undefined): string {
  if (status !== 400 || effort === undefined || !REASONING_PARAMETER.test(providerText)) return '';
  return ` Reasoning effort '${effort}' is the likely cause, this model may not accept that level.`
    + ' Choose another with /effort, or clear provider.reasoningEffort to use the model default.';
}
