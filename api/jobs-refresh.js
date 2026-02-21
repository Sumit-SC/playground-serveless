/**
 * Trigger fresh job fetch: headless (if enabled) or snapshot aggregation (RSS + RemoteOK + Remotive + WorkingNomads).
 * Stores results in KV when available so /api/jobs-snapshot can merge cached jobs.
 *
 * Usage: GET /api/jobs-refresh?q=data+analyst&days=3&location=remote
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
	const limit = Math.min(400, parseInt(String(req.query.limit || '400'), 10) || 400);

	const headlessEnabled = String(process.env.ENABLE_HEADLESS || '').trim() === '1';
	let jobs = [];
	let result = null;
	let fromSnapshot = false;

	if (headlessEnabled) {
		try {
			const scrapeUrl = baseUrl + '/api/headless-scrape-all-portals?q=' + encodeURIComponent(q) + '&days=' + days + '&location=' + encodeURIComponent(location) + '&force=1';
			const response = await fetch(scrapeUrl, { signal: AbortSignal.timeout(90000) });
			result = await response.json();
			if (result && result.ok && Array.isArray(result.jobs)) {
				jobs = result.jobs;
			}
		} catch (e) {
			// Fall through to snapshot
		}
	}

	if (jobs.length === 0) {
		// Use snapshot aggregation (RSS + RemoteOK + Remotive + WorkingNomads) so refresh always returns data
		try {
			const snapshotUrl = baseUrl + '/api/jobs-snapshot?q=' + encodeURIComponent(q) + '&days=' + days + '&limit=' + limit + '&location=' + encodeURIComponent(location);
			const snapRes = await fetch(snapshotUrl, { signal: AbortSignal.timeout(45000) });
			const snapData = await snapRes.json();
			if (snapData && snapData.ok && Array.isArray(snapData.jobs)) {
				jobs = snapData.jobs;
				result = snapData;
				fromSnapshot = true;
				// Cache for jobs-snapshot to merge on next request
				if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
					try {
						const { kv } = require('@vercel/kv');
						await kv.set('jobs:scraped:all', {
							jobs,
							sources: snapData.sources || [],
							sourceCounts: snapData.sourceCounts || {},
							fetchedAt: Date.now()
						});
					} catch (kvErr) { /* KV optional */ }
				}
			}
		} catch (e) {
			return res.status(500).json({
				ok: false,
				error: 'Refresh failed',
				message: (e && e.message) || 'Snapshot fetch failed',
				note: 'Try /api/jobs-snapshot directly for RSS+API results.'
			});
		}
	}

	return res.status(200).json({
		ok: true,
		message: fromSnapshot ? 'Fetched from RSS + APIs (snapshot)' : 'Scraping completed',
		query: q,
		days,
		location,
		count: jobs.length,
		jobs,
		sources: result && result.sources ? result.sources : [],
		sourceCounts: result && result.sourceCounts ? result.sourceCounts : {},
		note: fromSnapshot ? 'Results from RemoteOK, Remotive, RSS feeds, WorkingNomads. Use /api/jobs-snapshot for same data.' : 'Results cached. Use /api/jobs-cached for fast access.'
	});
};
