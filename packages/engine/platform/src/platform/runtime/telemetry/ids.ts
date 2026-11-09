import { randomBytes } from 'node:crypto';

function nonzeroId(bytes: number): string {
  for (;;) {
    const value = randomBytes(bytes).toString('hex');
    if (/[1-9a-f]/.test(value)) return value;
  }
}

/** Native OTel identities; existing owner maps retain parent/child links. */
export const generateSpanId = (): string => nonzeroId(8);
export const generateTraceId = (): string => nonzeroId(16);
