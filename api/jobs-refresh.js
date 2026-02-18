/**
 * Trigger fresh scraping of all job portals.
 * This endpoint triggers headless scraping and stores results in KV.
 * 
 * Usage: GET /api/jobs-refresh?q=data+analyst&days=3&location=remote
 * 
 * This endpoint calls headless-scrape-all-portals and waits for completion.
 * Use /api/jobs-cached to get cached results quickly.
 */

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') return res.status(200).end();
	
	const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
	const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
	const baseUrl = host ? (proto + '://' + host) : '';
	
	if (!baseUrl) {
		return res.status(500).json({ ok: false, error: 'Cannot determine base URL' });
	}
	
	const q = (req.query && req.query.q) ? String(req.query.q).trim() : 'data analyst';
	const days = (req.query && req.query.days) ? parseInt(String(req.query.days), 10) : 3;
	const location = (req.query && req.query.location) ? String(req.query.location).trim() : 'remote';
	
	// Call the scraper endpoint (this will take 30-60 seconds)
	const scrapeUrl = baseUrl + '/api/headless-scrape-all-portals?q=' + encodeURIComponent(q) + '&days=' + days + '&location=' + encodeURIComponent(location) + '&force=1';
	
	try {
		const response = await fetch(scrapeUrl);
		const data = await response.json();
		
		return res.status(200).json({
			ok: true,
			message: 'Scraping completed',
			query: q,
			days,
			location,
			result: data,
			note: 'Results are cached. Use /api/jobs-cached for fast access.'
		});
	} catch (e) {
		return res.status(500).json({
			ok: false,
			error: 'Scraping failed',
			message: e.message,
			note: 'Check /api/headless-scrape-all-portals directly or try again later'
		});
	}
};
