/** Parse npm pack reports once across package-verification surfaces. */
export interface NpmPackDryRunResult {
  readonly files: readonly string[];
  readonly entryCount: number;
  readonly unpackedSize: number;
}
interface NpmPackJsonEntry {
  readonly files?:
    | ReadonlyArray<{
        readonly path?: string | undefined;
      } | null>
    | undefined;
  readonly entryCount?: number | undefined;
  readonly unpackedSize?: number | undefined;
}
function describeNpmPackOutput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'no output at all';
  const preview = trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
  return `${trimmed.length} characters of output beginning: ${preview}`;
}
// npm wrappers (version-manager shims, "npm notice" lines) sometimes print plain text
// on stdout alongside the JSON document. Take the first balanced JSON value and ignore
// whatever surrounds it, tracking string literals so braces inside paths do not confuse
// the depth count.
function extractJsonDocument(raw: string): string | undefined {
  const start = raw.search(/[[{]/);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return undefined;
}
function looksLikePackEntry(value: unknown): value is NpmPackJsonEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.files) || typeof candidate.entryCount === 'number' || typeof candidate.unpackedSize === 'number';
}
function selectPackEntry(parsed: unknown): NpmPackJsonEntry | undefined {
  // npm 10/11 emit `[{ files, entryCount, unpackedSize }]`.
  if (Array.isArray(parsed)) return parsed.find(looksLikePackEntry);
  // npm 12 emits `{ "<package-name>": { files, entryCount, unpackedSize } }`.
  if (looksLikePackEntry(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>).find(looksLikePackEntry);
  return undefined;
}
export function parseNpmPackJson(raw: string): NpmPackDryRunResult {
  const document = extractJsonDocument(raw);
  if (document === undefined) {
    throw new Error(`npm pack --json --dry-run printed no JSON document; npm emitted ${describeNpmPackOutput(raw)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `npm pack --json --dry-run printed JSON that could not be parsed (${reason}); npm emitted ${describeNpmPackOutput(raw)}`,
    );
  }
  const entry = selectPackEntry(parsed);
  if (!entry) {
    throw new Error(
      `npm pack --json --dry-run returned an unrecognized JSON shape; expected an array of pack results or an object keyed by package name, but npm emitted ${describeNpmPackOutput(raw)}`,
    );
  }
  return {
    files: Array.isArray(entry.files) ? entry.files.map((file) => String(file?.path ?? '')) : [],
    entryCount: Number(entry.entryCount ?? 0),
    unpackedSize: Number(entry.unpackedSize ?? 0),
  };
}
