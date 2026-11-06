import { formatJsonOrText as formatOutput } from './support-bundle-inspection.js';
export function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}
export function formatJsonOrText(cli: {
  readonly flags: { readonly outputFormat?: string | undefined };
}): (value: unknown, text: string) => string {
  return (value, text) => formatOutput({ cli }, value, text);
}

/** Legacy text-command status mapping, with product-specific prefixes supplied at construction. */
export function commandTextExitCode(output: string, usagePrefixes: readonly string[], failurePrefixes: readonly string[]): number {
  if (usagePrefixes.some((prefix) => output.startsWith(prefix))) return 2;
  if (failurePrefixes.some((prefix) => output.startsWith(prefix))) return 1;
  if (['No stored ', 'No pending ', 'No model ', 'No provider ', 'No auth ', 'Unknown '].some((prefix) => output.startsWith(prefix)))
    return 1;
  return output === 'Bundle has no config object to import.' ? 1 : 0;
}

export function commandJsonOrText(
  runtime: { readonly cli: { readonly flags: { readonly outputFormat?: string | undefined } } },
  value: unknown,
  text: string,
): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}
