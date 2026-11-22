const FEC_KEY = "tPKgQ8WnMDRqrqMzfzLgd6KfmN7t8wMH9WNbcqpJ";
const BASE = "https://api.open.fec.gov/v1";

let cache = {};

async function fetchJSON(url) {
  const r = await fetch(url);
  if (r.status === 429) {
    await new Promise(r => setTimeout(r, 15000));
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
    await sleep(600);
    try {
      const d2 = await fetchJSON(`${BASE}/candidates/totals/?api_key=${FEC_KEY}&party=REP&office=H&cycle=${cycle}&election_year=${cycle}&is_active_candidate=true&sort_by=-receipts&per_page=100&page=${p}`);
      if (d2.results) results = results.concat(d2.results);
    } catch (e) {}
  }
  const seen = {};
  results.forEach(c => { if (!seen[c.candidate_id] || (c.receipts||0) > (seen[c.candidate_id].receipts||0)) seen[c.candidate_id] = c; });
  return Object.values(seen);
}

async function fetchReports(candidates, cycle) {
  const RL = {Q1:"Q1",Q2:"Q2",Q3:"Q3",Q4:"Q4","12P":"Pre-Primary","12C":"Pre-Convention","12G":"Pre-General","30G":"Post-General",YE:"Year-End","MY":"Mid-Year"};
  const reports = {};
  
  // Fetch reports for both the current cycle AND the prior cycle (2 years of data)
  const cyclesToFetch = [cycle, cycle - 2];
  
  for (const cy of cyclesToFetch) {
    for (let i = 0; i < candidates.length; i += 20) {
      const batch = candidates.slice(i, i + 20);
      const ids = batch.map(c => "candidate_id=" + c.candidate_id).join("&");
      try {
        const d = await fetchJSON(`${BASE}/reports/house-senate/?api_key=${FEC_KEY}&${ids}&cycle=${cy}&per_page=100&sort_by=-coverage_end_date`);
        if (d.results) {
          d.results.forEach(rpt => {
            const cid = rpt.candidate_id;
            if (!reports[cid]) reports[cid] = [];
            const rt = rpt.report_type || "";
            const year = rpt.coverage_end_date ? rpt.coverage_end_date.substring(0, 4) : "";
            const label = (RL[rt] || rt) + " " + year;
            if (!reports[cid].find(p => p.label === label)) {
              reports[cid].push({ 
                label, 
                raised: rpt.receipts || 0, 
                coh: rpt.cash_on_hand_end_period || 0,
                end: rpt.coverage_end_date || ""
              });
            }
          });
        }
      } catch (e) {}
      await sleep(600);
    }
    await sleep(2000);
  }
  
  // Sort each candidate's periods by date (most recent first)
  Object.keys(reports).forEach(cid => {
    reports[cid].sort((a, b) => (b.end || "").localeCompare(a.end || ""));
  });
  
  return reports;
}

export default async function handler(req, res) {
  const cycle = parseInt(req.query.cycle) || 2026;
  const includeReports = req.query.reports !== "false";
  
  const cacheKey = cycle + (includeReports ? "_full" : "");
  if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < 3600000) {
    res.setHeader("X-Cache", "HIT");
    return res.json(cache[cacheKey].data);
  }
  
  try {
    const candidates = await fetchCycle(cycle);
    const data = { updated: new Date().toISOString(), cycle, candidates };
    
    if (includeReports && candidates.length) {
      const inc = candidates.filter(c => c.incumbent_challenge === "I" || (c.receipts||0) > 50000);
      data.reports = await fetchReports(inc, cycle);
    }
    
    cache[cacheKey] = { ts: Date.now(), data };
    res.setHeader("X-Cache", "MISS");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
