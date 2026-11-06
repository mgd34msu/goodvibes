import { formatJsonOrText as formatOutput } from './support-bundle-inspection.js';
export function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}
export function formatJsonOrText(cli: {
  readonly flags: { readonly outputFormat?: string | undefined };
}): (value: unknown, text: string) => string {
  return (value, text) => formatOutput({ cli }, value, text);
}
