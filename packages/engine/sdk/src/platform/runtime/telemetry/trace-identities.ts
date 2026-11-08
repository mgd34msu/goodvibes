import { generateTraceId } from './ids.js';

interface Alias {
  readonly source: string;
  readonly id: string;
  references: number;
}

/** Native trace IDs are identities, not summaries of arbitrary label text. */
function nativeTraceId(source: string): string | undefined {
  if (source.length === 32 && /^[0-9a-f]{32}$/i.test(source) && /[1-9a-f]/i.test(source)) return source.toLowerCase();
  if (source.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source)
    && /[1-9a-f]/i.test(source)) return source.replace(/-/g, '').toLowerCase();
  return undefined;
}

/**
 * One telemetry collector's alias ownership. Buffered records, errors, spans
 * and active operations retain their native identity. The last release removes
 * the alias; queries never issue identities and no process-global map is kept.
 */
export class TelemetryTraceIdentities {
  private readonly aliases = new Map<string, Alias>();
  private readonly identities = new Map<string, Alias>();

  /** Keep a temporary reference throughout synchronous publication/notification. */
  capture(source: string | undefined, publish: (id: string) => void): void {
    let id: string;
    if (!source || source.trim().length === 0) {
      id = generateTraceId();
    } else {
      let alias = this.aliases.get(source);
      const native = alias === undefined ? nativeTraceId(source) : undefined;
      if (native !== undefined) id = native;
      else {
        if (alias === undefined) {
          id = generateTraceId();
          while (this.identities.has(id)) id = generateTraceId();
          alias = { source, id, references: 0 };
          this.aliases.set(source, alias);
          this.identities.set(id, alias);
        }
        id = alias.id;
      }
    }
    this.retain(id);
    try { publish(id); }
    finally { this.release(id); }
  }

  retain(id: string): void {
    const alias = this.identities.get(id);
    if (alias !== undefined) alias.references++;
  }

  release(id: string): void {
    const alias = this.identities.get(id);
    if (alias === undefined) return;
    alias.references--;
    if (alias.references === 0) {
      this.identities.delete(id);
      this.aliases.delete(alias.source);
    }
  }

  resolve(source: string): string | undefined {
    return this.aliases.get(source)?.id ?? nativeTraceId(source);
  }
}
