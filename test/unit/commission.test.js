import test from 'node:test';
import assert from 'node:assert/strict';
import { commissionFor, earnsCommission } from '../../src/domain/commission.js';

test('commission: 5,000 EGP for every 1,000,000 EGP of the deal value, for agents', () => {
  assert.equal(commissionFor(5_000_000, 'agent'), 25_000);
  assert.equal(commissionFor(10_000_000, 'agent'), 50_000);
  assert.equal(commissionFor(1_000_000, 'agent'), 5_000);
  assert.equal(commissionFor(5_200_000, 'agent'), 26_000);
  assert.equal(commissionFor(2_500_000, 'Agent'), 12_500);
  assert.equal(commissionFor(1_234_567, 'agent'), 6172.84, 'rounded to the piastre');
  for (const nothing of [0, -5, null, undefined, 'abc', NaN]) assert.equal(commissionFor(nothing, 'agent'), 0);
});

test('commission: only agents earn it', () => {
  for (const role of ['team_leader', 'sales_supervisor', 'sales_manager', 'director', 'franchise_owner', 'admin', 'Team Leader']) {
    assert.equal(commissionFor(5_000_000, role), 0, role);
    assert.equal(earnsCommission(role), false, role);
  }
  for (const missing of [undefined, null, '', '  ']) assert.equal(commissionFor(5_000_000, missing), 0, `no role (${missing})`);
});
