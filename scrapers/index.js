import { scrapeDevpost } from './devpost.js';
import { scrapeMeetup } from './meetup.js';

const ADAPTERS = [
  { name: 'devpost', fn: scrapeDevpost, enabled: true },
  { name: 'meetup',  fn: scrapeMeetup,  enabled: true },
  // Disabled stubs — each needs work to enable:
  //   eventbrite — requires Private Token (free tier OK)
  //   lu.ma      — HTML scrape (no public API), needs cheerio + tolerance
  //   egjug      — HTML scrape against egjug.org
  //   gdg        — JSON endpoint exists but ignores date filters
];

const TIMEOUT_MS = 20000;

export async function scrapeAll(filters = {}) {
  const active = ADAPTERS.filter(a => a.enabled);
  const t0 = Date.now();

  const settled = await Promise.allSettled(
    active.map(async a => {
      const { events } = await withTimeout(a.fn(filters), TIMEOUT_MS);
      return { name: a.name, events: events || [] };
    })
  );

  const sources = [];
  const all = [];
  settled.forEach((r, i) => {
    const name = active[i].name;
    if (r.status === 'fulfilled') {
      sources.push({ name, ok: true, count: r.value.events.length });
      all.push(...r.value.events);
    } else {
      const msg = r.reason?.message || String(r.reason);
      sources.push({ name, ok: false, error: msg });
      console.warn(`[scrape:${name}] failed:`, msg);
    }
  });

  // Dedupe by URL
  const seen = new Set();
  const events = all.filter(e => {
    if (!e.url || seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  // Only keep future-dated events
  const today = new Date().toISOString().split('T')[0];
  const future = events.filter(e => e.date >= today);

  console.log(`[scrape] filters=${JSON.stringify(filters)} → ${future.length} events from ${sources.filter(s=>s.ok).length}/${sources.length} sources in ${Date.now()-t0}ms`);
  return { events: future, sources, filters, scraped_at: new Date().toISOString() };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))
  ]);
}
