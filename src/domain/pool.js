import { DELIVERY_OPTIONS, FINISHING_OPTIONS, PURPOSE_OPTIONS, optionLabel } from './requirements.js';
import { toIso } from '../lib/dates.js';

/**
 * Number Pool domain helpers: reading the requirement columns of an uploaded spreadsheet row, and the JSON shapes the
 * API returns. Nothing here decides visibility (that is the reporting tree, in routes/pool.js).
 */
export const BATCH_SIZES = [5, 10, 20];
/** What an agent can record after calling a number. `lead` / `cold_call` create that record, owned by the agent. */
export const OUTCOMES = {
  lead: 'Interested (lead created)',
  cold_call: 'Call back later (cold call created)',
  no_answer: 'No answer',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
};
export const OUTCOME_KEYS = Object.keys(OUTCOMES);

const clip = (v, max) => {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
};
const headerKey = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');

// Header spellings recognised for each requirement (after lower-casing and removing spaces / punctuation).
const FIELD_ALIASES = {
  destination: ['destination', 'destinations', 'location', 'area', 'city', 'region', 'zone', 'المنطقة', 'الموقع'],
  propertyType: ['propertytype', 'propertytypes', 'unittype', 'type', 'unit', 'نوعالوحدة'],
  budget: ['budget', 'price', 'budgetrange', 'الميزانية'],
  budgetMin: ['budgetmin', 'minbudget', 'minimumbudget', 'budgetfrom', 'pricefrom'],
  budgetMax: ['budgetmax', 'maxbudget', 'maximumbudget', 'budgetto', 'priceto'],
  delivery: ['delivery', 'deliverydate', 'handover', 'deliverytime', 'الاستلام'],
  finishing: ['finishing', 'finish', 'finishingtype', 'التشطيب'],
  purpose: ['purpose', 'purposeofpurchase', 'purchasepurpose', 'الغرض'],
  downPayment: ['downpayment', 'dp', 'deposit', 'downpaymentamount', 'المقدم'],
  installment: ['installment', 'installments', 'installmentperquarter', 'quarterlyinstallment', 'monthlyinstallment', 'القسط'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks', 'ملاحظات'],
};
const ALIAS_TO_FIELD = new Map(Object.entries(FIELD_ALIASES).flatMap(([field, list]) => list.map((a) => [a, field])));

/** "5M", "5,000,000", "2.5 million", "750k" -> number; anything else -> null. */
export function parseAmount(raw) {
  const text = clip(raw, 100).toLowerCase().replace(/,/g, '').replace(/egp|le|جنيه/g, '').trim();
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(m|mn|million|مليون|k|thousand|الف|ألف)?$/);
  if (!m) return null;
  const n = Number(m[1]) * (/^(m|mn|million|مليون)$/.test(m[2] ?? '') ? 1e6 : /^(k|thousand|الف|ألف)$/.test(m[2] ?? '') ? 1e3 : 1);
  return Number.isFinite(n) && n >= 0 && n <= 999999999999 ? Math.round(n * 100) / 100 : null;
}

/** "3M - 5M" -> { min, max }; "5M" -> { min: null, max }. */
function parseBudget(raw) {
  const parts = clip(raw, 100).split(/\s*(?:-|–|to|:|إلى|الى)\s*/i).filter(Boolean);
  if (parts.length === 2) {
    const [a, b] = parts.map(parseAmount);
    if (a !== null && b !== null) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const single = parseAmount(raw);
  return { min: null, max: single };
}

/** A recognised option code, or the uploaded text unchanged (never lost; shown as typed). */
function normalizeDelivery(raw) {
  const t = clip(raw, 100).toLowerCase();
  if (!t) return null;
  if (DELIVERY_OPTIONS.includes(t)) return t;
  if (/rtm|ready|immediate|فوري|استلام فوري/.test(t)) return 'ready_to_move';
  const years = t.match(/([1-4])\s*(?:year|years|yr|yrs|y|سنة|سنوات|سنين)/);
  return years ? `within_${years[1]}_year${years[1] === '1' ? '' : 's'}` : clip(raw, 100);
}
function normalizeFinishing(raw) {
  const t = clip(raw, 100).toLowerCase();
  if (!t) return null;
  if (FINISHING_OPTIONS.includes(t)) return t;
  if (/core|shell|طوب/.test(t)) return 'core_and_shell';
  if (/semi|نصف/.test(t)) return 'semi_finished';
  if (/fully|full|finished|كامل|متشطب/.test(t)) return 'fully_finished';
  return clip(raw, 100);
}
function normalizePurpose(raw) {
  const t = clip(raw, 100).toLowerCase();
  if (!t) return null;
  if (PURPOSE_OPTIONS.includes(t)) return t;
  if (/invest|استثمار/.test(t)) return 'investment';
  if (/end|user|living|resid|سكن/.test(t)) return 'end_user';
  return clip(raw, 100);
}

/**
 * Reads one uploaded row ({ name, phone, fields: { "<original header>": value } }) into pool_numbers columns.
 * Every original column is also kept verbatim in original_json, so nothing in the upload is lost even when a value
 * cannot be interpreted (for example a budget written as "ask").
 */
export function readUploadedRow(item) {
  const fields = item && typeof item.fields === 'object' && item.fields && !Array.isArray(item.fields) ? item.fields : {};
  const original = {};
  const found = {};
  for (const [header, value] of Object.entries(fields).slice(0, 60)) {
    const h = clip(header, 100);
    const v = clip(value, 1000);
    if (!h || !v) continue;
    original[h] = v;
    const field = ALIAS_TO_FIELD.get(headerKey(h));
    if (field && found[field] === undefined) found[field] = v;
  }
  const budget = found.budget ? parseBudget(found.budget) : { min: null, max: null };
  const budgetMin = found.budgetMin ? parseAmount(found.budgetMin) : budget.min;
  const budgetMax = found.budgetMax ? parseAmount(found.budgetMax) : budget.max;
  return {
    name: clip(item?.name, 255) || 'Unknown',
    notes: clip(item?.notes ?? found.notes, 5000) || null,
    destination: clip(found.destination, 500) || null,
    property_type: clip(found.propertyType, 500) || null,
    budget_min: budgetMin,
    budget_max: budgetMax,
    delivery: normalizeDelivery(found.delivery),
    finishing: normalizeFinishing(found.finishing),
    purpose: normalizePurpose(found.purpose),
    down_payment: found.downPayment ? parseAmount(found.downPayment) : null,
    installment: found.installment ? parseAmount(found.installment) : null,
    original_json: Object.keys(original).length ? JSON.stringify(original).slice(0, 20000) : null,
  };
}

const iso = (v) => (v ? toIso(v) : null);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const parseJson = (text) => {
  if (!text) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/** Full uploaded requirements of a number (only ever returned to its owner and the owner's managers). */
export function serializeRequirements(r) {
  return {
    destination: r.destination ?? null,
    propertyType: r.property_type ?? null,
    budgetMin: num(r.budget_min),
    budgetMax: num(r.budget_max),
    delivery: r.delivery ?? null,
    deliveryLabel: optionLabel(r.delivery),
    finishing: r.finishing ?? null,
    finishingLabel: optionLabel(r.finishing),
    purpose: r.purpose ?? null,
    purposeLabel: optionLabel(r.purpose),
    downPayment: num(r.down_payment),
    installment: num(r.installment),
    original: parseJson(r.original_json),
  };
}

export const itemState = (r) => (r.ended_at ? r.end_reason ?? 'processed' : 'open');

/** One allocation (pool_batch_items row joined with its number and owner). */
export function serializeItem(r) {
  return {
    id: Number(r.id),
    batchId: Number(r.batch_id),
    numberId: Number(r.pool_number_id),
    userId: Number(r.user_id),
    userName: r.user_name ?? null,
    allocatedAt: iso(r.allocated_at),
    endedAt: iso(r.ended_at),
    state: itemState(r),
    outcome: r.outcome ?? null,
    outcomeLabel: r.outcome ? OUTCOMES[r.outcome] ?? r.outcome : null,
    notes: r.notes ?? null,
    endedById: num(r.ended_by),
    endedByName: r.ended_by_name ?? null,
    leadId: num(r.lead_id),
    coldCallId: num(r.cold_call_id),
    name: r.number_name ?? r.name ?? null,
    phone: r.phone ?? null,
    numberNotes: r.number_notes ?? null,
    importId: num(r.import_id),
    requirements: serializeRequirements(r),
  };
}

export function serializeBatch(r) {
  const open = Number(r.open_count ?? 0);
  const processed = Number(r.processed_count ?? 0);
  const released = Number(r.released_count ?? 0);
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    userName: r.user_name ?? null,
    requestedById: Number(r.requested_by),
    sizeRequested: Number(r.size_requested),
    sizeAllocated: Number(r.size_allocated),
    status: r.status,
    createdAt: iso(r.created_at),
    completedAt: iso(r.completed_at),
    cancelledAt: iso(r.cancelled_at),
    cancelledById: num(r.cancelled_by),
    counts: { open, processed, released },
  };
}

/** Text appended to a lead / cold call created from a pool number, so every uploaded requirement travels with it. */
export function requirementsText(r) {
  const req = serializeRequirements(r);
  const money = (n) => (n === null ? null : Number(n).toLocaleString('en-US'));
  const parts = [
    ['Destination', req.destination],
    ['Property type', req.propertyType],
    ['Budget', req.budgetMin !== null || req.budgetMax !== null ? [money(req.budgetMin), money(req.budgetMax)].filter(Boolean).join(' - ') : null],
    ['Delivery', req.deliveryLabel],
    ['Finishing', req.finishingLabel],
    ['Purpose', req.purposeLabel],
    ['Down payment', money(req.downPayment)],
    ['Installment', money(req.installment)],
  ].filter(([, v]) => v);
  const known = new Set(Object.values(FIELD_ALIASES).flat());
  for (const [h, v] of Object.entries(req.original)) {
    if (!known.has(headerKey(h)) && !/^(name|phone|mobile|.*name|.*phone.*|.*mobile.*)$/i.test(headerKey(h))) parts.push([h, v]);
  }
  return parts.length ? `Number Pool requirements: ${parts.map(([k, v]) => `${k}: ${v}`).join('; ')}` : '';
}
