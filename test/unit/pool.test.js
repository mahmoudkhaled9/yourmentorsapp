import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, readUploadedRow, requirementsText } from '../../src/domain/pool.js';

test('parseAmount reads the ways budgets are typed in spreadsheets', () => {
  assert.equal(parseAmount('5M'), 5000000);
  assert.equal(parseAmount('2.5 million'), 2500000);
  assert.equal(parseAmount('750k'), 750000);
  assert.equal(parseAmount('1,200,000 EGP'), 1200000);
  assert.equal(parseAmount('ask'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount({}), null);
});

test('readUploadedRow maps requirement headers and keeps every original column', () => {
  const r = readUploadedRow({ name: 'Mona', phone: '01012345678', fields: {
    'Budget Range': '3M - 6M', Location: 'Sheikh Zayed', 'Unit Type': 'Villa', 'Delivery Date': '2 years', Finishing: 'Core & Shell',
    Purpose: 'End user', DP: '10%', 'Quarterly Installment': '90k', Floor: 'Ground', Empty: '',
  } });
  assert.equal(r.destination, 'Sheikh Zayed');
  assert.equal(r.property_type, 'Villa');
  assert.deepEqual([r.budget_min, r.budget_max], [3000000, 6000000]);
  assert.equal(r.delivery, 'within_2_years');
  assert.equal(r.finishing, 'core_and_shell');
  assert.equal(r.purpose, 'end_user');
  assert.equal(r.down_payment, null, '"10%" is not an amount; it stays in the original columns');
  assert.equal(r.installment, 90000);
  const original = JSON.parse(r.original_json);
  assert.equal(original.DP, '10%');
  assert.equal(original.Floor, 'Ground');
  assert.ok(!('Empty' in original));
  assert.match(requirementsText(r), /Floor: Ground/);
});

test('unrecognised option text is kept as typed, never dropped', () => {
  const r = readUploadedRow({ phone: '01012345678', fields: { Delivery: 'after the summer', Finishing: 'luxury', Purpose: 'gift' } });
  assert.equal(r.delivery, 'after the summer');
  assert.equal(r.finishing, 'luxury');
  assert.equal(r.purpose, 'gift');
  assert.equal(r.name, 'Unknown');
  assert.equal(readUploadedRow({ phone: 'x', fields: ['not', 'an', 'object'] }).original_json, null);
});
