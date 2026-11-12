import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pool } from './db.js';

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '25mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

app.use('/api', apiLimiter);
app.use('/api/auth/login', loginLimiter);

const toBool = (value) => (value ? 1 : 0);
const nowTs = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const defaultUserImage = 'https://www.pngitem.com/pimgs/m/35-350426_profile-icon-png-default-profile-picture-png-transparent.png';
const rawJwtSecret = String(process.env.JWT_SECRET ?? '').trim();
const INSECURE_JWT_SECRET_VALUES = new Set([
  'replace_me_in_production',
  'dev-local-secret-change-me',
  'changeme',
  'change_me',
  'secret',
  'default-secret',
]);
const JWT_SECRET = rawJwtSecret;

if (!JWT_SECRET || INSECURE_JWT_SECRET_VALUES.has(rawJwtSecret.toLowerCase())) {
  throw new Error('JWT_SECRET must be configured to a non-empty, non-placeholder value before starting the server.');
}

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const SUPER_ROLES = new Set(['admin', 'franchise_owner']);
const AUTH_PUBLIC_ROUTES = new Set(['/health', '/api/auth/login']);

const normalizeRole = (value) => String(value ?? 'agent').toLowerCase();
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
const sanitizeText = (value, { maxLength = 255, allowEmpty = false } = {}) => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const trimmed = text.trim();
  if (!trimmed && allowEmpty) return '';
  if (!trimmed) return '';
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};
const ensurePositiveInteger = (value, label = 'id') => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
};
const validateRouteId = (value, label = 'id') => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw Object.assign(new Error(`${label} must be a positive integer`), { name: 'ValidationError' });
  }
  return parsed;
};
const toSqlDateTime = (value, fallback = nowTs()) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return `${trimmed} 00:00:00`;
    }
    const normalized = trimmed.replace('T', ' ').replace('Z', '');
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(normalized)) {
      return normalized.slice(0, 19);
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 19).replace('T', ' ');
    }
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 19).replace('T', ' ');
  }
  return fallback;
};
const toSqlDateOnly = (value, fallback = null) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return fallback;
};
const toClientDateTime = (value) => {
  if (!value) return '';
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};
const toClientDateOnly = (value) => {
  const iso = toClientDateTime(value);
  return iso ? iso.slice(0, 10) : '';
};
const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const buildInClause = (values) => {
  if (!Array.isArray(values) || values.length === 0) {
    return '()';
  }
  return `(${Array(values.length).fill('?').join(', ')})`;
};
const issueToken = (userId, role) =>
  jwt.sign({ sub: Number(userId), role: normalizeRole(role) }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
const selectUserColumns = `
  id, name, email, phone, password, role, title, department, department_id, jobtitle_id,
  parent_id, status, image, created_at, updated_at
`;
const serializeUser = (row) => ({
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
  isActive: Number(row.status ?? row.isActive ?? 0) === 1,
  createdAt: toClientDateTime(row.created_at),
});
const hasEmailConflict = async (email, ignoreId = null) => {
  const normalized = normalizeEmail(email);
  if (!normalized || !isValidEmail(normalized)) {
    return false;
  }
  const [rows] = await pool.query(
    ignoreId ? 'SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1' : 'SELECT id FROM users WHERE email = ? LIMIT 1',
    ignoreId ? [normalized, ignoreId] : [normalized]
  );
  return rows.length > 0;
};
const verifyPassword = async (plainPassword, storedPassword) => {
  const plain = String(plainPassword ?? '');
  const stored = String(storedPassword ?? '');
  if (!stored) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    return bcrypt.compare(plain, stored);
  }
  return plain === stored;
};
const isAdmin = (user) => Boolean(user && (SUPER_ROLES.has(normalizeRole(user.role)) || normalizeRole(user.role) === 'admin'));
const isAuthenticatedUser = (req, userId) => Number(req.user?.id) === Number(userId);

const requireAuth = (req, res, next) => {
  const publicPath = AUTH_PUBLIC_ROUTES.has(req.path);
  if (publicPath) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.sub,
      role: normalizeRole(payload.role),
      email: payload.email,
      name: payload.name,
    };
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const ensureTableExists = async (tableName) => {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [tableName]);
  return rows.length > 0;
};

const getNextId = async (tableName) => {
  const [rows] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM \`${tableName}\``);
  return Number(rows[0]?.next_id ?? 1);
};

const mapBoolean = (value) => (value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0);

const normalizeLeadBody = (body = {}) => {
  const payload = { ...body };
  if (payload.content !== undefined && payload.body === undefined) {
    payload.body = payload.content;
  }
  if (payload.comment !== undefined && payload.notes === undefined) {
    payload.notes = payload.comment;
  }
  return payload;
};

const normalizeEntityPayload = (payload = {}, fields) => {
  const next = {};
  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined) return;
    next[key] = value;
  });
  Object.entries(payload).forEach(([key, value]) => {
    if (fields[key] !== undefined && value !== undefined) {
      next[key] = value;
    }
  });
  return next;
};

const normalizeDealPayload = (payload = {}) => {
  const rows = payload || {};
  return {
    id: rows.id ?? undefined,
    name: rows.name ?? rows.leadName ?? '',
    phone: rows.phone ?? rows.clientPhone ?? '',
    project_id: rows.projectId ?? rows.project_id ?? null,
    developer_id: rows.developerId ?? rows.developer_id ?? null,
    broker_id: rows.brokerId ?? rows.broker_id ?? null,
    attachments: rows.attachments === undefined ? null : JSON.stringify(rows.attachments ?? []),
    reservations_images: rows.reservationImages === undefined ? null : JSON.stringify(rows.reservationImages ?? []),
    reservation_price: rows.reservationPrice ?? rows.reservation_price ?? null,
    reservation_date: rows.reservationDate ? toSqlDateOnly(rows.reservationDate) : (rows.reservation_date ? toSqlDateOnly(rows.reservation_date) : null),
    price: rows.price ?? rows.contractPrice ?? rows.amount ?? 0,
    contract_date: rows.contractDate ? toSqlDateOnly(rows.contractDate) : (rows.contract_date ? toSqlDateOnly(rows.contract_date) : null),
    unit_number: rows.unitNumber ?? rows.unit_number ?? '',
    commission: rows.commission ?? 0,
    stage: rows.stage ?? '',
    comment: rows.comment ?? '',
    status: rows.status ?? 'pending',
    user_id: rows.userId ?? rows.agentId ?? rows.assignedToId ?? null,
    created_at: rows.createdAt ? toSqlDateTime(rows.createdAt) : nowTs(),
    updated_at: nowTs(),
  };
};

const normalizeUsersPayload = (payload = {}) => {
  const row = { ...payload };
  const name = sanitizeText(row.name, { maxLength: 255 });
  const email = normalizeEmail(row.email);
  const password = row.password ?? '';
  return {
    name,
    email,
    phone: sanitizeText(row.phone ?? '', { maxLength: 50, allowEmpty: true }),
    password,
    role: normalizeRole(row.role || 'agent'),
    title: sanitizeText(row.title ?? '', { maxLength: 255, allowEmpty: true }),
    department: sanitizeText(row.department ?? '', { maxLength: 255, allowEmpty: true }),
    department_id: row.departmentId ?? row.department_id ?? null,
    jobtitle_id: row.jobtitleId ?? row.jobtitle_id ?? null,
    parent_id: row.teamLeaderId ?? row.parent_id ?? null,
    status: mapBoolean(row.isActive ?? row.status ?? 1),
    image: row.avatar ?? row.image ?? defaultUserImage,
    created_at: row.createdAt ? toSqlDateTime(row.createdAt) : nowTs(),
    updated_at: nowTs(),
  };
};

const getScalar = (value) => (value === undefined || value === null || value === '' ? null : value);

const genericCreate = async (req, res, tableName, fieldMap, options = {}) => {
  const { requireAdmin = false, allowNullId = true, extraFields = {}, beforeInsert } = options;
  if (requireAdmin && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const payload = { ...fieldMap(req.body || {}) };
  if (beforeInsert) {
    const transformed = beforeInsert(payload, req.body || {});
    if (transformed) Object.assign(payload, transformed);
  }

  const columns = [];
  const values = [];
  Object.entries({ ...extraFields, ...payload }).forEach(([key, value]) => {
    if (value === undefined) return;
    columns.push(`\`${key}\``);
    values.push(value);
  });

  if (!columns.length) {
    return res.status(400).json({ error: 'No valid fields provided' });
  }

  if (allowNullId !== false && !Object.prototype.hasOwnProperty.call(payload, 'id')) {
    const nextId = await getNextId(tableName);
    columns.unshift('`id`');
    values.unshift(nextId);
  }

  const placeholders = Array.from({ length: values.length }, () => '?').join(', ');
  await pool.execute(`INSERT INTO \`${tableName}\` (${columns.join(', ')}) VALUES (${placeholders})`, values);
  const lastId = await getNextId(tableName);
  const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [values[0] ?? lastId - 1]);
  return res.status(201).json(rows[0] || { id: values[0] ?? lastId - 1 });
};

const genericUpdate = async (req, res, tableName, fieldMap, options = {}) => {
  const { requireAdmin = false, allowAdminSelf = false } = options;
  if (requireAdmin && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const id = validateRouteId(req.params.id, 'id');
  const [existingRows] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [id]);
  if (!existingRows.length) {
    return res.status(404).json({ error: 'Not found' });
  }

  const payload = { ...fieldMap(req.body || {}) };
  const updates = [];
  const values = [];
  Object.entries(payload).forEach(([key, value]) => {
    if (value === undefined) return;
    updates.push(`\`${key}\` = ?`);
    values.push(value);
  });

  if (!updates.length) {
    return res.status(400).json({ error: 'No valid fields provided' });
  }

  values.push(id);
  await pool.execute(`UPDATE \`${tableName}\` SET ${updates.join(', ')} WHERE id = ?`, values);
  const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [id]);
  return res.json(rows[0] || { id });
};

const genericDelete = async (req, res, tableName, options = {}) => {
  const { requireAdmin = false } = options;
  if (requireAdmin && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const id = validateRouteId(req.params.id, 'id');
  const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [id]);
  if (!rows.length) {
    return res.status(404).json({ error: 'Not found' });
  }
  await pool.execute(`DELETE FROM \`${tableName}\` WHERE id = ?`, [id]);
  return res.json({ success: true, id });
};

const registerCrudRoutes = (appInstance, { basePath, tableName, readQuery, createFromBody, updateFromBody, mapRow, requireAdmin = false }) => {
  appInstance.get(basePath, requireAuth, async (req, res) => {
    try {
      const [rows] = await pool.query(readQuery);
      res.json(rows.map(mapRow));
    } catch (error) {
      if (!(await ensureTableExists(tableName))) {
        return res.json([]);
      }
      return res.status(500).json({ error: error.message });
    }
  });

  appInstance.post(basePath, requireAuth, async (req, res) => {
    if (requireAdmin && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const payload = createFromBody(req.body || {});
      const columns = [];
      const values = [];
      Object.entries(payload).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        columns.push(`\`${key}\``);
        values.push(value);
      });
      if (!columns.length) {
        return res.status(400).json({ error: 'No valid fields provided' });
      }
      if (!Object.prototype.hasOwnProperty.call(payload, 'id')) {
        const nextId = await getNextId(tableName);
        columns.unshift('`id`');
        values.unshift(nextId);
      }
      const placeholder = Array.from({ length: values.length }, () => '?').join(', ');
      await pool.execute(`INSERT INTO \`${tableName}\` (${columns.join(', ')}) VALUES (${placeholder})`, values);
      const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [values[0]]);
      return res.status(201).json(rows[0] ? mapRow(rows[0]) : { id: values[0] });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  appInstance.put(`${basePath}/:id`, requireAuth, async (req, res) => {
    if (requireAdmin && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const id = validateRouteId(req.params.id, 'id');
      const payload = updateFromBody(req.body || {}, id);
      const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
      if (!entries.length) {
        return res.status(400).json({ error: 'No valid fields provided' });
      }
      const values = entries.map(([, value]) => value);
      const setSql = entries.map(([key]) => `\`${key}\` = ?`).join(', ');
      await pool.execute(`UPDATE \`${tableName}\` SET ${setSql} WHERE id = ?`, [...values, id]);
      const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [id]);
      return res.json(rows[0] ? mapRow(rows[0]) : { id });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  appInstance.delete(`${basePath}/:id`, requireAuth, async (req, res) => {
    if (requireAdmin && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const id = validateRouteId(req.params.id, 'id');
      const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [id]);
      if (!rows.length) {
        return res.status(404).json({ error: 'Not found' });
      }
      await pool.execute(`DELETE FROM \`${tableName}\` WHERE id = ?`, [id]);
      return res.json({ success: true, id });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
};

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password ?? '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const [rows] = await pool.query(`SELECT ${selectUserColumns} FROM users WHERE email = ? LIMIT 1`, [email]);
    const userRow = rows[0];
    if (!userRow) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await verifyPassword(password, userRow.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (Number(userRow.status ?? 1) === 0) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    const payload = serializeUser(userRow);
    const token = issueToken(userRow.id, userRow.role);
    return res.json({
      token,
      user: payload,
      expiresIn: JWT_EXPIRES_IN,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query(`SELECT ${selectUserColumns} FROM users WHERE id = ? LIMIT 1`, [req.user.id]);
  if (!rows[0]) {
    return res.status(404).json({ error: 'User not found' });
  }
  return res.json({
    user: serializeUser(rows[0]),
  });
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT ${selectUserColumns} FROM users ORDER BY id ASC`);
    return res.json(rows.map((row) => serializeUser(row)));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/users', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const payload = normalizeUsersPayload(req.body || {});
    const email = normalizeEmail(payload.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (await hasEmailConflict(email)) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    const plainPassword = String(payload.password ?? '');
    const passwordHash = plainPassword ? await bcrypt.hash(plainPassword, 10) : await bcrypt.hash('password', 10);
    const id = Number(payload.id ?? (await getNextId('users')));
    await pool.execute(`INSERT INTO users (id, name, email, phone, password, role, title, department, department_id, jobtitle_id, parent_id, status, image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      sanitizeText(payload.name, { maxLength: 255 }),
      email,
      sanitizeText(payload.phone ?? '', { maxLength: 50, allowEmpty: true }),
      passwordHash,
      normalizeRole(payload.role || 'agent'),
      sanitizeText(payload.title ?? '', { maxLength: 255, allowEmpty: true }),
      sanitizeText(payload.department ?? '', { maxLength: 255, allowEmpty: true }),
      payload.department_id ?? null,
      payload.jobtitle_id ?? null,
      payload.parent_id ?? null,
      mapBoolean(payload.status ?? true),
      payload.image ?? defaultUserImage,
      payload.created_at ?? nowTs(),
      payload.updated_at ?? nowTs(),
    ]);

    const [rows] = await pool.query(`SELECT ${selectUserColumns} FROM users WHERE id = ? LIMIT 1`, [id]);
    return res.status(201).json(rows[0] ? serializeUser(rows[0]) : { id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const id = validateRouteId(req.params.id, 'id');
    const [existingRows] = await pool.query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [id]);
    const current = existingRows[0];
    if (!current) {
      return res.status(404).json({ error: 'User not found' });
    }

    const input = normalizeUsersPayload(req.body || {});
    const email = normalizeEmail(input.email || current.email);
    if (email && await hasEmailConflict(email, id)) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    let passwordHash = current.password;
    if (req.body?.password) {
      passwordHash = await bcrypt.hash(String(req.body.password), 10);
    }

    await pool.execute(`UPDATE users SET name = ?, email = ?, phone = ?, password = ?, role = ?, title = ?, department = ?, department_id = ?, jobtitle_id = ?, parent_id = ?, status = ?, image = ?, updated_at = ? WHERE id = ?`, [
      sanitizeText(input.name || current.name, { maxLength: 255 }),
      email,
      sanitizeText(input.phone ?? current.phone ?? '', { maxLength: 50, allowEmpty: true }),
      passwordHash,
      normalizeRole(input.role || current.role || 'agent'),
      sanitizeText(input.title ?? current.title ?? '', { maxLength: 255, allowEmpty: true }),
      sanitizeText(input.department ?? current.department ?? '', { maxLength: 255, allowEmpty: true }),
      input.department_id ?? current.department_id ?? null,
      input.jobtitle_id ?? current.jobtitle_id ?? null,
      input.parent_id ?? current.parent_id ?? null,
      mapBoolean(input.status ?? current.status ?? true),
      input.image ?? current.image ?? defaultUserImage,
      nowTs(),
      id,
    ]);

    const [rows] = await pool.query(`SELECT ${selectUserColumns} FROM users WHERE id = ? LIMIT 1`, [id]);
    return res.json(rows[0] ? serializeUser(rows[0]) : { id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/users/:id', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const id = validateRouteId(req.params.id, 'id');
    const [rows] = await pool.query('SELECT id FROM users WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

registerCrudRoutes(app, {
  basePath: '/api/departments',
  tableName: 'departments',
  readQuery: 'SELECT id, name, created_at, updated_at FROM departments ORDER BY id ASC',
  createFromBody: (body) => ({
    id: body.id ?? undefined,
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    created_at: body.createdAt ? toSqlDateTime(body.createdAt) : nowTs(),
    updated_at: nowTs(),
  }),
  updateFromBody: (body) => ({
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    updated_at: nowTs(),
  }),
  mapRow: (row) => ({
    id: row.id,
    name: row.name,
    createdAt: toClientDateTime(row.created_at),
    updatedAt: toClientDateTime(row.updated_at),
  }),
  requireAdmin: true,
});

registerCrudRoutes(app, {
  basePath: '/api/jobtitles',
  tableName: 'jobtitles',
  readQuery: `SELECT j.id, j.name, j.department_id, j.created_at, j.updated_at, d.name AS department_name
    FROM jobtitles j LEFT JOIN departments d ON d.id = j.department_id ORDER BY j.id ASC`,
  createFromBody: (body) => ({
    id: body.id ?? undefined,
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    department_id: body.departmentId ?? body.department_id ?? null,
    created_at: body.createdAt ? toSqlDateTime(body.createdAt) : nowTs(),
    updated_at: nowTs(),
  }),
  updateFromBody: (body) => ({
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    department_id: body.departmentId ?? body.department_id ?? null,
    updated_at: nowTs(),
  }),
  mapRow: (row) => ({
    id: row.id,
    name: row.name,
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? undefined,
    createdAt: toClientDateTime(row.created_at),
    updatedAt: toClientDateTime(row.updated_at),
  }),
  requireAdmin: true,
});

registerCrudRoutes(app, {
  basePath: '/api/brokers',
  tableName: 'brokers',
  readQuery: `SELECT b.id, b.name, b.phone, b.developer_id, b.created_at, b.updated_at, d.name AS developer_name
    FROM brokers b LEFT JOIN developers d ON d.id = b.developer_id ORDER BY b.id ASC`,
  createFromBody: (body) => ({
    id: body.id ?? undefined,
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    phone: sanitizeText(body.phone ?? '', { maxLength: 50, allowEmpty: true }),
    developer_id: body.developerId ?? body.developer_id ?? null,
    created_at: body.createdAt ? toSqlDateTime(body.createdAt) : nowTs(),
    updated_at: nowTs(),
  }),
  updateFromBody: (body) => ({
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    phone: sanitizeText(body.phone ?? '', { maxLength: 50, allowEmpty: true }),
    developer_id: body.developerId ?? body.developer_id ?? null,
    updated_at: nowTs(),
  }),
  mapRow: (row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone ?? '',
    developerId: row.developer_id ?? null,
    developerName: row.developer_name ?? undefined,
    createdAt: toClientDateTime(row.created_at),
    updatedAt: toClientDateTime(row.updated_at),
  }),
  requireAdmin: true,
});

registerCrudRoutes(app, {
  basePath: '/api/developers',
  tableName: 'developers',
  readQuery: 'SELECT * FROM developers ORDER BY id ASC',
  createFromBody: (body) => ({
    id: body.id ?? undefined,
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    phone: sanitizeText(body.phone ?? '', { maxLength: 50, allowEmpty: true }),
    email: normalizeEmail(body.email ?? ''),
    whatsapp: sanitizeText(body.whatsapp ?? '', { maxLength: 50, allowEmpty: true }),
    website: sanitizeText(body.website ?? '', { maxLength: 255, allowEmpty: true }),
    description: sanitizeText(body.description ?? '', { maxLength: 5000, allowEmpty: true }),
    logo: sanitizeText(body.logo ?? '', { maxLength: 255, allowEmpty: true }),
    images: Array.isArray(body.images) ? JSON.stringify(body.images) : (body.images ?? null),
    videos: Array.isArray(body.videos) ? JSON.stringify(body.videos) : (body.videos ?? null),
    pdfs: Array.isArray(body.pdfs) ? JSON.stringify(body.pdfs) : (body.pdfs ?? null),
    created_at: body.createdAt ? toSqlDateTime(body.createdAt) : nowTs(),
    updated_at: nowTs(),
  }),
  updateFromBody: (body) => ({
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    phone: sanitizeText(body.phone ?? '', { maxLength: 50, allowEmpty: true }),
    email: normalizeEmail(body.email ?? ''),
    whatsapp: sanitizeText(body.whatsapp ?? '', { maxLength: 50, allowEmpty: true }),
    website: sanitizeText(body.website ?? '', { maxLength: 255, allowEmpty: true }),
    description: sanitizeText(body.description ?? '', { maxLength: 5000, allowEmpty: true }),
    logo: sanitizeText(body.logo ?? '', { maxLength: 255, allowEmpty: true }),
    images: Array.isArray(body.images) ? JSON.stringify(body.images) : (body.images ?? null),
    videos: Array.isArray(body.videos) ? JSON.stringify(body.videos) : (body.videos ?? null),
    pdfs: Array.isArray(body.pdfs) ? JSON.stringify(body.pdfs) : (body.pdfs ?? null),
    updated_at: nowTs(),
  }),
  mapRow: (row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone ?? '',
    whatsapp: row.whatsapp ?? '',
    email: row.email ?? '',
    website: row.website ?? '',
    description: row.description ?? '',
    logo: row.logo ?? '',
    images: parseJsonArray(row.images),
    videos: parseJsonArray(row.videos),
    pdfs: parseJsonArray(row.pdfs),
    createdAt: toClientDateTime(row.created_at),
    updatedAt: toClientDateTime(row.updated_at),
  }),
  requireAdmin: true,
});

registerCrudRoutes(app, {
  basePath: '/api/projects',
  tableName: 'projects',
  readQuery: `SELECT p.id, p.name, p.developer_id, p.created_at, p.updated_at, d.name AS developer_name
    FROM projects p LEFT JOIN developers d ON d.id = p.developer_id ORDER BY p.id ASC`,
  createFromBody: (body) => ({
    id: body.id ?? undefined,
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    developer_id: body.developerId ?? body.developer_id ?? null,
    created_at: body.createdAt ? toSqlDateTime(body.createdAt) : nowTs(),
    updated_at: nowTs(),
  }),
  updateFromBody: (body) => ({
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    developer_id: body.developerId ?? body.developer_id ?? null,
    updated_at: nowTs(),
  }),
  mapRow: (row) => ({
    id: row.id,
    name: row.name,
    developerId: row.developer_id ?? null,
    developerName: row.developer_name ?? undefined,
    createdAt: toClientDateTime(row.created_at),
    updatedAt: toClientDateTime(row.updated_at),
  }),
  requireAdmin: true,
});

registerCrudRoutes(app, {
  basePath: '/api/statuses',
  tableName: 'statuses',
  readQuery: 'SELECT id, name, color, created_at, updated_at FROM statuses ORDER BY id ASC',
  createFromBody: (body) => ({
    id: body.id ?? undefined,
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    color: sanitizeText(body.color ?? '#3B82F6', { maxLength: 50 }),
    created_at: body.createdAt ? toSqlDateTime(body.createdAt) : nowTs(),
    updated_at: nowTs(),
  }),
  updateFromBody: (body) => ({
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    color: sanitizeText(body.color ?? '#3B82F6', { maxLength: 50 }),
    updated_at: nowTs(),
  }),
  mapRow: (row) => ({
    id: row.id,
    name: row.name,
    color: row.color ?? '#3B82F6',
    createdAt: toClientDateTime(row.created_at),
    updatedAt: toClientDateTime(row.updated_at),
  }),
  requireAdmin: true,
});

registerCrudRoutes(app, {
  basePath: '/api/lead-sources',
  tableName: 'sources',
  readQuery: 'SELECT * FROM sources ORDER BY id ASC',
  createFromBody: (body) => ({
    id: body.id ?? undefined,
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    color: sanitizeText(body.color ?? '#3B82F6', { maxLength: 50 }),
    created_at: body.createdAt ? toSqlDateTime(body.createdAt) : nowTs(),
    updated_at: nowTs(),
  }),
  updateFromBody: (body) => ({
    name: sanitizeText(body.name ?? '', { maxLength: 255 }),
    color: sanitizeText(body.color ?? '#3B82F6', { maxLength: 50 }),
    updated_at: nowTs(),
  }),
  mapRow: (row) => ({
    id: row.id,
    name: row.name,
    color: row.color ?? '#3B82F6',
    createdAt: toClientDateTime(row.created_at),
    updatedAt: toClientDateTime(row.updated_at),
  }),
  requireAdmin: true,
});
app.use('/api/sources', requireAuth, async (req, res) => {
  const path = req.path;
  if (req.method === 'GET') return app._router.handle(req, res);
  return app._router.handle(req, res);
});

app.get('/api/titles', requireAuth, async (req, res) => {
  try {
    const exists = await ensureTableExists('titles');
    if (!exists) {
      return res.json([]);
    }
    const [rows] = await pool.query('SELECT * FROM titles ORDER BY id ASC');
    return res.json(rows.map((row) => ({ id: row.id, name: row.name, department: row.department ?? '' })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent-care', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM agent_care ORDER BY id ASC');
    return res.json(rows);
  } catch (error) {
    if (!(await ensureTableExists('agent_care'))) {
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/agent-care', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const payload = req.body || {};
    const id = Number(payload.id ?? (await getNextId('agent_care')));
    const name = sanitizeText(payload.name ?? '', { maxLength: 255 });
    const phone = sanitizeText(payload.phone ?? '', { maxLength: 50 });
    const whatsapp = sanitizeText(payload.whatsapp ?? '', { maxLength: 50 });
    const email = normalizeEmail(payload.email ?? '');
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    await pool.execute('INSERT INTO agent_care (id, name, phone, whatsapp, email) VALUES (?, ?, ?, ?, ?)', [id, name, phone, whatsapp, email]);
    return res.status(201).json({ id, name, phone, whatsapp, email });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/agent-care/:id', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = req.body || {};
    await pool.execute('UPDATE agent_care SET name = ?, phone = ?, whatsapp = ?, email = ? WHERE id = ?', [
      sanitizeText(payload.name ?? '', { maxLength: 255 }),
      sanitizeText(payload.phone ?? '', { maxLength: 50 }),
      sanitizeText(payload.whatsapp ?? '', { maxLength: 50 }),
      normalizeEmail(payload.email ?? ''),
      id,
    ]);
    const [rows] = await pool.query('SELECT * FROM agent_care WHERE id = ? LIMIT 1', [id]);
    return res.json(rows[0] || { id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/agent-care/:id', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM agent_care WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT l.*, p.name AS project_name, s.name AS status_name, src.name AS source_name, u.name AS assigned_name, u2.name AS team_leader_name
      FROM leads l
      LEFT JOIN projects p ON p.id = l.project_id
      LEFT JOIN statuses s ON s.id = l.status_id
      LEFT JOIN sources src ON src.id = l.source_id
      LEFT JOIN users u ON u.id = l.user_id
      LEFT JOIN users u2 ON u2.id = l.user_id
      ORDER BY l.id ASC`);
    return res.json(rows.map((row) => ({
      id: row.id,
      type: row.type ?? 'Lead',
      name: row.name,
      phone: row.phone,
      whatsapp: row.whatsapp ?? '',
      workPhone: row.workphone ?? '',
      email: row.email ?? '',
      status: row.status_name ?? 'New',
      statusId: row.status_id ?? null,
      source: row.source_name ?? '',
      sourceId: row.source_id ?? null,
      project: row.project_name ?? '',
      projectId: row.project_id ?? null,
      assignedTo: row.assigned_name ?? '',
      assignedToId: row.user_id ?? null,
      teamLeader: row.team_leader_name ?? '',
      teamLeaderId: row.user_id ?? null,
      comments: [],
      date: row.date ? toClientDateOnly(row.date) : '',
      isPotential: Boolean(row.is_potential ?? false),
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.updated_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/leads', requireAuth, async (req, res) => {
  try {
    const payload = normalizeLeadBody(req.body || {});
    const name = sanitizeText(payload.name ?? '', { maxLength: 255 });
    const phone = sanitizeText(payload.phone ?? '', { maxLength: 50 });
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    const id = Number(payload.id ?? (await getNextId('leads')));
    const projectId = payload.projectId ?? payload.project_id ?? null;
    const statusId = payload.statusId ?? payload.status_id ?? null;
    const sourceId = payload.sourceId ?? payload.source_id ?? null;
    const userId = payload.assignedToId ?? payload.user_id ?? null;
    const comment = sanitizeText(payload.comment ?? payload.notes ?? '', { maxLength: 5000, allowEmpty: true });
    await pool.execute(`INSERT INTO leads (id, name, phone, whatsapp, workphone, date, project_id, status_id, source_id, comment, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      name,
      sanitizeText(payload.whatsapp ?? '', { maxLength: 50, allowEmpty: true }),
      sanitizeText(payload.workPhone ?? payload.workphone ?? '', { maxLength: 50, allowEmpty: true }),
      payload.date ? toSqlDateOnly(payload.date) : null,
      projectId,
      statusId,
      sourceId,
      comment,
      userId,
      nowTs(),
      nowTs(),
    ]);
    return res.status(201).json({ id, name, phone, projectId, assignedToId: userId, statusId, sourceId });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = normalizeLeadBody(req.body || {});
    const updateRows = [
      'name = ?',
      'phone = ?',
      'whatsapp = ?',
      'workphone = ?',
      'date = ?',
      'project_id = ?',
      'status_id = ?',
      'source_id = ?',
      'comment = ?',
      'user_id = ?',
      'updated_at = ?',
    ];
    const values = [
      sanitizeText(payload.name ?? '', { maxLength: 255 }),
      sanitizeText(payload.phone ?? '', { maxLength: 50 }),
      sanitizeText(payload.whatsapp ?? '', { maxLength: 50, allowEmpty: true }),
      sanitizeText(payload.workPhone ?? payload.workphone ?? '', { maxLength: 50, allowEmpty: true }),
      payload.date ? toSqlDateOnly(payload.date) : null,
      payload.projectId ?? payload.project_id ?? null,
      payload.statusId ?? payload.status_id ?? null,
      payload.sourceId ?? payload.source_id ?? null,
      sanitizeText(payload.comment ?? payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      payload.assignedToId ?? payload.user_id ?? null,
      nowTs(),
      id,
    ];
    await pool.execute(`UPDATE leads SET ${updateRows.join(', ')} WHERE id = ?`, values);
    const [rows] = await pool.query('SELECT * FROM leads WHERE id = ? LIMIT 1', [id]);
    return res.json(rows[0] || { id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM leads WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/cold-calls', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT c.*, s.name AS status_name, u.name AS assigned_name
      FROM cold_calls c
      LEFT JOIN statuses s ON s.id = c.status_id
      LEFT JOIN users u ON u.id = c.user_id
      ORDER BY c.id ASC`);
    return res.json(rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status_name ?? '',
      statusId: row.status_id ?? null,
      assignedTo: row.assigned_name ?? '',
      assignedToId: row.user_id ?? null,
      notes: row.notes ?? '',
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.updated_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/cold-calls', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const name = sanitizeText(payload.name ?? '', { maxLength: 255 });
    const phone = sanitizeText(payload.phone ?? '', { maxLength: 50 });
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    const statusId = Number(payload.statusId ?? payload.status_id ?? 1);
    const userId = payload.assignedToId ?? payload.user_id ?? null;
    const id = Number(payload.id ?? (await getNextId('cold_calls')));
    await pool.execute('INSERT INTO cold_calls (id, name, phone, status_id, user_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      name,
      phone,
      statusId,
      userId,
      sanitizeText(payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      nowTs(),
      nowTs(),
    ]);
    return res.status(201).json({ id, name, phone, statusId, assignedToId: userId });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/cold-calls/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = req.body || {};
    await pool.execute('UPDATE cold_calls SET name = ?, phone = ?, status_id = ?, user_id = ?, notes = ?, updated_at = ? WHERE id = ?', [
      sanitizeText(payload.name ?? '', { maxLength: 255 }),
      sanitizeText(payload.phone ?? '', { maxLength: 50 }),
      Number(payload.statusId ?? payload.status_id ?? 1),
      payload.assignedToId ?? payload.user_id ?? null,
      sanitizeText(payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      nowTs(),
      id,
    ]);
    return res.json({ id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/cold-calls/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM cold_calls WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/comments', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT c.*, u.name AS author_name
      FROM comments c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.id ASC`);
    return res.json(rows.map((row) => ({
      id: row.id,
      leadId: row.lead_id ?? row.entity_id ?? null,
      entityType: row.entity_type ?? 'lead',
      entityId: row.entity_id ?? null,
      content: row.body ?? row.content ?? '',
      createdBy: row.author_name ?? 'System',
      createdById: row.user_id ?? null,
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.updated_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/comments', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const content = sanitizeText(payload.content ?? payload.body ?? '', { maxLength: 5000 });
    if (!content) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    const userId = Number(req.user.id);
    const id = Number(payload.id ?? (await getNextId('comments')));
    const leadId = payload.leadId ?? payload.lead_id ?? null;
    const coldCallId = payload.coldCallId ?? payload.cold_call_id ?? null;
    const entityType = payload.entityType ?? payload.entity_type ?? (leadId ? 'lead' : (coldCallId ? 'cold_call' : null));
    const entityId = payload.entityId ?? payload.entity_id ?? leadId ?? coldCallId ?? null;
    await pool.execute('INSERT INTO comments (id, user_id, lead_id, cold_call_id, entity_type, entity_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      userId,
      leadId,
      coldCallId,
      entityType,
      entityId,
      content,
      nowTs(),
      nowTs(),
    ]);
    return res.status(201).json({ id, leadId, content, userId, entityType, entityId });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = req.body || {};
    const content = sanitizeText(payload.content ?? payload.body ?? '', { maxLength: 5000 });
    await pool.execute('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?', [content, nowTs(), id]);
    return res.json({ id, content });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM comments WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT c.id AS comment_id, c.lead_id, c.cold_call_id, c.entity_type, c.entity_id, c.body AS content, c.user_id AS created_by_id, c.created_at, u.name AS created_by_name,
      l.name AS lead_name, l.phone AS lead_phone, cl.name AS cold_call_name, cl.phone AS cold_call_phone,
      s.name AS status_name, p.name AS project_name, d.name AS developer_name, u2.name AS agent_name
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      LEFT JOIN leads l ON l.id = c.lead_id
      LEFT JOIN cold_calls cl ON cl.id = c.cold_call_id
      LEFT JOIN statuses s ON s.id = l.status_id OR s.id = cl.status_id
      LEFT JOIN projects p ON p.id = l.project_id
      LEFT JOIN developers d ON d.id = p.developer_id
      LEFT JOIN users u2 ON u2.id = l.user_id`);
    return res.json(rows.map((row) => ({
      id: row.comment_id,
      commentId: row.comment_id,
      leadId: row.lead_id ?? null,
      coldCallId: row.cold_call_id ?? null,
      entityType: row.entity_type ?? 'lead',
      entityId: row.entity_id ?? null,
      clientName: row.lead_name ?? row.cold_call_name ?? '',
      clientPhone: row.lead_phone ?? row.cold_call_phone ?? '',
      agentId: row.created_by_id ?? null,
      agentName: row.created_by_name ?? row.agent_name ?? '',
      teamLeaderId: null,
      teamLeaderName: '',
      statusId: null,
      statusName: row.status_name ?? '',
      projectId: row.project_id ?? null,
      projectName: row.project_name ?? '',
      developerId: null,
      developerName: row.developer_name ?? '',
      content: row.content ?? '',
      createdBy: row.created_by_name ?? '',
      createdById: row.created_by_id ?? null,
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.created_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/deals', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT d.*, u.name AS agent_name, p.name AS project_name, dev.name AS developer_name
      FROM deals d
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN projects p ON p.id = d.project_id
      LEFT JOIN developers dev ON dev.id = d.developer_id
      ORDER BY d.id ASC`);
    return res.json(rows.map((row) => ({
      id: row.id,
      leadId: row.lead_id ?? row.id,
      leadName: row.name ?? '',
      clientPhone: row.phone ?? '',
      agentId: row.user_id ?? null,
      agentName: row.agent_name ?? '',
      projectId: row.project_id ?? null,
      projectName: row.project_name ?? '',
      developerId: row.developer_id ?? null,
      developerName: row.developer_name ?? '',
      amount: Number(row.price ?? row.amount ?? 0),
      commission: Number(row.commission ?? 0),
      status: row.status ?? 'pending',
      stage: row.stage ?? '',
      reservationPrice: Number(row.reservation_price ?? 0),
      reservationDate: toClientDateOnly(row.reservation_date),
      contractPrice: Number(row.price ?? 0),
      contractDate: toClientDateOnly(row.contract_date),
      unitNumber: row.unit_number ?? '',
      createdAt: toClientDateTime(row.created_at),
      date: toClientDateOnly(row.contract_date ?? row.created_at),
      notes: row.comment ?? '',
      attachments: parseJsonArray(row.attachments),
      reservationImages: parseJsonArray(row.reservations_images),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/deals', requireAuth, async (req, res) => {
  try {
    const payload = normalizeDealPayload(req.body || {});
    const id = Number(payload.id ?? (await getNextId('deals')));
    const name = sanitizeText(payload.name || '', { maxLength: 255 });
    const phone = sanitizeText(payload.phone || '', { maxLength: 50 });
    if (!name || !phone) {
      return res.status(400).json({ error: 'Deal name and client phone are required' });
    }
    await pool.execute(`INSERT INTO deals (id, name, phone, project_id, developer_id, broker_id, attachments, reservations_images, reservation_price, reservation_date, price, contract_date, unit_number, commission, stage, comment, status, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      name,
      phone,
      payload.project_id,
      payload.developer_id,
      payload.broker_id,
      payload.attachments,
      payload.reservations_images,
      payload.reservation_price,
      payload.reservation_date,
      payload.price,
      payload.contract_date,
      payload.unit_number,
      payload.commission,
      payload.stage,
      payload.comment,
      payload.status,
      payload.user_id,
      payload.created_at,
      payload.updated_at,
    ]);
    return res.status(201).json({ id, leadName: name, clientPhone: phone, agentId: payload.user_id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/deals/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = normalizeDealPayload(req.body || {});
    await pool.execute(`UPDATE deals SET name = ?, phone = ?, project_id = ?, developer_id = ?, broker_id = ?, attachments = ?, reservations_images = ?, reservation_price = ?, reservation_date = ?, price = ?, contract_date = ?, unit_number = ?, commission = ?, stage = ?, comment = ?, status = ?, user_id = ?, updated_at = ? WHERE id = ?`, [
      sanitizeText(payload.name || '', { maxLength: 255 }),
      sanitizeText(payload.phone || '', { maxLength: 50 }),
      payload.project_id,
      payload.developer_id,
      payload.broker_id,
      payload.attachments,
      payload.reservations_images,
      payload.reservation_price,
      payload.reservation_date,
      payload.price,
      payload.contract_date,
      payload.unit_number,
      payload.commission,
      payload.stage,
      payload.comment,
      payload.status,
      payload.user_id,
      payload.updated_at,
      id,
    ]);
    return res.json({ id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/deals/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM deals WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/calendar-events', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM calendar_events ORDER BY id ASC');
    return res.json(rows.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type ?? '',
      notes: row.notes ?? '',
      startAt: toClientDateTime(row.start_at),
      endAt: toClientDateTime(row.end_at),
      dueDate: toClientDateOnly(row.due_date),
      leadId: row.lead_id ?? null,
      coldCallId: row.cold_call_id ?? null,
      dealId: row.deal_id ?? null,
      userId: row.user_id ?? null,
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.updated_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/calendar-events', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const title = sanitizeText(payload.title ?? '', { maxLength: 255 });
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const id = Number(payload.id ?? (await getNextId('calendar_events')));
    await pool.execute(`INSERT INTO calendar_events (id, title, type, notes, start_at, end_at, due_date, lead_id, cold_call_id, deal_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      title,
      sanitizeText(payload.type ?? '', { maxLength: 100, allowEmpty: true }),
      sanitizeText(payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      payload.startAt ? toSqlDateTime(payload.startAt) : null,
      payload.endAt ? toSqlDateTime(payload.endAt) : null,
      payload.dueDate ? toSqlDateOnly(payload.dueDate) : null,
      payload.leadId ?? null,
      payload.coldCallId ?? null,
      payload.dealId ?? null,
      payload.userId ?? null,
      nowTs(),
      nowTs(),
    ]);
    return res.status(201).json({ id, title });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/calendar-events/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = req.body || {};
    await pool.execute(`UPDATE calendar_events SET title = ?, type = ?, notes = ?, start_at = ?, end_at = ?, due_date = ?, lead_id = ?, cold_call_id = ?, deal_id = ?, user_id = ?, updated_at = ? WHERE id = ?`, [
      sanitizeText(payload.title ?? '', { maxLength: 255 }),
      sanitizeText(payload.type ?? '', { maxLength: 100, allowEmpty: true }),
      sanitizeText(payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      payload.startAt ? toSqlDateTime(payload.startAt) : null,
      payload.endAt ? toSqlDateTime(payload.endAt) : null,
      payload.dueDate ? toSqlDateOnly(payload.dueDate) : null,
      payload.leadId ?? null,
      payload.coldCallId ?? null,
      payload.dealId ?? null,
      payload.userId ?? null,
      nowTs(),
      id,
    ]);
    return res.json({ id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/calendar-events/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM calendar_events WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasks ORDER BY id ASC');
    return res.json(rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status ?? '',
      priority: row.priority ?? '',
      dueDate: toClientDateOnly(row.due_date),
      assignedToId: row.assigned_to_id ?? null,
      leadId: row.lead_id ?? null,
      notes: row.notes ?? '',
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.updated_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const title = sanitizeText(payload.title ?? '', { maxLength: 255 });
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const id = Number(payload.id ?? (await getNextId('tasks')));
    await pool.execute(`INSERT INTO tasks (id, title, status, priority, due_date, assigned_to_id, lead_id, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      title,
      sanitizeText(payload.status ?? '', { maxLength: 100, allowEmpty: true }),
      sanitizeText(payload.priority ?? '', { maxLength: 50, allowEmpty: true }),
      payload.dueDate ? toSqlDateOnly(payload.dueDate) : null,
      payload.assignedToId ?? null,
      payload.leadId ?? null,
      sanitizeText(payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      nowTs(),
      nowTs(),
    ]);
    return res.status(201).json({ id, title });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = req.body || {};
    await pool.execute(`UPDATE tasks SET title = ?, status = ?, priority = ?, due_date = ?, assigned_to_id = ?, lead_id = ?, notes = ?, updated_at = ? WHERE id = ?`, [
      sanitizeText(payload.title ?? '', { maxLength: 255 }),
      sanitizeText(payload.status ?? '', { maxLength: 100, allowEmpty: true }),
      sanitizeText(payload.priority ?? '', { maxLength: 50, allowEmpty: true }),
      payload.dueDate ? toSqlDateOnly(payload.dueDate) : null,
      payload.assignedToId ?? null,
      payload.leadId ?? null,
      sanitizeText(payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      nowTs(),
      id,
    ]);
    return res.json({ id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM tasks WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/pipeline', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM pipeline ORDER BY id ASC');
    return res.json(rows.map((row) => ({
      id: row.id,
      title: row.title,
      stage: row.stage ?? '',
      value: Number(row.value ?? 0),
      ownerId: row.owner_id ?? null,
      leadId: row.lead_id ?? null,
      dealId: row.deal_id ?? null,
      notes: row.notes ?? '',
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.updated_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/pipeline', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const title = sanitizeText(payload.title ?? '', { maxLength: 255 });
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const id = Number(payload.id ?? (await getNextId('pipeline')));
    await pool.execute('INSERT INTO pipeline (id, title, stage, value, owner_id, lead_id, deal_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      title,
      sanitizeText(payload.stage ?? '', { maxLength: 100, allowEmpty: true }),
      Number(payload.value ?? 0),
      payload.ownerId ?? null,
      payload.leadId ?? null,
      payload.dealId ?? null,
      sanitizeText(payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      nowTs(),
      nowTs(),
    ]);
    return res.status(201).json({ id, title });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/pipeline/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = req.body || {};
    await pool.execute('UPDATE pipeline SET title = ?, stage = ?, value = ?, owner_id = ?, lead_id = ?, deal_id = ?, notes = ?, updated_at = ? WHERE id = ?', [
      sanitizeText(payload.title ?? '', { maxLength: 255 }),
      sanitizeText(payload.stage ?? '', { maxLength: 100, allowEmpty: true }),
      Number(payload.value ?? 0),
      payload.ownerId ?? null,
      payload.leadId ?? null,
      payload.dealId ?? null,
      sanitizeText(payload.notes ?? '', { maxLength: 5000, allowEmpty: true }),
      nowTs(),
      id,
    ]);
    return res.json({ id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/pipeline/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM pipeline WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/knowledge-base', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM knowledge_base ORDER BY id ASC');
    return res.json(rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category ?? '',
      content: row.content ?? '',
      projectId: row.project_id ?? null,
      developerId: row.developer_id ?? null,
      priceRange: row.price_range ?? '',
      paymentPlan: row.payment_plan ?? '',
      deliveryDate: row.delivery_date ?? '',
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.updated_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/knowledge-base', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const title = sanitizeText(payload.title ?? '', { maxLength: 255 });
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const id = Number(payload.id ?? (await getNextId('knowledge_base')));
    await pool.execute('INSERT INTO knowledge_base (id, title, category, content, project_id, developer_id, price_range, payment_plan, delivery_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      title,
      sanitizeText(payload.category ?? '', { maxLength: 100, allowEmpty: true }),
      sanitizeText(payload.content ?? '', { maxLength: 5000, allowEmpty: true }),
      payload.projectId ?? null,
      payload.developerId ?? null,
      sanitizeText(payload.priceRange ?? '', { maxLength: 100, allowEmpty: true }),
      sanitizeText(payload.paymentPlan ?? '', { maxLength: 255, allowEmpty: true }),
      sanitizeText(payload.deliveryDate ?? '', { maxLength: 50, allowEmpty: true }),
      nowTs(),
      nowTs(),
    ]);
    return res.status(201).json({ id, title });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/knowledge-base/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = req.body || {};
    await pool.execute('UPDATE knowledge_base SET title = ?, category = ?, content = ?, project_id = ?, developer_id = ?, price_range = ?, payment_plan = ?, delivery_date = ?, updated_at = ? WHERE id = ?', [
      sanitizeText(payload.title ?? '', { maxLength: 255 }),
      sanitizeText(payload.category ?? '', { maxLength: 100, allowEmpty: true }),
      sanitizeText(payload.content ?? '', { maxLength: 5000, allowEmpty: true }),
      payload.projectId ?? null,
      payload.developerId ?? null,
      sanitizeText(payload.priceRange ?? '', { maxLength: 100, allowEmpty: true }),
      sanitizeText(payload.paymentPlan ?? '', { maxLength: 255, allowEmpty: true }),
      sanitizeText(payload.deliveryDate ?? '', { maxLength: 50, allowEmpty: true }),
      nowTs(),
      id,
    ]);
    return res.json({ id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/knowledge-base/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM knowledge_base WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM notifications ORDER BY id ASC');
    return res.json(rows.map((row) => ({
      id: row.id,
      userId: row.user_id ?? null,
      title: row.title,
      body: row.body ?? '',
      isRead: Number(row.is_read ?? 0) === 1,
      createdAt: toClientDateTime(row.created_at),
      updatedAt: toClientDateTime(row.updated_at),
    })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/notifications', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const title = sanitizeText(payload.title ?? '', { maxLength: 255 });
    const body = sanitizeText(payload.body ?? '', { maxLength: 5000, allowEmpty: true });
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const id = Number(payload.id ?? (await getNextId('notifications')));
    await pool.execute('INSERT INTO notifications (id, user_id, title, body, is_read, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      payload.userId ?? null,
      title,
      body,
      toBool(payload.isRead ?? false),
      nowTs(),
      nowTs(),
    ]);
    return res.status(201).json({ id, title, body, userId: payload.userId ?? null });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put('/api/notifications/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    const payload = req.body || {};
    await pool.execute('UPDATE notifications SET user_id = ?, title = ?, body = ?, is_read = ?, updated_at = ? WHERE id = ?', [
      payload.userId ?? null,
      sanitizeText(payload.title ?? '', { maxLength: 255 }),
      sanitizeText(payload.body ?? '', { maxLength: 5000, allowEmpty: true }),
      toBool(payload.isRead ?? false),
      nowTs(),
      id,
    ]);
    return res.json({ id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/notifications/:id', requireAuth, async (req, res) => {
  try {
    const id = validateRouteId(req.params.id, 'id');
    await pool.execute('DELETE FROM notifications WHERE id = ?', [id]);
    return res.json({ success: true, id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`YourMentors CRM API running on http://localhost:${port}`);
});
