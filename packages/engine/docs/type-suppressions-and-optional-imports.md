# Type suppressions and optional host imports

Status: source audit for v3 development on 2026-11-05. These exceptions remain
intentional; integrated release qualification is pending.

## Type directives

The first-party TypeScript tree has 166 `@ts-expect-error` directives: 159 in test
files and seven deliberate negative contracts in source. These directives require
an error to exist; removing the relevant type restriction makes the directive
itself fail compilation. They must not be replaced with `@ts-ignore`.

| Location | Reason |
| --- | --- |
| `sdk/src/platform/email/inbound-notice.ts` (four guards) | Raw strings, sender timestamps and claimed link hosts must not satisfy host-validated receipt timestamp/domain brands. |
| `sdk/src/platform/security/card-shapes.ts` (three guards) | Findings must not acquire `value`, `text` or `digits` fields that retain matched sensitive characters. |
| Test files (159 guards) | Exercise rejected API shapes, authority boundaries and other negative type contracts. Each exception belongs to the adjacent test assertion. |
| `products/agent/src/test/helpers/preload.ts` (one `@ts-ignore`) | Compatibility assignment of Bun's fetch builtin when a test environment omits global fetch; some type bundles omit that builtin. It has an inline reason. |
| `sdk/src/platform/pairing/vendor/qrcodegen.ts` (one `@ts-nocheck`) | Vendored Nayuki QR generator, retaining upstream source and attribution. `pairing/qr-generator.ts` supplies the typed wrapper. |

The counts exclude generated/build/dependency directories and include actual
line-comment directives, rather than mentions in documentation. Before removing
one, inspect its adjacent assertion and verify that the same negative contract is
still checked. New exceptions need a concrete inline reason. This inventory is a
review aid, not a new annual gate or a justification for weakening strict types.

## Optional imports and Content Security Policy

Three runtime shims use an indirect `Function(... import ...)` so bundlers do not
resolve an optional host dependency. None evaluates user-supplied source.

| Shim | Runtime boundary and failure behavior |
| --- | --- |
| `transport-core/src/otel.ts` | Optional `@opentelemetry/api` probe skips browser windows and worker globals before the shim. Absence leaves propagation helpers inactive; an embedding may provide the documented API override. |
| `errors/src/regex-admission.ts` | Browser isolation uses a dedicated Blob worker. The `node:worker_threads` import runs only after the browser/worker guard. If isolation cannot be acquired, admission fails; it never runs an untrusted expression synchronously as a fallback. |
| `sdk/src/platform/tools/read/media.ts` | Optional host `sharp` loading returns `null` in browser/worker globals before the shim, or when loading fails. Image resizing/conversion remains unavailable in that case. |

The Function constructor requires dynamic-code permission and is incompatible
with strict `script-src 'self'` if executed in a browser. Keep the guards and
browser entry-point boundaries. Browser regex isolation additionally needs a
permitted worker source for its Blob worker; a blocked worker fails closed.
Do not add `unsafe-eval` to the WebUI policy to accommodate host-only code.
