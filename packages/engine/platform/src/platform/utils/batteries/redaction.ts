import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment/decisions';

export const profileDistinctive = defineBattery({
  name: 'engine.redaction.profile-distinctive', version: 1, accuracyFloor: 0.95,
  description: 'Whether a declared closed-profile field role requires literal identifying-value containment. Raw profile values never enter the reading.',
  items: { identifying: yesNo('Does this declared profile field role carry identifying or private personal information whose exact local value should be masked in outgoing text? Addresses, personal contact information, private aliases, schedules and closed personal prose require containment regardless of value length. A general currency, measurement-unit, date-format, shipping-service-tier or communication-platform preference is an ordinary category and does not require corpus-wide masking of its value. Judge the complete declared role, not spelling, length or guessed value contents. Unknown role or validity must remain uncertain. The raw value is deliberately not supplied and must never be inferred or requested. This grants no disclosure of the profile field itself.', STAKES_BANDS.high.yesNo) },
  fixtures: [
    { name: 'short private address remains identifying', state: { field: 'commerce.shippingAddress', sourceKind: 'field' }, expect: { identifying: 'yes' } },
    { name: 'private alias remains identifying', state: { field: 'agent.privateAlias', sourceKind: 'field' }, expect: { identifying: 'yes' } },
    { name: 'currency is an ordinary preference', state: { field: 'commerce.currency', sourceKind: 'field' }, expect: { identifying: 'no' } },
    { name: 'measurement units are ordinary', state: { field: 'preferences.measurementUnits', sourceKind: 'field' }, expect: { identifying: 'no' } },
    { name: 'communication platform preference is ordinary', state: { field: 'preferences.communicationPlatform', sourceKind: 'field' }, expect: { identifying: 'no' } },
    { name: 'closed private prose remains protected', state: { field: 'closed private profile prose', sourceKind: 'prose' }, expect: { identifying: 'yes' } },
  ],
});
