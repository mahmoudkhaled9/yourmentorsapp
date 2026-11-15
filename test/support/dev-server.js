/**
 * TEST / DEMO server: the real backend on the in-memory SQLite stand-in, pre-filled with a demo company.
 * Nothing is written to MySQL or to disk; everything disappears when the process stops.
 *
 *   node test/support/dev-server.js [--port 4011] [--demo]
 *
 * Used by the end-to-end tests in mentorsfront (they start it automatically) and to try the UI without MySQL.
 * Demo accounts (all use the password printed below) are created for every role.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createSqlitePool } from './mysql-sqlite.js';
import { loadConfig } from '../../src/config.js';
import { start } from '../../src/server.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg('port', process.env.PORT ?? 4011));
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Pass-2026';
export const DEMO_ACCOUNTS = {
  admin: 'admin@demo.test', franchise_owner: 'owner@demo.test', director: 'director@demo.test', sales_manager: 'manager@demo.test',
  team_leader: 'leader@demo.test', agent: 'agent@demo.test', agent2: 'agent2@demo.test', other_leader: 'leader2@demo.test', other_agent: 'agent3@demo.test',
};

const config = loadConfig({
  NODE_ENV: 'test', PORT: String(port), JWT_SECRET: crypto.randomBytes(32).toString('hex'), LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  INITIAL_ADMIN_EMAIL: DEMO_ACCOUNTS.admin, INITIAL_ADMIN_PASSWORD: DEMO_PASSWORD, INITIAL_ADMIN_NAME: 'Demo Admin', BCRYPT_ROUNDS: '6',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173',
  LOGIN_MAX_FAILURES: '50', API_MAX_PER_USER_PER_MIN: '100000', LOGIN_MAX_PER_IP_PER_MIN: '10000', API_MAX_PER_IP_PER_15MIN: '1000000',
});
const pool = createSqlitePool({ schemaSql: fs.readFileSync(new URL('./schema.sqlite.sql', import.meta.url), 'utf8') });
const { port: actual } = await start({ config, pool });
const base = `http://127.0.0.1:${actual}/api`;

async function call(method, path, body, token) {
  const res = await fetch(`${base}/${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

if (process.argv.includes('--demo')) {
  const admin = (await call('POST', 'auth/login', { email: DEMO_ACCOUNTS.admin, password: DEMO_PASSWORD })).token;
  const mk = async (key, name, role, parent) => (await call('POST', 'users', { name, email: DEMO_ACCOUNTS[key], phone: `010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, role, password: DEMO_PASSWORD, teamLeaderId: parent, title: role.replace('_', ' ') }, admin)).id;
  await mk('franchise_owner', 'Omar Owner', 'franchise_owner');
  const director = await mk('director', 'Dina Director', 'director');
  const manager = await mk('sales_manager', 'Sami Manager', 'sales_manager', director);
  const leader = await mk('team_leader', 'Tarek Leader', 'team_leader', manager);
  const agent = await mk('agent', 'Amira Agent', 'agent', leader);
  const agent2 = await mk('agent2', 'Karim Agent', 'agent', leader);
  const leader2 = await mk('other_leader', 'Laila Leader', 'team_leader');
  const agent3 = await mk('other_agent', 'Youssef Agent', 'agent', leader2);
  const opts = await call('GET', 'lead-options', null, admin);
  const names = ['Ahmed Hassan', 'Mona Adel', 'Khaled Samir', 'Nour Ali', 'Hany Fawzy', 'Salma Tarek', 'Mostafa Gamal', 'Yara Nabil', 'Omar Fathy', 'Heba Mahmoud', 'Tamer Said', 'Rania Ezz'];
  const owners = [agent, agent, agent, agent2, agent2, leader, agent3, agent3, agent, agent2, leader2, agent];
  for (const [i, name] of names.entries()) {
    const lead = await call('POST', 'leads', {
      name, phone: `011${String(20000000 + i * 137).padStart(8, '0')}`, statusId: (i % 8) + 1, projectId: (i % 10) + 1, source: ['Meta', 'Website', 'Referral'][i % 3], assignedToId: owners[i],
      requirements: { destinationIds: [opts.destinations[i % 6].id], propertyTypeIds: [opts.propertyTypes[i % 9].id], budgetMin: 2000000 + i * 250000, budgetMax: 4000000 + i * 500000, delivery: opts.delivery[i % 5].value, finishing: opts.finishing[i % 3].value, purpose: opts.purpose[i % 2].value },
    }, admin);
    await call('POST', 'comments', { entityType: 'lead', entityId: lead.id, content: `First call with ${name}: interested, send brochure.` }, admin).catch(() => {});
  }
  for (let i = 0; i < 6; i += 1) await call('POST', 'cold-calls', { name: `Cold Prospect ${i + 1}`, phone: `012${String(30000000 + i * 91).padStart(8, '0')}`, statusId: (i % 3) + 1, assignedToId: [agent, agent2, agent3][i % 3] }, admin);
  await call('POST', 'deals', { leadName: 'Ahmed Hassan', clientPhone: '01120000000', agentId: agent, projectId: 1, developerId: 1, amount: 5200000, commission: 104000, status: 'approved', stage: 'Contracted', contractDate: '2026-10-01' }, admin);
  await call('POST', 'deals', { leadName: 'Nour Ali', clientPhone: '01120000411', agentId: agent2, projectId: 3, developerId: 3, amount: 3100000, commission: 62000, status: 'pending', stage: 'Reservation' }, admin);
  await call('POST', 'brokers', { name: 'Cairo Brokers', phone: '01000001111', developerId: 1 }, admin);
}

console.log(`DEMO API ready on ${base}  (in-memory, test data only)`);
console.log(`accounts (password "${DEMO_PASSWORD}"): ${Object.entries(DEMO_ACCOUNTS).map(([k, v]) => `${k}=${v}`).join('  ')}`);
