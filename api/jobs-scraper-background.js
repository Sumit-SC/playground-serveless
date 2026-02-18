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
	
	try {
		// Fetch from multi-scraper
		const multiRes = await fetch(baseUrl + '/api/headless-scrape-multi?site=all');
		const multi = await multiRes.json();
		
		if (!multi || !multi.ok || !Array.isArray(multi.jobs)) {
			return res.status(200).json({
				ok: false,
				error: 'Multi-scraper failed',
				details: multi
			});
		}
		
		// Save to KV with TTL
		await kv.setex(CACHE_KEY, CACHE_TTL, {
			jobs: multi.jobs,
			sources: multi.sources || [],
			scrapedAt: new Date().toISOString(),
			count: multi.count || multi.jobs.length
		});
		
		return res.status(200).json({
			ok: true,
			count: multi.jobs.length,
			sources: multi.sources,
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
