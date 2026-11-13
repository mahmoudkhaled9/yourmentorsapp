/**
 * TEST-ONLY stand-in for a `mysql2/promise` pool, backed by `node:sqlite` (Node >= 22.5).
 *
 * Why it exists: it lets the REAL Express app (all middleware, routes, migrations, seed) run end-to-end against the REAL
 * production column set without a MySQL server, so logic, authorisation, validation and concurrency can be tested
 * anywhere in seconds. It is NOT a MySQL emulator: no MySQL locking semantics, no strict-mode truncation errors, only
 * NOCASE collation, no time-zone conversion. `npm run test:mysql` runs the same suites against a real MySQL test database.
 *
 *  - One SQLite handle, one transaction at a time (async mutex). A query issued while another flow holds an open
 *    transaction waits (and fails after `lockTimeoutMs`, like a lock-wait timeout).
 *  - Result shapes follow mysql2: SELECT -> [rows, fields]; writes -> [ResultSetHeader, undefined].
 *  - DATE/TIMESTAMP columns are returned as JS Date (UTC), DECIMAL as fixed strings (like mysql2).
 *  - `latencyMs` adds a random per-statement delay so concurrent requests interleave like over a network.
 */
import { DatabaseSync } from 'node:sqlite';

const pad = (n) => String(n).padStart(2, '0');
const fmtUtc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const norm = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return fmtUtc(v);
  return v;
};

function mapError(err) {
  const msg = String(err?.message ?? err);
  const e = new Error(msg);
  Object.assign(e, { sqlMessage: msg, sqlState: '45000', code: 'ER_UNKNOWN', errno: 1105 });
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(msg)) Object.assign(e, { code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000', sqlMessage: `Duplicate entry (${msg})` });
  else if (/NOT NULL constraint failed/i.test(msg)) Object.assign(e, { code: 'ER_BAD_NULL_ERROR', errno: 1048, sqlState: '23000' });
  else if (/FOREIGN KEY constraint failed/i.test(msg)) Object.assign(e, { code: 'ER_NO_REFERENCED_ROW_2', errno: 1452, sqlState: '23000' });
  else if (/no such table/i.test(msg)) Object.assign(e, { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02' });
  else if (/no such column|has no column named/i.test(msg)) Object.assign(e, { code: 'ER_BAD_FIELD_ERROR', errno: 1054, sqlState: '42S22' });
  else if (/syntax error/i.test(msg)) Object.assign(e, { code: 'ER_PARSE_ERROR', errno: 1064, sqlState: '42000' });
  else if (/database is locked|SHIM_LOCK_TIMEOUT/i.test(msg)) Object.assign(e, { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205, sqlState: 'HY000' });
  return e;
}

class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  async acquire(timeoutMs) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const prev = this.tail;
    this.tail = prev.then(() => gate);
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('SHIM_LOCK_TIMEOUT: lock wait timeout exceeded')), timeoutMs); });
    try {
      await Promise.race([prev, timeout]);
    } catch (e) {
      prev.then(release); // never got the lock: pass it on once the previous holder finishes
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return release;
  }
}

/** Replaces ?? (identifier) and ? (value) placeholders; expands arrays like mysql2. Skips quoted text and comments. */
function bind(sql, params = []) {
  let out = '';
  const values = [];
  let pi = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') { j += 2; continue; }
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += sql.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '?') {
      if (sql[i + 1] === '?') { out += `\`${String(params[pi]).replace(/`/g, '``')}\``; pi += 1; i += 1; continue; }
      const v = params[pi]; pi += 1;
      if (Array.isArray(v)) { out += v.length ? v.map(() => '?').join(', ') : 'NULL'; values.push(...v.map(norm)); } else { out += '?'; values.push(norm(v)); }
      continue;
    }
    out += ch;
  }
  return { sql: out, values };
}

const parseUtc = (s) => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))) : null;
};

function convertValue(v, type) {
  if (v === null || v === undefined || !type) return v;
  const t = String(type).toLowerCase();
  if (t.startsWith('timestamp') || t.startsWith('datetime') || t === 'date') return typeof v === 'string' ? parseUtc(v) ?? v : v;
  if (t.startsWith('decimal')) {
    const m = t.match(/decimal\(\s*\d+\s*,\s*(\d+)\s*\)/);
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(m ? Number(m[1]) : 0) : v;
  }
  return v;
}

export function createSqlitePool({ file = ':memory:', schemaSql = '', lockTimeoutMs = 8000, databaseName = 'mentors_crm', latencyMs = 0 } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (schemaSql) db.exec(schemaSql);
  const mutex = new Mutex();
  const stats = { queries: 0 };
  const tableInfo = (t) => db.prepare(`PRAGMA table_info(\`${t}\`)`).all();
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const header = (changes = 0, insertId = 0) => ({ fieldCount: 0, affectedRows: changes, insertId, info: '', serverStatus: 2, warningStatus: 0, changedRows: changes });

  function introspect(sql) {
    if (/information_schema\.columns/i.test(sql)) {
      const rows = [];
      for (const name of tables()) for (const c of tableInfo(name)) rows.push({ tableName: name, columnName: c.name, dataType: String(c.type).toLowerCase().replace(/[\s(].*$/, '') || 'text' });
      return [rows, []];
    }
    if (/information_schema\.statistics/i.test(sql)) {
      const rows = [];
      for (const name of tables()) {
        rows.push({ tableName: name, indexName: 'PRIMARY' });
        for (const ix of db.prepare(`PRAGMA index_list(\`${name}\`)`).all()) rows.push({ tableName: name, indexName: ix.name });
      }
      return [rows, []];
    }
    if (/^\s*SELECT\s+(GET_LOCK|RELEASE_LOCK)\(/i.test(sql)) return [[{ l: 1 }], []];
    if (/^\s*SET\s+/i.test(sql)) return [header(), undefined];
    if (/^\s*ALTER\s+TABLE\s+`?\w+`?\s+MODIFY\b/i.test(sql)) return [header(), undefined];
    return null;
  }

  function translate(sql) {
    let s = sql.trim().replace(/;+\s*$/, '');
    s = s.replace(/\s+FOR\s+UPDATE\s*$/i, '').replace(/\s+LOCK\s+IN\s+SHARE\s+MODE\s*$/i, '');
    s = s.replace(/^\s*INSERT\s+IGNORE\s+INTO/i, 'INSERT OR IGNORE INTO');
    if (/^\s*CREATE\s+TABLE/i.test(s)) {
      s = s.replace(/\bINT(?:EGER)?\s+(?:NOT\s+NULL\s+)?(?:AUTO_INCREMENT\s+PRIMARY\s+KEY|PRIMARY\s+KEY\s+AUTO_INCREMENT)/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
      s = s.replace(/\bAUTO_INCREMENT\b/gi, '');
      s = s.replace(/,\s*UNIQUE\s+KEY\s+`?\w+`?\s*\(([^)]*)\)/gi, ', UNIQUE ($1)');
      s = s.replace(/,\s*(?:KEY|INDEX)\s+`?\w+`?\s*\([^)]*\)/gi, '');
      s = s.replace(/\)\s*ENGINE\s*=[^;]*$/i, ')');
      s = s.replace(/\b(VARCHAR\(\d+\)|TEXT|LONGTEXT)\b(?!\s+COLLATE)/gi, '$1 COLLATE NOCASE');
    }
    if (/^\s*ALTER\s+TABLE\s+`?\w+`?\s+ADD\s+COLUMN/i.test(s) && /NOT\s+NULL/i.test(s) && !/DEFAULT/i.test(s)) s += ' DEFAULT 0';
    if (/^\s*ALTER\s+TABLE\s+`?\w+`?\s+ADD\s+COLUMN/i.test(s)) s = s.replace(/\b(VARCHAR\(\d+\)|TEXT|LONGTEXT)\b(?!\s+COLLATE)/i, '$1 COLLATE NOCASE');
    return s;
  }

  function runStatement(rawSql, rawParams) {
    stats.queries += 1;
    const { sql: bound, values } = bind(rawSql, rawParams ?? []);
    try {
      const special = introspect(bound);
      if (special) return special;
      const sql = translate(bound);
      const stmt = db.prepare(sql);
      if (/^(SELECT|WITH|PRAGMA)\b/i.test(sql)) {
        const cols = stmt.columns();
        const rows = stmt.all(...values).map((row) => {
          const o = {};
          cols.forEach((c) => { o[c.name] = convertValue(row[c.name], c.type); });
          return o;
        });
        return [rows, cols.map((c) => ({ name: c.name }))];
      }
      const r = stmt.run(...values);
      return [header(Number(r.changes), Number(r.lastInsertRowid) || 0), undefined];
    } catch (e) {
      if (e?.code && String(e.code).startsWith('ER_')) throw e;
      const mapped = mapError(e);
      mapped.sql = rawSql;
      throw mapped;
    }
  }

  const toArgs = (a, b) => (typeof a === 'object' && a !== null ? [a.sql, a.values ?? b] : [a, b]);
  const delay = () => (latencyMs > 0 ? new Promise((r) => setTimeout(r, Math.random() * latencyMs)) : null);

  async function autocommit(a, b) {
    const [sql, params] = toArgs(a, b);
    await delay();
    const release = await mutex.acquire(lockTimeoutMs);
    try { return runStatement(sql, params); } finally { release(); }
  }

  class Connection {
    constructor() { this.releaseLock = null; }
    async query(a, b) {
      if (this.releaseLock) { const [sql, params] = toArgs(a, b); await delay(); return runStatement(sql, params); }
      return autocommit(a, b);
    }
    execute(a, b) { return this.query(a, b); }
    async beginTransaction() {
      if (this.releaseLock) throw new Error('transaction already open on this connection');
      this.releaseLock = await mutex.acquire(lockTimeoutMs);
      try { db.exec('BEGIN'); } catch (e) { this.releaseLock(); this.releaseLock = null; throw mapError(e); }
    }
    async commit() {
      if (!this.releaseLock) return;
      try { db.exec('COMMIT'); } finally { const r = this.releaseLock; this.releaseLock = null; r(); }
    }
    async rollback() {
      if (!this.releaseLock) return;
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ } finally { const r = this.releaseLock; this.releaseLock = null; r(); }
    }
    release() { if (this.releaseLock) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } const r = this.releaseLock; this.releaseLock = null; r(); } }
    destroy() { this.release(); }
  }

  return {
    stats, raw: db, query: autocommit, execute: autocommit,
    async getConnection() { return new Connection(); },
    on() { return this; },
    async end() { try { db.close(); } catch { /* already closed */ } },
    databaseName,
  };
}
