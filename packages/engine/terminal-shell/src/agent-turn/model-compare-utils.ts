import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';

import { readString } from './tool-args.js';

export { readString };

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export function readBenchmarkKind(value: unknown): string {
  return readComparisonTag(value);
}

export function readComparisonTag(value: unknown): string {
  return readString(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim();
}

/** Fisher-Yates over a copy; `random` is injectable so a test can fix the order. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): readonly T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.min(index, Math.floor(random() * (index + 1)));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

/**
 * Every artifact descriptor, newest first. The store only offers "newest N", so
 * a fixed window would report older judgments and comparisons as absent.
 */
export function listAllArtifacts(store: { readonly list?: (limit?: number) => ArtifactDescriptor[] } | undefined): ArtifactDescriptor[] {
  return store?.list?.(Number.MAX_SAFE_INTEGER) ?? [];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

export function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

export function previewText(value: string, limit = 96): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

export function isTextLike(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('yaml')
    || normalized.includes('csv')
    || normalized.includes('javascript')
    || normalized.includes('typescript')
    || normalized.includes('markdown');
}

export function readModelRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => readString(entry))
      .filter(Boolean);
  }
  const text = readString(value);
  if (!text) return [];
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

export function readStringList(value: unknown): readonly string[] {
  const raw = Array.isArray(value)
    ? value
    : readString(value).split(/[\n,]/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const text = readString(entry);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}
