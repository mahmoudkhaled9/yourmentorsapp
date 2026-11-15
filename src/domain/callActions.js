import { toIso } from '../lib/dates.js';
import { optionLabel } from './requirements.js';

/**
 * Call actions. Storage (no separate system, no duplicated editable data):
 *   call_history        one row per logged call: who, when, outcome, notes, follow-up
 *   leads / cold_calls  status = the call outcome (the CRM's admin-managed statuses are the outcomes)
 *   comments + reports  a readable summary, so the call shows in the history and in Reports
 *   calendar_events     the follow-up, when one is scheduled
 *
 * Delivery / Finishing / Purpose of purchase have ONE source of truth: the lead (lead_requirements), edited only through
 * Edit Lead. A call never edits them. call_history.delivery/finishing/purpose hold a read-only SNAPSHOT of the lead's
 * values at the moment of the call, filled by the server, so Call History shows what was on file when the agent called
 * even if the lead changes later. Clients cannot set or edit the snapshot.
 */
export const REQUIREMENT_FIELDS = ['delivery', 'finishing', 'purpose'];

/** Validates a call action. `create`: an outcome is required. */
export function parseCallInput(body, v, { create }) {
  for (const field of REQUIREMENT_FIELDS) {
    if (body[field] !== undefined) v.fail(field, 'is edited on the lead (Edit Lead), not in a call');
  }
  const out = {
    statusId: v.int(body.statusId ?? body.outcomeStatusId, 'statusId', { required: create, min: 1 }),
    notes: v.string(body.notes, 'notes', { max: 5000 }),
    followUpAt: v.datetime(body.followUpAt, 'followUpAt'),
    requestId: v.string(body.requestId, 'requestId', { max: 64 }),
  };
  if (out.requestId && !/^[A-Za-z0-9_-]{8,64}$/.test(out.requestId)) v.fail('requestId', 'must be 8-64 letters, digits, - or _');
  return out;
}

/** The text stored as a comment (lead history + Reports). */
export function callSummary(call) {
  const parts = [
    `Call logged - outcome: ${call.outcomeName}`,
    call.followUpAt ? `Follow-up: ${String(call.followUpAt).slice(0, 16)} UTC` : null,
  ].filter(Boolean);
  return `${parts.join(' | ')}${call.notes ? `\nNotes: ${call.notes}` : ''}`;
}

export const CALL_SELECT = `SELECT ch.*, u.name AS user_name, l.name AS lead_name, l.user_id AS lead_owner, l.phone AS lead_phone,
    c.name AS cold_name, c.user_id AS cold_owner, c.phone AS cold_phone
  FROM call_history ch
  LEFT JOIN users u ON u.id = ch.user_id
  LEFT JOIN leads l ON l.id = ch.lead_id
  LEFT JOIN cold_calls c ON c.id = ch.cold_call_id`;

/** Calls the caller may see: made by someone in their team, or about a lead / cold call owned by their team. */
export function callScopeSql(scope) {
  const a = scope.sqlIn('ch.user_id');
  const b = scope.sqlIn('l.user_id');
  const c = scope.sqlIn('c.user_id');
  return { sql: `(${a.sql} OR ${b.sql} OR ${c.sql})`, params: [...a.params, ...b.params, ...c.params] };
}

export function serializeCall(r) {
  const entityType = r.cold_call_id ? 'cold_call' : 'lead';
  return {
    id: r.id,
    entityType,
    leadId: r.lead_id ?? null,
    coldCallId: r.cold_call_id ?? null,
    entityName: (entityType === 'lead' ? r.lead_name : r.cold_name) ?? '(deleted)',
    entityPhone: (entityType === 'lead' ? r.lead_phone : r.cold_phone) ?? '',
    userId: r.user_id ?? null,
    userName: r.user_name ?? 'Unknown',
    // the outcome is the status chosen on the call; older rows only have the free-text `result`
    outcome: r.result ?? '',
    outcomeLabel: r.status_name || r.result || '',
    statusId: r.status_id ?? null,
    statusName: r.status_name ?? '',
    // read-only snapshot of the lead's requirements at call time (see above)
    delivery: r.delivery ?? null,
    deliveryLabel: optionLabel(r.delivery),
    finishing: r.finishing ?? null,
    finishingLabel: optionLabel(r.finishing),
    purpose: r.purpose ?? null,
    purposeLabel: optionLabel(r.purpose),
    notes: r.notes ?? '',
    callAt: toIso(r.call_at) || toIso(r.created_at),
    followUpAt: toIso(r.follow_up_at) || null,
    followUpEventId: r.follow_up_event_id ?? null,
    commentId: r.comment_id ?? null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    // fields of the older generic /api/call-history shape, kept for API compatibility
    result: r.result ?? '',
  };
}
