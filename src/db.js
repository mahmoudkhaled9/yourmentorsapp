import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { readDbConfig } from './config.js';
import { isDeadlock, isDuplicateKey } from './http/errors.js';

dotenv.config();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * base);

/**
 * Real MySQL pool.
 *  - timezone 'Z' + session time_zone '+00:00': TIMESTAMP/DATE values are read and written as UTC, so dates no longer
 *    shift by the server's offset (Cairo is UTC+2/+3).
 *  - queueLimit: when the pool is saturated extra requests fail fast (HTTP 503) instead of piling up until the process dies.
 */
export function createMysqlPool(cfg) {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: 'utf8mb4',
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: cfg.poolSize,
    queueLimit: cfg.queueLimit,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    maxIdle: Math.min(cfg.poolSize, 10),
    idleTimeout: 60000,
    multipleStatements: false,
  });
  pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
    conn.query('SET SESSION innodb_lock_wait_timeout = 10');
  });
  return pool;
}

const wrapRunner = (runner) => ({
  query: (sql, params) => runner.query(sql, params),
  async rows(sql, params) { return (await runner.query(sql, params))[0]; },
  async one(sql, params) { const [rows] = await runner.query(sql, params); return rows[0] ?? null; },
  async exec(sql, params) { return (await runner.query(sql, params))[0]; },
});

/** Serialises id allocation per table inside this process (cross-process safety comes from row locks + retry). */
const tableLocks = new Map();
async function withTableLocks(tables, fn) {
  const names = [...new Set(tables)].sort();
  const releases = [];
  try {
    for (const name of names) {
      const prev = tableLocks.get(name) ?? Promise.resolve();
      let release;
      const gate = new Promise((r) => { release = r; });
      const tail = prev.then(() => gate);
      tableLocks.set(name, tail);
      await prev;
      releases.push(() => { release(); if (tableLocks.get(name) === tail) tableLocks.delete(name); });
    }
    return await fn();
  } finally {
    releases.forEach((r) => r());
  }
}

/** Wraps a mysql2 pool (or the test stand-in). `tx(fn, { tables })` runs fn in a transaction and retries on deadlock. */
export function createDb(pool) {
  const root = wrapRunner(pool);
  async function runTx(fn, { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn({ ...wrapRunner(conn), isTx: true });
        await conn.commit();
        return out;
      } catch (err) {
        try { await conn.rollback(); } catch { /* connection already gone */ }
        if (attempt < retries && isDeadlock(err)) { await sleep(jitter(15 * 2 ** attempt)); continue; }
        throw err;
      } finally {
        conn.release();
      }
    }
  }
  return {
    ...root,
    pool,
    tx: (fn, { tables = [], retries } = {}) => (tables.length ? withTableLocks(tables, () => runTx(fn, { retries })) : runTx(fn, { retries })),
    close: () => pool.end(),
  };
}

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE' || err?.errno === 1146;

/**
 * Next id for tables whose `id` is not AUTO_INCREMENT in production (leads, comments, deals, cold_calls, users ...).
 * Uses the id_sequences counter (migration 005) so an id is NEVER handed out twice, even after the newest row was deleted
 * (otherwise the old record's comments/reports would attach to the new one: there are no foreign keys in production).
 * The counter is also kept >= MAX(id)+1, so rows inserted by other tools can never collide with it.
 * `count` reserves a block of consecutive ids (bulk import). Must run inside a transaction.
 */
let sequencesAvailable = true;
export async function allocateId(run, table, count = 1) {
  if (sequencesAvailable) {
    try {
      await run.exec('INSERT IGNORE INTO id_sequences (table_name, next_id) VALUES (?, 1)', [table]);
      const seq = await run.one('SELECT next_id FROM id_sequences WHERE table_name = ? FOR UPDATE', [table]);
      const last = await run.one(`SELECT id FROM \`${table}\` ORDER BY id DESC LIMIT 1 FOR UPDATE`);
      const next = Math.max(Number(seq?.next_id ?? 1), (last ? Number(last.id) : 0) + 1);
      await run.exec('UPDATE id_sequences SET next_id = ? WHERE table_name = ?', [next + Math.max(1, count), table]);
      return next;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      sequencesAvailable = false;
    }
  }
  const last = await run.one(`SELECT id FROM \`${table}\` ORDER BY id DESC LIMIT 1 FOR UPDATE`);
  return (last ? Number(last.id) : 0) + 1;
}

/** INSERT a row with a freshly allocated id. `data` is { column: value } WITHOUT id. Retries on duplicate key / deadlock. */
export async function insertRow(run, table, data, { maxAttempts = 10 } = {}) {
  const columns = Object.keys(data);
  const sql = `INSERT INTO \`${table}\` (id, ${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`;
  const values = columns.map((c) => data[c]);
  for (let attempt = 1; ; attempt += 1) {
    const id = await allocateId(run, table);
    try {
      await run.exec(sql, [id, ...values]);
      return id;
    } catch (err) {
      if ((isDuplicateKey(err) || isDeadlock(err)) && attempt < maxAttempts && !/email/i.test(String(err?.message))) {
        await sleep(jitter(2 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// --- backwards compatibility: scripts/*.mjs do `import { pool } from '../src/db.js'` -------------------------------
let legacyPool;
export const pool = new Proxy({}, {
  get(_t, prop) {
    legacyPool ??= createMysqlPool(readDbConfig(process.env));
    const value = legacyPool[prop];
    return typeof value === 'function' ? value.bind(legacyPool) : value;
  },
});

export async function waitForDatabase(db, { retries = 15, delayMs = 2000, logger } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= retries || ['ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'].includes(err.code)) {
        if (err.code === 'ER_BAD_DB_ERROR') err.message = `Unknown database: check DB_NAME in .env (it must exist; create it with: CREATE DATABASE \`<name>\`). ${err.message}`;
        throw err;
      }
      logger?.warn(`database not reachable yet (${err.code ?? err.message}); retry ${attempt + 1}/${retries}`);
      await sleep(delayMs);
    }
  }
}
