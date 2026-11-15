import { isSecretRefInput } from './secret-refs.js';

const RAW_SECRET_LITERAL_PREFIX = '__GOODVIBES_LITERAL_V1__';

function isGoodVibesSecretPointer(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

/**
 * A credential that merely looks like a reference (`op://...`, a JSON ref) is
 * stored wrapped so a read hands it to the provider instead of a subprocess.
 * `goodvibes://secrets/...` is the platform's own pointer form and stays a pointer.
 */
export function shouldStoreAsLiteral(value: string): boolean {
  return value.startsWith(RAW_SECRET_LITERAL_PREFIX)
    || (isSecretRefInput(value) && !isGoodVibesSecretPointer(value));
}

export function encodeLiteralSecret(value: string): string {
  return `${RAW_SECRET_LITERAL_PREFIX}${Buffer.from(JSON.stringify({ value }), 'utf-8').toString('base64url')}`;
}

/** The original text of a wrapped literal, or null when `value` is not one. */
export function decodeLiteralSecret(value: string): string | null {
  if (!value.startsWith(RAW_SECRET_LITERAL_PREFIX)) return null;
  try {
    const decoded = Buffer.from(value.slice(RAW_SECRET_LITERAL_PREFIX.length), 'base64url').toString('utf-8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { value?: unknown }).value !== 'string') return null;
    return (parsed as { value: string }).value;
  } catch {
    return null;
  }
}
