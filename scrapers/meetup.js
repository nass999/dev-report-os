/*
 * Meetup adapter — scrapes the public /find HTML page and extracts events from
 * the embedded __NEXT_DATA__ Apollo store. No auth required.
 *
 * Honors `tech` (first term used as keyword) and `location` (mapped to Meetup's
 * "us--<state>--<city>" slug when known, else passed through best-effort).
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Known city → Meetup location slug (URL-safe dashed form). Extend as needed.
const CITY_SLUGS = {
  'san francisco': 'us--ca--san-francisco',
  'sf':            'us--ca--san-francisco',
  'new york':      'us--ny--new-york',
  'nyc':           'us--ny--new-york',
  'los angeles':   'us--ca--los-angeles',
  'la':            'us--ca--los-angeles',
  'seattle':       'us--wa--seattle',
  'austin':        'us--tx--austin',
  'boston':        'us--ma--boston',
  'chicago':       'us--il--chicago',
  'london':        'gb--17--london',
  'berlin':        'de--16--berlin',
  'amsterdam':     'nl--7--amsterdam',
  'singapore':     'sg--01--singapore',
  'bangalore':     'in--19--bengaluru',
  'dubai':         'ae--03--dubai',
  'cairo':         'eg--11--cairo',
};

export async function scrapeMeetup({ tech = '', location = '' } = {}) {
  const keyword = (tech.split(',')[0] || '').trim();
  if (!keyword) {
    // Meetup's /find page is keyword-driven; without one it's a noisy global feed.
    return { events: [] };
  }
  const slug = resolveLocationSlug(location);
  const params = new URLSearchParams({ keywords: keyword, source: 'EVENTS' });
  if (slug) params.set('location', slug);
  const url = `https://www.meetup.com/find/?${params.toString()}`;

  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error(`meetup HTTP ${r.status}`);
  const html = await r.text();

  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('meetup: __NEXT_DATA__ not found');
  const data = JSON.parse(decodeHtmlEntities(m[1]));
  const store = data?.props?.pageProps?.__APOLLO_STATE__ || {};
  const deref = (v) => (v && typeof v === 'object' && v.__ref) ? (store[v.__ref] || {}) : (v || {});

  const kwLower = keyword.toLowerCase();
  const events = [];
  for (const [key, e] of Object.entries(store)) {
    if (!key.startsWith('Event:')) continue;
    if (!e?.title || !e?.dateTime || !e?.eventUrl) continue;

    const group = deref(e.group);
    const venue = deref(e.venue);
    const hay = `${e.title} ${group.name || ''} ${e.description || ''}`.toLowerCase();
    if (!hay.includes(kwLower)) continue;            // drop noise that doesn't actually mention keyword

    const date = e.dateTime.split('T')[0];
    if (date < new Date().toISOString().split('T')[0]) continue;

    const isOnline = e.eventType === 'ONLINE';
    const locStr = isOnline ? 'Online'
      : [venue.city, venue.state].filter(Boolean).join(', ') || location || 'TBD';

    events.push({
      id: `meetup-${e.id || key.split(':')[1]}`,
      name: e.title.trim(),
      date,
      technology: [keyword[0].toUpperCase() + keyword.slice(1)],
      location: locStr,
      medium: isOnline ? 'Virtual' : 'Physical',
      url: e.eventUrl,
      source: 'meetup.com',
      status: 'pending',
      tracked: false,
      metrics: { spend: 0, signups: 0, engagements: 0, outcome: null, notes: '' }
    });
  }
  return { events };
}

function resolveLocationSlug(loc) {
  if (!loc) return null;
  const k = loc.toLowerCase().replace(/,.*$/, '').trim();   // "San Francisco, CA" → "san francisco"
  if (CITY_SLUGS[k]) return CITY_SLUGS[k];
  // Unknown city — pass through; Meetup will mostly ignore and return global keyword feed.
  return null;
}

function decodeHtmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
