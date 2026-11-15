/**
 * The demo company used by the browser tests (in-memory) and by `npm run seed:dev` (local MySQL).
 *
 * Everything is created THROUGH THE API, so validation, id sequences, hierarchy rules, requirements and reports apply
 * exactly as for real users. It is idempotent and dependency-aware:
 *   - users are matched by e-mail, leads / cold calls by phone, brokers by name, deals by client phone - an existing
 *     record is never changed or duplicated, so running it twice is a no-op;
 *   - statuses, projects (only those whose developer exists), destinations, property types and requirement options
 *     are looked up from the API instead of assuming ids, so it cannot create an orphan reference.
 *
 * `call(method, path, body)` performs an authenticated API request as an administrator and returns the parsed body
 * (throwing on errors). Returns a summary of what was created.
 */
export const DEMO_ACCOUNTS = {
  admin: 'admin@demo.test', franchise_owner: 'owner@demo.test', director: 'director@demo.test', sales_manager: 'manager@demo.test',
  sales_supervisor: 'supervisor@demo.test', team_leader: 'leader@demo.test', agent: 'agent@demo.test', agent2: 'agent2@demo.test',
  other_leader: 'leader2@demo.test', other_agent: 'agent3@demo.test',
};

const LEAD_NAMES = ['Ahmed Hassan', 'Mona Adel', 'Khaled Samir', 'Nour Ali', 'Hany Fawzy', 'Salma Tarek', 'Mostafa Gamal', 'Yara Nabil', 'Omar Fathy', 'Heba Mahmoud', 'Tamer Said', 'Rania Ezz'];
const leadPhone = (i) => `011${String(20000000 + i * 137).padStart(8, '0')}`;
const coldPhone = (i) => `012${String(30000000 + i * 91).padStart(8, '0')}`;
const userPhone = (i) => `010${String(40000000 + i * 53).padStart(8, '0')}`;

export async function seedDemoCompany(call, { password, includeAdmin = false } = {}) {
  if (!password) throw new Error('a password for the demo accounts is required');
  const created = { users: 0, leads: 0, coldCalls: 0, deals: 0, brokers: 0, calls: 0 };

  // ---- users (top-down, so every manager exists before the people reporting to them) --------------------------
  const usersByEmail = new Map((await call('GET', 'users')).map((u) => [String(u.email).toLowerCase(), u]));
  const user = async (key, name, role, parentId) => {
    const email = DEMO_ACCOUNTS[key];
    const existing = usersByEmail.get(email);
    if (existing) return Number(existing.id);
    const body = await call('POST', 'users', { name, email, phone: userPhone(Object.keys(DEMO_ACCOUNTS).indexOf(key)), role, password, teamLeaderId: parentId, title: role.replace(/_/g, ' ') });
    created.users += 1;
    usersByEmail.set(email, { id: body.id, email });
    return Number(body.id);
  };
  if (includeAdmin) await user('admin', 'Demo Admin', 'admin');
  await user('franchise_owner', 'Omar Owner', 'franchise_owner');
  const director = await user('director', 'Dina Director', 'director');
  const manager = await user('sales_manager', 'Sami Manager', 'sales_manager', director);
  const supervisor = await user('sales_supervisor', 'Sara Supervisor', 'sales_supervisor', manager);
  const leader = await user('team_leader', 'Tarek Leader', 'team_leader', supervisor);
  const agent = await user('agent', 'Amira Agent', 'agent', leader);
  const agent2 = await user('agent2', 'Karim Agent', 'agent', leader);
  const leader2 = await user('other_leader', 'Laila Leader', 'team_leader');
  const agent3 = await user('other_agent', 'Youssef Agent', 'agent', leader2);

  // ---- reference data that already exists (never assumed by id) ------------------------------------------------
  const statuses = await call('GET', 'statuses');
  const developers = new Set((await call('GET', 'developers')).map((d) => Number(d.id)));
  const projects = (await call('GET', 'projects')).filter((p) => developers.has(Number(p.developerId ?? p.developer_id)));
  const opts = await call('GET', 'lead-options');
  if (!statuses.length) throw new Error('no statuses: start the server once so the base data is seeded');
  const pick = (list, i) => (list.length ? list[i % list.length] : undefined);

  // ---- leads with requirements ---------------------------------------------------------------------------------
  const leadsByPhone = new Map((await call('GET', 'leads')).map((l) => [l.phone, l]));
  const owners = [agent, agent, agent, agent2, agent2, leader, agent3, agent3, agent, agent2, leader2, agent];
  const newLeads = [];
  for (const [i, name] of LEAD_NAMES.entries()) {
    if (leadsByPhone.has(leadPhone(i))) continue;
    const project = pick(projects, i);
    const lead = await call('POST', 'leads', {
      name, phone: leadPhone(i), statusId: Number(pick(statuses, i).id), projectId: project ? Number(project.id) : undefined,
      source: ['Meta', 'Website', 'Referral'][i % 3], assignedToId: owners[i],
      requirements: {
        destinationIds: opts.destinations.length ? [Number(pick(opts.destinations, i).id)] : [],
        propertyTypeIds: opts.propertyTypes.length ? [Number(pick(opts.propertyTypes, i).id)] : [],
        budgetMin: 2000000 + i * 250000, budgetMax: 4000000 + i * 500000,
        delivery: pick(opts.delivery, i)?.value, finishing: pick(opts.finishing, i)?.value, purpose: pick(opts.purpose, i)?.value,
      },
    });
    created.leads += 1;
    newLeads.push({ id: Number(lead.id ?? lead.item?.id), name, i });
    await call('POST', 'comments', { entityType: 'lead', entityId: Number(lead.id ?? lead.item?.id), content: `First call with ${name}: interested, send brochure.` });
  }
  // one logged call with a follow-up on the first new lead (call history, calendar event, report)
  if (newLeads.length) {
    const first = newLeads[0];
    const followUp = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    await call('POST', `leads/${first.id}/call-actions`, { statusId: Number(pick(statuses, 1).id), notes: `Called ${first.name}; wants a site visit.`, followUpAt: `${followUp}T10:00:00Z`, requestId: `seed-call-lead-${first.id}` });
    created.calls += 1;
  }

  // ---- cold calls ------------------------------------------------------------------------------------------------
  const coldByPhone = new Map((await call('GET', 'cold-calls')).map((c) => [c.phone, c]));
  for (let i = 0; i < 6; i += 1) {
    if (coldByPhone.has(coldPhone(i))) continue;
    await call('POST', 'cold-calls', { name: `Cold Prospect ${i + 1}`, phone: coldPhone(i), statusId: Number(pick(statuses, i).id), assignedToId: [agent, agent2, agent3][i % 3] });
    created.coldCalls += 1;
  }

  // ---- deals and a broker (only against projects / developers that exist) -----------------------------------------
  const dealPhones = new Set((await call('GET', 'deals')).map((d) => d.clientPhone));
  const dealProject = (i) => pick(projects, i);
  const deals = [
    { leadName: LEAD_NAMES[0], clientPhone: leadPhone(0), agentId: agent, amount: 5200000, commission: 104000, status: 'approved', stage: 'Contracted', contractDate: '2026-10-01', p: 0 },
    { leadName: LEAD_NAMES[3], clientPhone: leadPhone(3), agentId: agent2, amount: 3100000, commission: 62000, status: 'pending', stage: 'Reservation', p: 2 },
  ];
  for (const { p, ...deal } of deals) {
    if (dealPhones.has(deal.clientPhone)) continue;
    const project = dealProject(p);
    await call('POST', 'deals', { ...deal, projectId: project ? Number(project.id) : undefined, developerId: project ? Number(project.developerId ?? project.developer_id) : undefined });
    created.deals += 1;
  }
  const brokers = await call('GET', 'brokers');
  const firstDeveloper = [...developers][0];
  if (!brokers.some((b) => b.name === 'Cairo Brokers')) {
    await call('POST', 'brokers', { name: 'Cairo Brokers', phone: '01000001111', developerId: firstDeveloper });
    created.brokers += 1;
  }
  return created;
}
