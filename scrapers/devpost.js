const BASE = 'https://devpost.com/api/hackathons';
const UA = 'Dev.Report OS/1.0 (+https://localhost)';

export async function scrapeDevpost({ tech = '' } = {}) {
  const params = new URLSearchParams();
  params.append('status[]', 'upcoming');
  params.append('status[]', 'open');
  params.set('order_by', 'deadline');
  const keyword = (tech.split(',')[0] || '').trim();
  if (keyword) params.set('search', keyword);

  const r = await fetch(`${BASE}?${params.toString()}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`devpost HTTP ${r.status}`);
  const json = await r.json();
  const list = json.hackathons || [];
  return { events: list.map(normalize).filter(Boolean) };
}

function normalize(h) {
  if (!h?.url || !h?.title) return null;
  const date = parseEndDate(h.submission_period_dates) || todayPlus(14);
  const locStr = h?.displayed_location?.location || 'Online';
  const isOnline = /online/i.test(locStr) || h?.displayed_location?.icon === 'globe';
  const themes = Array.isArray(h.themes) ? h.themes.map(t => t.name).filter(Boolean) : [];
  return {
    id: `devpost-${h.id}`,
    name: h.title,
    date,
    technology: themes.slice(0, 5),
    location: locStr,
    medium: isOnline ? 'Virtual' : 'Physical',
    url: h.url,
    source: 'devpost.com',
    status: 'pending',
    tracked: false,
    metrics: { spend: 0, signups: 0, engagements: 0, outcome: null, notes: '' }
  };
}

// Parses Devpost's "submission_period_dates" strings such as:
//   "Apr 12 - May 15, 2026"     → 2026-05-15
//   "May 03 - 15, 2026"         → 2026-05-15 (bare day inherits month)
//   "Dec 28, 2025 - Jan 5, 2026"→ 2026-01-05
//   "Jan 31, 2026"              → 2026-01-31
function parseEndDate(s) {
  if (!s || typeof s !== 'string') return null;
  const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const years = [...s.matchAll(/\b(\d{4})\b/g)].map(m => +m[1]);
  const year = years.length ? years[years.length - 1] : new Date().getUTCFullYear();
  const stripped = s.replace(/\b\d{4}\b/g, ' ');
  const tokens = [...stripped.matchAll(/([A-Z][a-z]{2})\s+(\d{1,2})|(\d{1,2})/g)];
  let curMonth = null, lastDay = null;
  for (const t of tokens) {
    if (t[1]) { curMonth = t[1]; lastDay = +t[2]; }
    else if (t[3] && curMonth) { lastDay = +t[3]; }
  }
  if (!curMonth || !lastDay) return null;
  const mIdx = MONTHS[curMonth];
  if (mIdx === undefined) return null;
  const d = new Date(Date.UTC(year, mIdx, lastDay));
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
