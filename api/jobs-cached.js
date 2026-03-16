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

const CACHE_KEY = 'jobs:scraped:all';

function hasKv() {
	return process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
}

async function fetchSnapshotFallback(req) {
	try {
		const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
		const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
		const baseUrl = host ? (proto + '://' + host) : '';
		if (!baseUrl) return null;

		const q = (req.query && req.query.q) ? String(req.query.q).trim() : 'data analyst';
		const days = (req.query && req.query.days) ? parseInt(String(req.query.days), 10) : 7;
		const limit = Math.min(400, parseInt(String(req.query.limit || '180'), 10) || 180);
		const location = (req.query && req.query.location) ? String(req.query.location).trim() : 'remote';

		let url = baseUrl + '/api/jobs-snapshot?q=' + encodeURIComponent(q) + '&days=' + days + '&limit=' + limit + '&location=' + encodeURIComponent(location);
		if (req.query && req.query.sources) url += '&sources=' + encodeURIComponent(String(req.query.sources));

		const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
		if (!r.ok) return null;
		const data = await r.json();
		if (!data || !data.ok || !Array.isArray(data.jobs)) return null;
		return data;
	} catch (e) {
		return null;
	}
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
	if (req.method === 'OPTIONS') return res.status(200).end();
	
	if (!hasKv()) {
		// Free-tier friendly: if KV is not configured, fall back to snapshot so the UI still works.
		// This is not "cached" in KV, but it is still relatively fast and safe vs headless scrapes.
		const snap = await fetchSnapshotFallback(req);
		if (snap) {
			return res.status(200).json({
				ok: true,
				count: snap.jobs.length,
				jobs: snap.jobs,
				sources: snap.sources || [],
				sourceCounts: snap.sourceCounts || {},
				cached: false,
				note: 'KV not configured; served snapshot fallback from /api/jobs-snapshot.'
			});
		}
		return res.status(200).json({
			ok: false,
			count: 0,
			jobs: [],
			cached: false,
			note: 'Vercel KV not configured (KV_REST_API_URL/TOKEN missing) and snapshot fallback failed.'
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
