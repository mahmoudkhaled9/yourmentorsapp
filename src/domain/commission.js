import { normalizeRole } from '../auth/policy.js';

/**
 * Commission rule (business rule, owner-confirmed 2026-11-15):
 *   - 5,000 EGP for every 1,000,000 EGP of the deal value (0.5%): 5,000,000 -> 25,000; 10,000,000 -> 50,000;
 *   - only for deals sold by an AGENT. Deals assigned to a team leader, sales supervisor, sales manager, director,
 *     franchise owner or administrator carry no commission (0).
 *
 * The server is the only place it is calculated and stored (routes/deals.js), so the deal list, the "Total Commission"
 * cards and the dashboard (which add up the stored values) always follow the rule. The deal value is the contract
 * price, or the amount when there is no contract price. Rounded to the piastre (the column is DECIMAL(…, 2)).
 */
export const COMMISSION_PER_MILLION = 5000;
export const COMMISSION_ROLES = new Set(['agent']);

/** No role (no seller, unknown user) earns nothing: normalizeRole() would otherwise default a missing role to 'agent'. */
export const earnsCommission = (role) => typeof role === 'string' && role.trim() !== '' && COMMISSION_ROLES.has(normalizeRole(role));

export function commissionFor(dealValue, sellerRole) {
  if (!earnsCommission(sellerRole)) return 0;
  const value = Number(dealValue);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round((value * COMMISSION_PER_MILLION) / 1_000_000 * 100) / 100;
}
