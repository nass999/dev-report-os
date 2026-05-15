import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

async function ensureFile(file, initial) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(file); }
  catch { await fs.writeFile(file, initial, 'utf-8'); }
}

const writeChains = new Map();
function chainedWrite(file, content) {
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.then(() => fs.writeFile(file, content, 'utf-8')).catch(err => {
    console.error('[db] write failed for', file, err);
  });
  writeChains.set(file, next);
  return next;
}

async function readJson(file, fallback) {
  await ensureFile(file, JSON.stringify(fallback));
  try { return JSON.parse(await fs.readFile(file, 'utf-8')); }
  catch { return fallback; }
}

async function readAll() {
  return readJson(ARCHIVE_FILE, []);
}
function writeAll(events) {
  return chainedWrite(ARCHIVE_FILE, JSON.stringify(events, null, 2));
}

export async function listArchive({ q = '', tech = '', location = '' } = {}) {
  const all = await readAll();
  const ql = q.toLowerCase().trim();
  const tl = tech.toLowerCase().trim();
  const ll = location.toLowerCase().trim();
  return all.filter(e => {
    if (ql) {
      const hay = `${e.name} ${e.location} ${(e.technology||[]).join(' ')} ${e.metrics?.notes||''}`.toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    if (tl && !(e.technology||[]).join(' ').toLowerCase().includes(tl)) return false;
    if (ll && !String(e.location||'').toLowerCase().includes(ll)) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));
}

export async function addArchive(evt) {
  const all = await readAll();
  const newEvt = {
    ...evt,
    id: evt.id || newId(),
    createdAt: new Date().toISOString()
  };
  all.push(newEvt);
  await writeAll(all);
  return newEvt;
}

export async function updateArchive(id, patch) {
  const all = await readAll();
  const i = all.findIndex(e => e.id === id);
  if (i < 0) return null;
  const cur = all[i];
  const merged = {
    ...cur,
    ...patch,
    metrics: { ...cur.metrics, ...(patch.metrics || {}) },
    updatedAt: new Date().toISOString()
  };
  all[i] = merged;
  await writeAll(all);
  return merged;
}

export async function removeArchive(id) {
  const all = await readAll();
  const filtered = all.filter(e => e.id !== id);
  if (filtered.length === all.length) return false;
  await writeAll(filtered);
  return true;
}

export function normalizeForCreate(body) {
  const techArr = Array.isArray(body.technology)
    ? body.technology
    : (typeof body.technology === 'string'
        ? body.technology.split(',').map(s => s.trim()).filter(Boolean)
        : []);
  return {
    name: String(body.name || '').trim().slice(0, 200),
    date: String(body.date || '').slice(0, 10),
    technology: techArr,
    location: String(body.location || 'TBD').slice(0, 100),
    medium: body.medium === 'Virtual' ? 'Virtual' : 'Physical',
    url: String(body.url || '').slice(0, 500),
    source: String(body.source || 'manual').slice(0, 50),
    status: 'attended',
    tracked: true,
    metrics: {
      spend: toInt(body.metrics?.spend),
      signups: toInt(body.metrics?.signups),
      engagements: toInt(body.metrics?.engagements),
      outcome: ['strong','medium','weak'].includes(body.metrics?.outcome) ? body.metrics.outcome : null,
      notes: String(body.metrics?.notes || '').slice(0, 2000)
    }
  };
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : 0; }
function newId() { return 'evt-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

/* ============================================================
   Users (email + bcrypt password)
   ============================================================ */
async function readUsers() { return readJson(USERS_FILE, []); }
function writeUsers(users) { return chainedWrite(USERS_FILE, JSON.stringify(users, null, 2)); }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createUser({ email, name, password }) {
  email = String(email || '').toLowerCase().trim();
  name = String(name || '').trim().slice(0, 80);
  password = String(password || '');
  if (!EMAIL_RE.test(email)) throw new Error('Please enter a valid email address.');
  if (name.length < 1) throw new Error('Please enter your name.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');

  const users = await readUsers();
  if (users.some(u => u.email === email)) throw new Error('That email is already registered.');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: 'usr-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
    email,
    name,
    passwordHash,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  await writeUsers(users);
  return user;
}

export async function findUserByEmail(email) {
  const users = await readUsers();
  return users.find(u => u.email === String(email || '').toLowerCase().trim()) || null;
}

export async function findUserById(id) {
  const users = await readUsers();
  return users.find(u => u.id === id) || null;
}

export async function verifyPassword(user, plain) {
  if (!user?.passwordHash) return false;
  return bcrypt.compare(String(plain || ''), user.passwordHash);
}

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name };
}
