const FEC_KEY = "tPKgQ8WnMDRqrqMzfzLgd6KfmN7t8wMH9WNbcqpJ";

export default async function handler(req, res) {
  // Fetch Yakym's reports to see all field names
  const url = "https://api.open.fec.gov/v1/reports/house-senate/?api_key=" + FEC_KEY + "&candidate_id=H2IN02295&cycle=2026&per_page=1&sort_by=-coverage_end_date";
  const r = await fetch(url);
  const d = await r.json();
  if (d.results && d.results.length) {
    // Return all fields from the first report
    res.json({ fields: Object.keys(d.results[0]).sort(), sample: d.results[0] });
  } else {
    res.json({ error: "no results", raw: d });
  }
}
