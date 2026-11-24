const FEC_KEY = "tPKgQ8WnMDRqrqMzfzLgd6KfmN7t8wMH9WNbcqpJ";
const BASE = "https://api.open.fec.gov/v1";
const REPO = "TJHolden/fec-dashboard";

export const config = { maxDuration: 300 };

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
  const d = await fetchJSON(`${BASE}/candidates/totals/?api_key=${FEC_KEY}&party=REP&office=H&cycle=${cycle}&sort_by=-receipts&per_page=100&page=1`);
  if (!d.results) return [];
  let results = d.results;
  const pages = d.pagination ? d.pagination.pages : 1;
  for (let p = 2; p <= Math.min(pages, 20); p++) {
    await sleep(500);
    try {
      const d2 = await fetchJSON(`${BASE}/candidates/totals/?api_key=${FEC_KEY}&party=REP&office=H&cycle=${cycle}&sort_by=-receipts&per_page=100&page=${p}`);
      if (d2.results) results = results.concat(d2.results);
    } catch (e) {}
  }
  const seen = {};
  results.forEach(c => { if (!seen[c.candidate_id] || (c.receipts||0) > (seen[c.candidate_id].receipts||0)) seen[c.candidate_id] = c; });
  return Object.values(seen);
}

async function fetchReportsBatch(candidates, cycle, startIdx, maxTime) {
  const RL = {Q1:"Q1",Q2:"Q2",Q3:"Q3",Q4:"Q4","12P":"Pre-Primary","12C":"Pre-Convention","12G":"Pre-General","30G":"Post-General",YE:"Year-End",MY:"Mid-Year"};
  const reports = {};
  const deadline = Date.now() + maxTime;
  const cyclesToFetch = [cycle, cycle - 2];
  let processed = startIdx;
  
  for (const cy of cyclesToFetch) {
    for (let i = (cy === cycle ? startIdx : 0); i < candidates.length; i++) {
      if (Date.now() > deadline) return { reports, processed, done: false };
      const cid = candidates[i].candidate_id;
      try {
        const d = await fetchJSON(`${BASE}/reports/house-senate/?api_key=${FEC_KEY}&candidate_id=${cid}&cycle=${cy}&per_page=100&sort_by=-coverage_end_date`);
        if (d.results && d.results.length) {
          if (!reports[cid]) reports[cid] = [];
          d.results.forEach(rpt => {
            const rt = rpt.report_type || "";
            const year = rpt.coverage_end_date ? rpt.coverage_end_date.substring(0, 4) : "";
            const label = (RL[rt] || rt) + " " + year;
            if (!reports[cid].find(p => p.label === label)) {
              reports[cid].push({ label, raised: rpt.total_receipts_period || 0, coh: rpt.cash_on_hand_end_period || 0, spent: rpt.total_disbursements_period || 0, indiv: +(rpt.total_individual_contributions_period) || 0, pac: rpt.other_political_committee_contributions_period || 0, end: rpt.coverage_end_date || "" });
            }
          });
        }
      } catch (e) {}
      await sleep(500);
      processed = i + 1;
    }
  }
  Object.keys(reports).forEach(k => { reports[k].sort((a, b) => (b.end || "").localeCompare(a.end || "")); });
  return { reports, processed, done: true };
}

async function getExistingData(ghToken) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/data.json`, { headers: { Authorization: "Bearer " + ghToken } });
    if (r.ok) {
      const d = await r.json();
      return { data: JSON.parse(Buffer.from(d.content, "base64").toString()), sha: d.sha };
    }
  } catch (e) {}
  return { data: { updated: new Date().toISOString(), cycles: {} }, sha: null };
}

async function commitToGitHub(data, ghToken, sha) {
  const content = Buffer.from(JSON.stringify(data)).toString("base64");
  const body = { message: "Auto-update FEC data " + new Date().toISOString().split("T")[0], content };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/data.json`, {
    method: "PUT", headers: { Authorization: "Bearer " + ghToken, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("GitHub commit failed: " + r.status);
  const d = await r.json();
  return d.content ? d.content.sha : sha;
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== "Bearer " + cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GITHUB_TOKEN not set" });
  
  const startTime = Date.now();
  
  try {
    // Load existing data
    const { data, sha: existingSha } = await getExistingData(ghToken);
    
    // Determine current cycle
    const currentYear = new Date().getFullYear();
    const cycle = currentYear % 2 === 0 ? currentYear : currentYear + 1;
    
    // Update candidates for current cycle
    data.cycles[cycle] = await fetchCycle(cycle);
    data.updated = new Date().toISOString();
    
    // Commit candidates immediately
    let sha = await commitToGitHub(data, ghToken, existingSha);
    
    // Now fetch quarterly reports with remaining time (leave 30s buffer)
    const timeLeft = 300000 - (Date.now() - startTime) - 30000;
    if (timeLeft > 60000) {
      const inc = (data.cycles[cycle] || []).filter(c => c.incumbent_challenge === "I" || (c.receipts || 0) > 50000);
      
      // Merge with existing reports (don't lose old data)
      const existingReports = data.cycles[cycle + "_reports"] || {};
      const { reports, processed, done } = await fetchReportsBatch(inc, cycle, 0, timeLeft);
      
      // Merge new reports with existing
      Object.keys(reports).forEach(cid => { existingReports[cid] = reports[cid]; });
      data.cycles[cycle + "_reports"] = existingReports;
      data.updated = new Date().toISOString();
      
      sha = await commitToGitHub(data, ghToken, sha);
      
      res.json({ ok: true, cycle, candidates: (data.cycles[cycle] || []).length, reportsProcessed: processed, reportsDone: done, totalReports: Object.keys(existingReports).length });
    } else {
      res.json({ ok: true, cycle, candidates: (data.cycles[cycle] || []).length, note: "No time for quarterly update" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
