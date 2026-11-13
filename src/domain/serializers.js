import { toDateOnly, toIso } from '../lib/dates.js';

export const DEFAULT_USER_IMAGE = 'https://www.pngitem.com/pimgs/m/35-350426_profile-icon-png-default-profile-picture-png-transparent.png';

const isPotentialName = (name) => {
  const n = String(name ?? '').toLowerCase();
  return n.includes('potential') && !n.includes('non');
};

export const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const serializeUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone ?? '',
  role: row.role ?? 'agent',
  title: row.title ?? undefined,
  department: row.department ?? undefined,
  departmentId: row.department_id ?? undefined,
  jobtitleId: row.jobtitle_id ?? undefined,
  teamLeaderId: row.parent_id ?? undefined,
  avatar: row.image ?? undefined,
  isActive: Number(row.status ?? 1) === 1,
  createdAt: toIso(row.created_at),
});

const teamLeaderOf = (row) => ({
  teamLeader: row.user_role === 'team_leader' ? row.user_name ?? undefined : row.team_leader_name ?? undefined,
  teamLeaderId: row.user_role === 'team_leader' ? row.user_id ?? undefined : row.parent_id ?? undefined,
});

export const serializeLead = (row) => ({
  id: row.id,
  type: 'Lead',
  name: row.name,
  phone: row.phone,
  whatsapp: row.whatsapp || undefined,
  workPhone: row.workphone || row.workPhone || undefined,
  email: row.email || undefined,
  status: row.status_name ?? '',
  statusId: row.eff_status_id ?? 0,
  source: row.source_name ?? undefined,
  sourceId: row.eff_source_id ?? undefined,
  project: row.project_name ?? undefined,
  projectId: row.eff_project_id ?? undefined,
  assignedTo: row.user_name ?? undefined,
  assignedToId: row.user_id ?? undefined,
  ...teamLeaderOf(row),
  date: toDateOnly(row.date) || toDateOnly(row.created_at),
  isPotential: isPotentialName(row.status_name),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

export const serializeColdCall = (row) => ({
  id: row.id,
  type: 'Coldcall',
  name: row.name,
  phone: row.phone,
  notes: row.notes ?? undefined,
  status: row.status_name ?? '',
  statusId: row.status_id ?? 0,
  assignedTo: row.user_name ?? undefined,
  assignedToId: row.user_id ?? undefined,
  ...teamLeaderOf(row),
  date: toDateOnly(row.created_at),
  isPotential: isPotentialName(row.status_name),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

export const serializeComment = (row) => {
  const entityId = row.entity_id ?? row.lead_id ?? row.cold_call_id ?? row.leadId;
  return {
    id: row.id,
    leadId: entityId,
    entityType: row.entity_type ?? (row.cold_call_id ? 'cold_call' : 'lead'),
    entityId,
    content: row.body ?? row.content ?? '',
    createdBy: row.user_name ?? row.createdBy ?? 'Unknown',
    createdById: row.user_id ?? row.createdById,
    createdAt: toIso(row.created_at) || toIso(row.createdAt),
  };
};

export const serializeReport = (row) => ({
  id: row.id,
  commentId: row.comment_id ?? row.id,
  leadId: row.lead_id ?? null,
  coldCallId: row.cold_call_id ?? null,
  entityType: row.entity_type ?? 'lead',
  entityId: row.entity_id ?? null,
  clientName: row.client_name ?? 'Unknown',
  clientPhone: row.client_phone ?? '',
  agentId: row.agent_id ?? null,
  agentName: row.agent_name ?? '',
  teamLeaderId: row.team_leader_id ?? null,
  teamLeaderName: row.team_leader_name ?? '',
  statusId: row.status_id ?? null,
  statusName: row.status_name ?? '',
  projectId: row.project_id ?? null,
  projectName: row.project_name ?? '',
  developerId: row.developer_id ?? null,
  developerName: row.developer_name ?? '',
  content: row.content ?? '',
  createdBy: row.created_by ?? '',
  createdById: row.created_by_id ?? null,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

export const serializeDeal = (row) => ({
  id: row.id,
  leadId: row.leadId ?? row.lead_id ?? row.id,
  leadName: row.leadName ?? row.lead_name ?? row.name ?? '',
  clientPhone: row.clientPhone ?? row.client_phone ?? row.phone ?? '',
  agentId: row.user_id ?? row.agentId ?? row.agent_id ?? 0,
  agentName: row.user_name ?? row.agentName ?? row.agent_name ?? '',
  projectId: row.project_id ?? row.projectId ?? 0,
  projectName: row.project_name ?? row.projectName ?? '',
  developerId: row.developer_id ?? row.developerId ?? 0,
  developerName: row.developer_name ?? row.developerName ?? '',
  brokerId: row.broker_id ?? row.brokerId ?? undefined,
  amount: Number(row.amount ?? row.price ?? row.contractPrice ?? 0),
  commission: Number(row.commission ?? 0),
  status: row.status ?? 'pending',
  stage: row.stage ?? undefined,
  reservationPrice: row.reservation_price ?? row.reservationPrice ?? undefined,
  reservationDate: toDateOnly(row.reservation_date ?? row.reservationDate) || undefined,
  contractPrice: row.contractPrice ?? row.price ?? undefined,
  contractDate: toDateOnly(row.contract_date ?? row.contractDate) || undefined,
  unitNumber: row.unit_number ?? row.unitNumber ?? undefined,
  createdAt: toIso(row.created_at ?? row.createdAt),
  date: toDateOnly(row.date) || toDateOnly(row.contract_date) || toDateOnly(row.created_at),
  notes: row.notes ?? row.comment ?? undefined,
  attachments: parseJsonArray(row.attachments),
  reservationImages: parseJsonArray(row.reservations_images),
});

export const serializeDeveloper = (row) => ({
  id: row.id,
  name: row.name,
  logo: row.logo ?? '',
  description: row.description ?? '',
  phone: row.phone ?? '',
  whatsapp: row.whatsapp ?? '',
  email: row.email ?? '',
  website: row.website ?? '',
  lastUpdated: toDateOnly(row.updated_at),
});
