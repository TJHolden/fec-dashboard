const FEC_KEY = "tPKgQ8WnMDRqrqMzfzLgd6KfmN7t8wMH9WNbcqpJ";
const BASE = "https://api.open.fec.gov/v1";

let cache = {};

async function fetchJSON(url) {
  const r = await fetch(url);
  if (r.status === 429) {
    await new Promise(r => setTimeout(r, 10000));
    const r2 = await fetch(url);
    if (!r2.ok) throw new Error("HTTP " + r2.status);
    return r2.json();
  }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCycle(cycle) {
  const d = await fetchJSON(`${BASE}/candidates/totals/?api_key=${FEC_KEY}&party=REP&office=H&cycle=${cycle}&election_year=${cycle}&is_active_candidate=true&sort_by=-receipts&per_page=100&page=1`);
  if (!d.results) return [];
  let results = d.results;
  const pages = d.pagination ? d.pagination.pages : 1;
  for (let p = 2; p <= Math.min(pages, 20); p++) {
    await sleep(400);
    try {
      const d2 = await fetchJSON(`${BASE}/candidates/totals/?api_key=${FEC_KEY}&party=REP&office=H&cycle=${cycle}&election_year=${cycle}&is_active_candidate=true&sort_by=-receipts&per_page=100&page=${p}`);
      if (d2.results) results = results.concat(d2.results);
    } catch (e) {}
  }
  const seen = {};
  results.forEach(c => { if (!seen[c.candidate_id] || (c.receipts||0) > (seen[c.candidate_id].receipts||0)) seen[c.candidate_id] = c; });
  return Object.values(seen);
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const cycle = parseInt(req.query.cycle) || 2026;
  
  const cacheKey = String(cycle);
  if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < 3600000) {
    res.setHeader("X-Cache", "HIT");
    return res.json(cache[cacheKey].data);
  }
  
  try {
    const candidates = await fetchCycle(cycle);
    const data = { updated: new Date().toISOString(), cycle, candidates };
    
    cache[cacheKey] = { ts: Date.now(), data };
    res.setHeader("X-Cache", "MISS");
    res.json(data);
  } catch (e) {
    // If we have stale cache, return it
    if (cache[cacheKey]) {
      res.setHeader("X-Cache", "STALE");
      return res.json(cache[cacheKey].data);
    }
    res.status(500).json({ error: e.message });
  }
}
