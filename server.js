import express from 'express';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scrapeAll } from './scrapers/index.js';
import {
  listArchive, addArchive, updateArchive, removeArchive, normalizeForCreate,
  createUser, findUserByEmail, findUserById, verifyPassword, publicUser
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5174;
const CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_DIR = path.join(__dirname, 'data', 'sessions');

const cache = new Map();   // key → { ts, payload }

const FileStore = FileStoreFactory(session);

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(session({
  store: new FileStore({ path: SESSION_DIR, ttl: 7 * 24 * 60 * 60, retries: 1, logFn: () => {} }),
  name: 'devreport.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,                            // localhost
    maxAge: 7 * 24 * 60 * 60 * 1000           // 7 days
  }
}));

// Attach req.user when signed in
app.use(async (req, _res, next) => {
  if (req.session?.userId) {
    try { req.user = await findUserById(req.session.userId); }
    catch (err) { console.error('[attachUser]', err); }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Block server-internal paths before any static handler — these contain
// password hashes, session tokens, and source code.
const BLOCKED_PATHS = ['/data', '/scrapers', '/node_modules', '/server.js', '/db.js', '/package.json', '/package-lock.json', '/.env', '/.git'];
app.use((req, res, next) => {
  if (BLOCKED_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) {
    return res.status(404).end();
  }
  next();
});
app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny' }));

/* ---------- Auth ---------- */
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, name, password } = req.body || {};
    const user = await createUser({ email, name, password });
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(user, password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('[signin]', err);
    res.status(500).json({ error: 'Sign in failed.' });
  }
});

app.post('/api/auth/signout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('devreport.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ---------- Protected routes below this point ---------- */
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health') return next();
  return requireAuth(req, res, next);
});

app.get('/api/events', async (req, res) => {
  const filters = {
    tech: (req.query.tech || '').toString(),
    location: (req.query.location || '').toString(),
    medium: (req.query.medium || '').toString(),
  };
  const key = JSON.stringify(filters);
  const now = Date.now();
  const hit = cache.get(key);
  const fresh = hit && (now - hit.ts) < CACHE_TTL_MS && req.query.refresh !== '1';
  if (fresh) {
    return res.json({ ...hit.payload, cached: true, age_ms: now - hit.ts });
  }
  try {
    const result = await scrapeAll(filters);
    cache.set(key, { ts: now, payload: result });
    res.json({ ...result, cached: false, age_ms: 0 });
  } catch (err) {
    console.error('[/api/events] fatal:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Archive (persistent past events) ---------- */
app.get('/api/archive', async (req, res) => {
  try {
    const events = await listArchive({
      q: (req.query.q || '').toString(),
      tech: (req.query.tech || '').toString(),
      location: (req.query.location || '').toString()
    });
    res.json({ events });
  } catch (err) {
    console.error('[GET /api/archive]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/archive', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.date) return res.status(400).json({ error: 'name and date are required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const evt = await addArchive({
      ...normalizeForCreate(body),
      createdBy: req.user.id,
      createdByName: req.user.name
    });
    res.json({ event: evt });
  } catch (err) {
    console.error('[POST /api/archive]', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/archive/:id', async (req, res) => {
  try {
    const patch = {
      ...(req.body || {}),
      lastEditedBy: req.user.id,
      lastEditedByName: req.user.name
    };
    const updated = await updateArchive(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ event: updated });
  } catch (err) {
    console.error('[PATCH /api/archive/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/archive/:id', async (req, res) => {
  try {
    const ok = await removeArchive(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/archive/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Broadcast to Slack / Teams ----------
 * Slack incoming webhooks block CORS from browsers; Teams enforces strict
 * Origin checks. Both work fine when called server-to-server, so the client
 * POSTs here and we forward. Webhook host is whitelisted to avoid using
 * this route as an open SSRF gadget.
 */
const BROADCAST_HOSTS = new Set([
  'hooks.slack.com',
  'webhook.office.com',
  'outlook.office.com',
  'prod-NN.westus.logic.azure.com',  // Teams workflow webhooks vary by region;
                                       // covered by the .azure.com suffix check below
]);
function isAllowedWebhookHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (BROADCAST_HOSTS.has(u.host)) return true;
    // Teams Workflow webhook hosts are regional (e.g. prod-23.westus.logic.azure.com).
    if (u.host.endsWith('.logic.azure.com') && u.host.startsWith('prod-')) return true;
    return false;
  } catch {
    return false;
  }
}

app.post('/api/broadcast', async (req, res) => {
  try {
    const { platform, webhookUrl, payload } = req.body || {};
    if (!['slack', 'teams'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be slack or teams' });
    }
    if (!webhookUrl || !isAllowedWebhookHost(webhookUrl)) {
      return res.status(400).json({ error: 'webhookUrl must be an https Slack or Teams webhook' });
    }
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'payload must be an object' });
    }
    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error('[broadcast]', platform, upstream.status, text.slice(0, 200));
      return res.status(502).json({ error: `${platform} webhook responded ${upstream.status}`, detail: text.slice(0, 200) });
    }
    res.json({ ok: true, platform });
  } catch (err) {
    console.error('[broadcast] fatal:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Dev.Report OS → http://localhost:${PORT}`);
});
