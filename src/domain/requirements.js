import { badRequest } from '../http/errors.js';
import { nowSql } from '../lib/dates.js';
import { inClause } from './lookups.js';

/**
 * Client requirements of a lead.  Fixed choice lists live here (they drive business logic); the open-ended lists
 * (destinations, property types) are database tables managed from the admin panel.
 */
// Exactly the choices the business asked for, in this order (Delivery / Finishing / Purpose of purchase).
export const DELIVERY_OPTIONS = ['ready_to_move', 'within_1_year', 'within_2_years', 'within_3_years', 'within_4_years'];
export const FINISHING_OPTIONS = ['core_and_shell', 'semi_finished', 'fully_finished'];
export const PURPOSE_OPTIONS = ['end_user', 'investment'];
/**
 * Purposes offered before the list was reduced to End User / Investment. Existing leads keep them (never rewritten) and
 * they are shown as "(old option)"; they are no longer offered in forms and a call action cannot pick them.
 */
export const LEGACY_PURPOSES = ['personal_living', 'upgrading'];
export const STORED_PURPOSES = [...PURPOSE_OPTIONS, ...LEGACY_PURPOSES];
export const OPTION_LABELS = {
  ready_to_move: 'RTM', within_1_year: '1 Year', within_2_years: '2 Years', within_3_years: '3 Years', within_4_years: '4 Years',
  core_and_shell: 'Core & Shell', semi_finished: 'Semi-Finished', fully_finished: 'Fully Finished',
  end_user: 'End User', investment: 'Investment',
  personal_living: 'Personal Living (old option)', upgrading: 'Upgrading (old option)',
};
export const optionLabel = (value) => (value ? OPTION_LABELS[value] ?? value : null);

export const EMPTY_REQUIREMENTS = Object.freeze({
  destinationIds: [], propertyTypeIds: [], budgetMin: null, budgetMax: null, delivery: null,
  finishing: null, downPayment: null, installmentPerQuarter: null, purpose: null,
});

/** Validates `body.requirements` (undefined = not provided, null = clear). Returns undefined | null | object. */
export function parseRequirements(raw, v) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) { v.fail('requirements', 'must be an object'); return undefined; }
  const out = {
    destinationIds: raw.destinationIds === undefined ? [] : v.intList(raw.destinationIds, 'requirements.destinationIds', { min: 0, max: 20 }) ?? [],
    propertyTypeIds: raw.propertyTypeIds === undefined ? [] : v.intList(raw.propertyTypeIds, 'requirements.propertyTypeIds', { min: 0, max: 20 }) ?? [],
    budgetMin: v.money(raw.budgetMin, 'requirements.budgetMin', { max: 999999999999 }) ?? null,
    budgetMax: v.money(raw.budgetMax, 'requirements.budgetMax', { max: 999999999999 }) ?? null,
    delivery: v.oneOf(raw.delivery, 'requirements.delivery', DELIVERY_OPTIONS) ?? null,
    finishing: v.oneOf(raw.finishing, 'requirements.finishing', FINISHING_OPTIONS) ?? null,
    downPayment: v.money(raw.downPayment, 'requirements.downPayment', { max: 999999999999 }) ?? null,
    installmentPerQuarter: v.money(raw.installmentPerQuarter, 'requirements.installmentPerQuarter', { max: 999999999999 }) ?? null,
    // a lead that already holds an old purpose can be saved unchanged; new values must be End User / Investment
    purpose: v.oneOf(raw.purpose, 'requirements.purpose', STORED_PURPOSES) ?? null,
  };
  if (out.budgetMin !== null && out.budgetMax !== null && out.budgetMin > out.budgetMax) {
    v.fail('requirements.budgetMax', 'must be greater than or equal to the minimum budget');
  }
  if (out.downPayment !== null && out.budgetMax !== null && out.downPayment > out.budgetMax) {
    v.fail('requirements.downPayment', 'cannot be higher than the maximum budget');
  }
  return out;
}

const isEmpty = (r) => !r.destinationIds.length && !r.propertyTypeIds.length
  && [r.budgetMin, r.budgetMax, r.delivery, r.finishing, r.downPayment, r.installmentPerQuarter, r.purpose].every((x) => x === null);

/** Unknown ids are rejected; deactivated ones only when newly added (a lead keeps what it already had). */
async function checkOptions(tx, table, ids, alreadyLinked, label) {
  if (!ids.length) return;
  const q = inClause(ids);
  const rows = await tx.rows(`SELECT id, is_active FROM \`${table}\` WHERE id IN (${q.sql})`, q.params);
  const found = new Map(rows.map((r) => [Number(r.id), Number(r.is_active) === 1]));
  const unknown = ids.filter((id) => !found.has(id));
  if (unknown.length) throw badRequest(`Unknown ${label}: ${unknown.join(', ')}`, [{ field: `requirements.${label}`, message: 'does not exist' }]);
  const inactive = ids.filter((id) => !found.get(id) && !alreadyLinked.has(id));
  if (inactive.length) throw badRequest(`This ${label.replace(/s$/, '')} is no longer offered: ${inactive.join(', ')}`, [{ field: `requirements.${label}`, message: 'is deactivated' }]);
}

/** Replaces the requirements of one lead (inside the caller's transaction). */
export async function saveRequirements(tx, leadId, req) {
  const current = await loadRequirements(tx, [leadId]);
  const before = current.get(Number(leadId)) ?? EMPTY_REQUIREMENTS;
  if (req && LEGACY_PURPOSES.includes(req.purpose) && req.purpose !== before.purpose) {
    throw badRequest('Purpose of purchase must be End User or Investment', [{ field: 'requirements.purpose', message: 'must be End User or Investment' }]);
  }
  await tx.exec('DELETE FROM lead_requirement_destinations WHERE lead_id = ?', [leadId]);
  await tx.exec('DELETE FROM lead_requirement_property_types WHERE lead_id = ?', [leadId]);
  await tx.exec('DELETE FROM lead_requirements WHERE lead_id = ?', [leadId]);
  if (req === null || isEmpty(req)) return;
  await checkOptions(tx, 'destinations', req.destinationIds, new Set(before.destinationIds), 'destinations');
  await checkOptions(tx, 'property_types', req.propertyTypeIds, new Set(before.propertyTypeIds), 'propertyTypes');
  await tx.exec(
    `INSERT INTO lead_requirements (lead_id, budget_min, budget_max, delivery, finishing, down_payment, installment_quarterly, purpose, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [leadId, req.budgetMin, req.budgetMax, req.delivery, req.finishing, req.downPayment, req.installmentPerQuarter, req.purpose, nowSql()]
  );
  for (const id of req.destinationIds) await tx.exec('INSERT INTO lead_requirement_destinations (lead_id, destination_id) VALUES (?, ?)', [leadId, id]);
  for (const id of req.propertyTypeIds) await tx.exec('INSERT INTO lead_requirement_property_types (lead_id, property_type_id) VALUES (?, ?)', [leadId, id]);
}

export async function deleteRequirements(tx, leadIds) {
  if (!leadIds.length) return;
  const q = inClause(leadIds);
  await tx.exec(`DELETE FROM lead_requirement_destinations WHERE lead_id IN (${q.sql})`, q.params);
  await tx.exec(`DELETE FROM lead_requirement_property_types WHERE lead_id IN (${q.sql})`, q.params);
  await tx.exec(`DELETE FROM lead_requirements WHERE lead_id IN (${q.sql})`, q.params);
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Map(leadId -> requirements) for a batch of leads; 3 queries regardless of the batch size (chunked for huge lists). */
export async function loadRequirements(run, leadIds) {
  const out = new Map();
  for (let i = 0; i < leadIds.length; i += 1000) {
    const q = inClause(leadIds.slice(i, i + 1000));
    const [base, dest, types] = await Promise.all([
      run.rows(`SELECT * FROM lead_requirements WHERE lead_id IN (${q.sql})`, q.params),
      run.rows(`SELECT lead_id, destination_id FROM lead_requirement_destinations WHERE lead_id IN (${q.sql}) ORDER BY destination_id`, q.params),
      run.rows(`SELECT lead_id, property_type_id FROM lead_requirement_property_types WHERE lead_id IN (${q.sql}) ORDER BY property_type_id`, q.params),
    ]);
    const get = (id) => {
      const key = Number(id);
      if (!out.has(key)) out.set(key, { ...EMPTY_REQUIREMENTS, destinationIds: [], propertyTypeIds: [] });
      return out.get(key);
    };
    for (const r of base) {
      Object.assign(get(r.lead_id), {
        budgetMin: num(r.budget_min), budgetMax: num(r.budget_max), delivery: r.delivery ?? null, finishing: r.finishing ?? null,
        downPayment: num(r.down_payment), installmentPerQuarter: num(r.installment_quarterly), purpose: r.purpose ?? null,
      });
    }
    for (const r of dest) get(r.lead_id).destinationIds.push(Number(r.destination_id));
    for (const r of types) get(r.lead_id).propertyTypeIds.push(Number(r.property_type_id));
  }
  return out;
}

/**
 * Optional server-side filters for GET /api/leads (the UI also filters the loaded list in the browser).
 * Returns { sql, params } conditions to AND onto the WHERE clause.
 */
export function requirementFilters(query, v) {
  const conds = [];
  const params = [];
  const destinationId = v.int(query.destinationId, 'destinationId', { min: 1 });
  const propertyTypeId = v.int(query.propertyTypeId, 'propertyTypeId', { min: 1 });
  const purpose = v.oneOf(query.purpose, 'purpose', STORED_PURPOSES);
  const finishing = v.oneOf(query.finishing, 'finishing', FINISHING_OPTIONS);
  const delivery = v.oneOf(query.delivery, 'delivery', DELIVERY_OPTIONS);
  const budget = v.money(query.budget, 'budget', { max: 999999999999 });
  const q = v.string(query.q, 'q', { max: 100 });
  if (destinationId) { conds.push('EXISTS (SELECT 1 FROM lead_requirement_destinations d WHERE d.lead_id = leads.id AND d.destination_id = ?)'); params.push(destinationId); }
  if (propertyTypeId) { conds.push('EXISTS (SELECT 1 FROM lead_requirement_property_types t WHERE t.lead_id = leads.id AND t.property_type_id = ?)'); params.push(propertyTypeId); }
  for (const [col, val] of [['purpose', purpose], ['finishing', finishing], ['delivery', delivery]]) {
    if (val) { conds.push(`EXISTS (SELECT 1 FROM lead_requirements r WHERE r.lead_id = leads.id AND r.${col} = ?)`); params.push(val); }
  }
  if (budget !== undefined) {
    // the client's range contains the given amount (an open end counts as unlimited)
    conds.push('EXISTS (SELECT 1 FROM lead_requirements r WHERE r.lead_id = leads.id AND (r.budget_min IS NULL OR r.budget_min <= ?) AND (r.budget_max IS NULL OR r.budget_max >= ?) AND (r.budget_min IS NOT NULL OR r.budget_max IS NOT NULL))');
    params.push(budget, budget);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const digits = q.replace(/\D/g, '');
    conds.push(`(leads.name LIKE ?${digits.length >= 3 ? ' OR leads.phone LIKE ?' : ''})`);
    params.push(like);
    if (digits.length >= 3) params.push(`%${digits}%`);
  }
  return { sql: conds.length ? conds.join(' AND ') : '', params };
}
