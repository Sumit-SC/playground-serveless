/**
 * Background job scraper — runs headless scrapers and saves to Vercel KV.
 * Call this periodically (cron, Vercel Cron, or manual) to refresh cached jobs.
 * 
 * Usage: GET /api/jobs-scraper-background?force=1
 * 
 * Requires: ENABLE_HEADLESS=1, KV_REST_API_URL, KV_REST_API_TOKEN (Vercel KV env vars)
 */

const { kv } = require('@vercel/kv');

const CACHE_KEY = 'jobs:scraped:all';
const CACHE_TTL = 3600; // 1 hour

function enabled() {
	return String(process.env.ENABLE_HEADLESS || '').trim() === '1';
}

function hasKv() {
	return process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	if (req.method === 'OPTIONS') return res.status(200).end();
	
	if (!enabled()) {
		return res.status(200).json({
			ok: false,
			note: 'Headless scraping disabled. Set ENABLE_HEADLESS=1 to enable.'
		});
	}
	
	if (!hasKv()) {
		return res.status(200).json({
			ok: false,
			note: 'Vercel KV not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN env vars.'
		});
	}
	
	const proto = (req.headers['x-forwarded-proto'] || 'https');
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	const baseUrl = (host && (proto + '://' + host)) || '';
	
	if (!baseUrl) {
		return res.status(500).json({ ok: false, error: 'Cannot determine base URL' });
	}
	
	const q = (req.query && req.query.q) ? String(req.query.q).trim() : 'data analyst';
	
	try {
		// Fetch from mainstream boards: multi (Hirist, Naukri) + optional Indeed
		const multiRes = await fetch(baseUrl + '/api/headless-scrape-multi?site=all&q=' + encodeURIComponent(q));
		const multi = await multiRes.json();
		
		let allJobs = Array.isArray(multi.jobs) ? multi.jobs : [];
		const sources = Array.isArray(multi.sources) ? [...multi.sources] : [];
		
		// Optionally add Indeed (mainstream global board)
		try {
			const indeedRes = await fetch(baseUrl + '/api/headless-scrape-indeed?q=' + encodeURIComponent(q) + '&l=remote');
			const indeed = await indeedRes.json();
			if (indeed && indeed.ok && Array.isArray(indeed.jobs) && indeed.jobs.length > 0) {
				indeed.jobs.forEach((j) => allJobs.push({ ...j, source: 'indeed_headless' }));
				if (!sources.includes('indeed_headless')) sources.push('indeed_headless');
			}
		} catch (e) { /* Indeed optional; may block */ }
		
		if (allJobs.length === 0 && (!multi || !multi.ok)) {
			return res.status(200).json({
				ok: false,
				error: 'Multi-scraper failed',
				details: multi
			});
		}
		
		// Save to KV with TTL
		await kv.setex(CACHE_KEY, CACHE_TTL, {
			jobs: allJobs,
			sources,
			scrapedAt: new Date().toISOString(),
			count: allJobs.length
		});
		
		return res.status(200).json({
			ok: true,
			count: allJobs.length,
			sources,
			cached: true,
			cacheKey: CACHE_KEY,
			ttl: CACHE_TTL
		});
	} catch (e) {
		return res.status(500).json({
			ok: false,
			error: 'Background scraper failed',
			message: e.message
		});
	}
};
