/**
 * Fast cached jobs API - serves scraped jobs from Vercel KV.
 * This endpoint is fast (no scraping) and returns cached results.
 * 
 * Usage: GET /api/jobs-cached?q=data+analyst
 * 
 * Returns cached jobs from headless scraping (stored by headless-scrape-all-portals).
 * If cache is empty or expired, returns empty array (call /api/headless-scrape-all-portals?force=1 to refresh).
 */

const { kv } = require('@vercel/kv');

const CACHE_KEY = 'jobs:scraped:all-portals';

function hasKv() {
	return process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
	if (req.method === 'OPTIONS') return res.status(200).end();
	
	if (!hasKv()) {
		return res.status(200).json({
			ok: false,
			count: 0,
			jobs: [],
			note: 'Vercel KV not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN env vars.'
		});
	}
	
	try {
		const cached = await kv.get(CACHE_KEY);
		if (!cached || !cached.jobs || !Array.isArray(cached.jobs)) {
			return res.status(200).json({
				ok: true,
				count: 0,
				jobs: [],
				cached: false,
				note: 'No cached jobs found. Call /api/headless-scrape-all-portals?force=1 to scrape fresh data.'
			});
		}
		
		// Filter by query if provided
		const q = (req.query && req.query.q) ? String(req.query.q).toLowerCase().trim() : '';
		let jobs = cached.jobs;
		if (q) {
			jobs = jobs.filter(job => {
				const title = String(job.title || '').toLowerCase();
				const company = String(job.company || '').toLowerCase();
				return title.includes(q) || company.includes(q);
			});
		}
		const sources = Array.from(new Set(jobs.map(j => j.source).filter(Boolean))).sort();
		const sourceCounts = {};
		jobs.forEach(j => {
			const src = j.source || 'unknown';
			sourceCounts[src] = (sourceCounts[src] || 0) + 1;
		});
		return res.status(200).json({
			ok: true,
			count: jobs.length,
			jobs,
			sources,
			sourceCounts,
			cached: true,
			scrapedAt: cached.scrapedAt,
			query: cached.query || '',
			days: cached.days || 3,
			location: cached.location || 'remote',
			totalCached: cached.jobs.length
		});
	} catch (e) {
		return res.status(500).json({
			ok: false,
			error: 'Failed to fetch cached jobs',
			message: e.message
		});
	}
};
