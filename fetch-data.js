const KEY = process.env.FEC_API_KEY || "tPKgQ8WnMDRqrqMzfzLgd6KfmN7t8wMH9WNbcqpJ";
const BASE = "https://api.open.fec.gov/v1";
const fs = require("fs");

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCycle(cycle) {
  console.log(`Fetching ${cycle} cycle...`);
  const d = await fetchJSON(`${BASE}/candidates/totals/?api_key=${KEY}&party=REP&office=H&cycle=${cycle}&election_year=${cycle}&is_active_candidate=true&sort_by=-receipts&per_page=100&page=1`);
  if (!d.results) return [];
  let results = d.results;
  const pages = d.pagination ? d.pagination.pages : 1;
  for (let p = 2; p <= Math.min(pages, 20); p++) {
    console.log(`  page ${p}/${pages}`);
    const d2 = await fetchJSON(`${BASE}/candidates/totals/?api_key=${KEY}&party=REP&office=H&cycle=${cycle}&election_year=${cycle}&is_active_candidate=true&sort_by=-receipts&per_page=100&page=${p}`);
    if (d2.results) results = results.concat(d2.results);
    await sleep(300);
  }
  // Deduplicate
  const seen = {};
  results.forEach(c => { if (!seen[c.candidate_id] || (c.receipts||0) > (seen[c.candidate_id].receipts||0)) seen[c.candidate_id] = c; });
  const uniq = Object.values(seen);
  console.log(`  ${uniq.length} candidates`);
  return uniq;
}

async function fetchReports(candidates, cycle) {
  console.log(`Fetching ${cycle} quarterly reports...`);
  const reports = {};
  const RL = {Q1:"Q1",Q2:"Q2",Q3:"Q3",Q4:"Q4","12P":"Pre-Primary","12C":"Pre-Convention","12G":"Pre-General","30G":"Post-General",YE:"Year-End"};
  for (let i = 0; i < candidates.length; i += 20) {
    const batch = candidates.slice(i, i + 20);
    const ids = batch.map(c => "candidate_id=" + c.candidate_id).join("&");
    console.log(`  batch ${Math.floor(i/20)+1}/${Math.ceil(candidates.length/20)}`);
    try {
      const d = await fetchJSON(`${BASE}/reports/house-senate/?api_key=${KEY}&${ids}&cycle=${cycle}&per_page=100&sort_by=-coverage_end_date`);
      if (d.results) {
        d.results.forEach(rpt => {
          const cid = rpt.candidate_id;
          if (!reports[cid]) reports[cid] = [];
          const rt = rpt.report_type || "";
          const year = rpt.coverage_end_date ? rpt.coverage_end_date.substring(0, 4) : "";
          const label = (RL[rt] || rt) + " " + year;
          if (!reports[cid].find(p => p.label === label)) {
            reports[cid].push({ label, raised: rpt.total_receipts || rpt.receipts || 0, coh: rpt.cash_on_hand_end_period || 0 });
          }
        });
      }
    } catch (e) { console.log("  batch error:", e.message); }
    await sleep(400);
  }
  return reports;
}

async function main() {
  const data = { updated: new Date().toISOString(), cycles: {} };
  
  for (const cycle of [2026, 2024, 2022, 2020, 2018, 2016, 2014, 2012]) {
    data.cycles[cycle] = await fetchCycle(cycle);
    await sleep(500);
  }
  
  // Quarterly reports for recent cycles
  for (const cycle of [2026, 2024]) {
    if (data.cycles[cycle] && data.cycles[cycle].length) {
      const incumbents = data.cycles[cycle].filter(c => c.incumbent_challenge === "I" || (c.receipts||0) > 100000);
      data.cycles[cycle + "_reports"] = await fetchReports(incumbents, cycle);
    }
  }
  
  fs.writeFileSync("data.json", JSON.stringify(data));
  console.log("Done. data.json written.");
}

main().catch(e => { console.error(e); process.exit(1); });
