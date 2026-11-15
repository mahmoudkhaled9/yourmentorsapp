// Brings stored deal commissions in line with the rule (src/domain/commission.js): 5,000 EGP per million of the deal
// value, for deals sold by an agent only.
//   node scripts/fix-deal-commissions.mjs            -> dry run: lists what would change, changes nothing
//   node scripts/fix-deal-commissions.mjs --apply    -> updates those rows (each update re-checks the old value)
// Uses the seller's role AS IT IS NOW: for old deals whose seller has since been promoted, review the dry run first.
// Take a backup first (npm run backup).
import { readDbConfig } from '../src/config.js';
import { createMysqlPool, createDb } from '../src/db.js'; // also loads .env
import { commissionFor } from '../src/domain/commission.js';

const apply = process.argv.includes('--apply');
const dbConfig = readDbConfig(process.env);
if (!dbConfig.user || !dbConfig.database) {
  console.error('DB_USER and DB_NAME must be set (in .env or the environment).');
  process.exit(1);
}
const pool = createMysqlPool(dbConfig);
const db = createDb(pool);
try {
  const cols = new Set((await db.rows('SHOW COLUMNS FROM deals')).map((c) => c.Field));
  const pick = (...names) => names.filter((n) => cols.has(n)).map((n) => `d.\`${n}\``);
  const coalesce = (...names) => { const p = pick(...names); return p.length ? `COALESCE(${p.join(', ')})` : 'NULL'; };
  const rows = await db.rows(`SELECT d.id, d.commission, ${coalesce('contractPrice', 'contract_price')} AS contract, ${coalesce('amount', 'price')} AS amount,
      u.role AS seller_role FROM deals d LEFT JOIN users u ON u.id = ${coalesce('user_id', 'agent_id', 'agentId')} ORDER BY d.id`);
  let planned = 0;
  let changed = 0;
  for (const r of rows) {
    const value = Number(r.contract) || Number(r.amount) || 0;
    const right = commissionFor(value, r.seller_role);
    const stored = Number(r.commission ?? 0);
    if (Math.abs(stored - right) < 0.005) continue;
    planned += 1;
    console.log(`${apply ? 'UPDATE' : 'would update'} deal #${r.id}: value ${value.toLocaleString()} sold by ${r.seller_role ?? 'nobody'}: commission ${stored.toLocaleString()} -> ${right.toLocaleString()}`);
    if (apply) {
      const res = await db.exec('UPDATE deals SET commission = ? WHERE id = ? AND commission = ?', [right, r.id, r.commission]);
      changed += Number(res.affectedRows ?? 0);
    }
  }
  console.log(apply ? `Done: ${changed} deal(s) updated.` : `Dry run: ${planned} of ${rows.length} deal(s) would change. Re-run with --apply to update them.`);
} finally {
  await db.close();
}
