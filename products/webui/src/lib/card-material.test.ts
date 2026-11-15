import { expect, test } from 'bun:test';
import { isDeclaredCardMaterialKey, isCardMaterialKey } from './card-material';
import { buildSettingsModel } from './settings-model';

test('declared card-entry fields are never listed', () => {
  const keys = ['payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName'];
  for (const key of keys) expect(isDeclaredCardMaterialKey(key)).toBe(true);
  const model = buildSettingsModel({ payments: { cardNumber: 'number fixture', cardExpiry: 'expiry fixture', cardCvv: 'code fixture', cardholderName: 'name fixture' } });
  const rows = model.flatMap(group => [...group.rawRows, ...group.plainRows]);
  expect(rows.some(row => keys.includes(row.key))).toBe(false);
});
test('an undeclared spelling is not card material by its name; it is listed with its value masked', () => {
  const keys = ['cvv', 'pan', 'rawPan', 'cardNumber', 'cardNum', 'companyName', 'japanRegion', 'panEnabled', 'cardExpiry', 'other.cardholderName'];
  for (const key of keys) expect(isCardMaterialKey(key)).toBe(false);
  const rows = buildSettingsModel(Object.fromEntries(keys.map(key => [key, 'fixture']))).flatMap(group => group.rawRows);
  expect(rows.map(row => row.key).sort()).toEqual([...keys].sort());
  expect(rows.every(row => row.isSecret)).toBe(true);
});
