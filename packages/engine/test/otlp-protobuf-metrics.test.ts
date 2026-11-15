/**
 * Protobuf decoding of OTLP metric data points: each metric type has its own
 * field numbering, and int64 values are signed.
 */
import { describe, expect, test } from 'bun:test';
import { decodeOtlpProtobuf } from '../daemon-api/src/otlp-protobuf.js';

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function varint(value: bigint): Uint8Array {
  let v = BigInt.asUintN(64, value);
  const out: number[] = [];
  while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
  return Uint8Array.from(out);
}

const tag = (field: number, wire: number): Uint8Array => varint(BigInt((field << 3) | wire));
const lenField = (field: number, body: Uint8Array): Uint8Array => concat(tag(field, 2), varint(BigInt(body.length)), body);
const strField = (field: number, v: string): Uint8Array => lenField(field, encoder.encode(v));
const varintField = (field: number, v: bigint): Uint8Array => concat(tag(field, 0), varint(v));
const zigzag = (n: number): bigint => BigInt((n << 1) ^ (n >> 31));

function f64(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
}
const doubleField = (field: number, v: number): Uint8Array => concat(tag(field, 1), f64(v));
function fixed64Field(field: number, v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), true);
  return concat(tag(field, 1), b);
}

/** ExportMetricsServiceRequest holding one metric whose body is `metricBody`. */
function metricsRequest(metricBody: Uint8Array): Uint8Array {
  const metric = concat(strField(1, 'm'), metricBody);
  return lenField(1, lenField(2, lenField(2, metric)));
}

function firstMetric(decoded: Record<string, unknown>): Record<string, unknown> {
  const rm = (decoded['resourceMetrics'] as Array<Record<string, unknown>>)[0]!;
  const sm = (rm['scopeMetrics'] as Array<Record<string, unknown>>)[0]!;
  return (sm['metrics'] as Array<Record<string, unknown>>)[0]!;
}

function kv(key: string, value: string): Uint8Array {
  return concat(strField(1, key), lenField(2, strField(1, value)));
}

describe('OTLP protobuf metric decoding', () => {
  test('an exponential histogram point keeps its attributes, scale, buckets, min and max', () => {
    const buckets = concat(varintField(1, zigzag(-2)), lenField(2, concat(varint(3n), varint(5n))));
    const point = concat(
      lenField(1, kv('host', 'a')),
      varintField(3, 1700000000000000000n),
      fixed64Field(4, 8n),
      doubleField(5, 12.5),
      varintField(6, zigzag(-3)),
      fixed64Field(7, 1n),
      lenField(8, buckets),
      lenField(9, buckets),
      varintField(10, 1n),
      doubleField(12, 0.5),
      doubleField(13, 9.5),
    );
    const decoded = decodeOtlpProtobuf('metrics', metricsRequest(lenField(10, lenField(1, point))));
    const exp = firstMetric(decoded)['exponentialHistogram'] as { dataPoints: Array<Record<string, unknown>> };
    const dp = exp.dataPoints[0]!;
    expect(dp['attributes']).toEqual([{ key: 'host', value: { stringValue: 'a' } }]);
    expect(dp).toMatchObject({ count: 8, sum: 12.5, scale: -3, zeroCount: 1, flags: 1, min: 0.5, max: 9.5, timeUnixNano: '1700000000000000000' });
    expect(dp['positive']).toEqual({ offset: -2, bucketCounts: ['3', '5'] });
    expect(dp['negative']).toEqual({ offset: -2, bucketCounts: ['3', '5'] });
  });

  test('a summary point keeps its attributes, flags and quantile values', () => {
    const quantile = concat(doubleField(1, 0.99), doubleField(2, 42));
    const point = concat(
      varintField(3, 5n),
      fixed64Field(4, 4n),
      doubleField(5, 10),
      lenField(6, quantile),
      lenField(7, kv('svc', 'b')),
      varintField(8, 1n),
    );
    const decoded = decodeOtlpProtobuf('metrics', metricsRequest(lenField(11, lenField(1, point))));
    const summary = firstMetric(decoded)['summary'] as { dataPoints: Array<Record<string, unknown>> };
    const dp = summary.dataPoints[0]!;
    expect(dp['attributes']).toEqual([{ key: 'svc', value: { stringValue: 'b' } }]);
    expect(dp).toMatchObject({ count: 4, sum: 10, flags: 1, quantileValues: [{ quantile: 0.99, value: 42 }] });
  });

  test('negative int64 values decode as negative numbers', () => {
    const anyInt = varintField(3, -1n);
    const attr = concat(strField(1, 'n'), lenField(2, anyInt));
    const point = concat(fixed64Field(6, -7n), lenField(7, attr));
    const decoded = decodeOtlpProtobuf('metrics', metricsRequest(lenField(5, lenField(1, point))));
    const gauge = firstMetric(decoded)['gauge'] as { dataPoints: Array<Record<string, unknown>> };
    const dp = gauge.dataPoints[0]!;
    expect(dp['asInt']).toBe('-7');
    expect(dp['attributes']).toEqual([{ key: 'n', value: { intValue: '-1' } }]);
  });
});
