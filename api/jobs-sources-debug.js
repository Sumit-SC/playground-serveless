/**
 * Debug endpoint to check which sources are actually working.
 * 
 * Usage: GET /api/jobs-sources-debug
 * 
 * Tests each source individually and reports success/failure.
 */

const DEFAULT_DAYS = 7;
const TIMEOUT_MS = 12_000;
const RSS_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; JobAggregator/1.0; +https://github.com)';

async function fetchJson(url, opts = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
	try {
		const r = await fetch(url, {
			signal: ctrl.signal,
			headers: {
				'User-Agent': USER_AGENT,
				'Accept': opts.accept || 'application/json',
				...(opts.headers || {})
			}
		});
		if (!r.ok) return { ok: false, status: r.status, error: 'HTTP ' + r.status };
		return { ok: true, data: await r.json() };
	} catch (e) {
		return { ok: false, error: e.message };
	} finally {
		clearTimeout(t);
	}
}

async function testRemoteOK() {
	const result = await fetchJson('https://remoteok.com/api', { timeout: TIMEOUT_MS });
	if (!result.ok) return { source: 'remoteok', ok: false, error: result.error };
	const data = result.data;
	const list = Array.isArray(data) ? data : (data && Array.isArray(data.jobs) ? data.jobs : []);
	return { source: 'remoteok', ok: true, count: list.length, sample: list.slice(0, 2).map(j => j.position) };
}

async function testRemotive() {
	const result = await fetchJson('https://remotive.com/api/remote-jobs?search=data%20analyst', { timeout: TIMEOUT_MS });
	if (!result.ok) return { source: 'remotive', ok: false, error: result.error };
	const data = result.data;
	const jobs = data && (data.jobs || data['remote-jobs'] || data.results);
	return { source: 'remotive', ok: true, count: Array.isArray(jobs) ? jobs.length : 0, sample: Array.isArray(jobs) ? jobs.slice(0, 2).map(j => j.title) : [] };
}

async function testRssFeed(name, url) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), RSS_TIMEOUT_MS);
	try {
		const r = await fetch(url, {
			signal: ctrl.signal,
			headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/atom+xml, text/xml, */*' }
		});
		clearTimeout(t);
		if (!r.ok) return { source: name, ok: false, error: 'HTTP ' + r.status };
		const xml = await r.text();
		const items = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || xml.match(/<entry[^>]*>[\s\S]*?<\/entry>/gi) || [];
		return { source: name, ok: true, count: items.length, url };
	} catch (e) {
		return { source: name, ok: false, error: e.message };
	}
}

async function testWorkingNomads(baseUrl) {
	if (!baseUrl) return { source: 'workingnomads', ok: false, error: 'No baseUrl' };
	const url = baseUrl.replace(/\/$/, '') + '/api/workingnomads?q=data%20analyst&count=10';
	const result = await fetchJson(url, { timeout: 15_000 });
	if (!result.ok) return { source: 'workingnomads', ok: false, error: result.error };
	const data = result.data;
	const jobs = data && data.ok && Array.isArray(data.jobs) ? data.jobs : [];
	return { source: 'workingnomads', ok: true, count: jobs.length, sample: jobs.slice(0, 2).map(j => j.title) };
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') return res.status(200).end();
	
	const proto = (req.headers['x-forwarded-proto'] || 'https');
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	const baseUrl = (host && (proto + '://' + host)) || '';
	
	const results = {
		api: [],
		rss: [],
		proxy: []
	};
	
	// Test APIs
	results.api.push(await testRemoteOK());
	results.api.push(await testRemotive());
	
	// Test RSS feeds
	const rssFeeds = [
		{ name: 'remotive', url: 'https://remotive.com/feed' },
		{ name: 'weworkremotely', url: 'https://weworkremotely.com/remote-jobs.rss' },
		{ name: 'jobscollider', url: 'https://jobscollider.com/remote-jobs.rss' },
		{ name: 'remoteok', url: 'https://remoteok.com/remote-jobs.rss' },
		{ name: 'wellfound', url: 'https://wellfound.com/jobs.rss?keywords=data-analyst&remote=true' },
		{ name: 'indeed', url: 'https://rss.indeed.com/rss?q=data+analyst&l=remote&radius=0' }
	];
	
	for (const feed of rssFeeds) {
		results.rss.push(await testRssFeed(feed.name, feed.url));
	}
	
	// Test proxy APIs
	if (baseUrl) {
		results.proxy.push(await testWorkingNomads(baseUrl));
	}
	
	const summary = {
		api: { total: results.api.length, working: results.api.filter(r => r.ok).length },
		rss: { total: results.rss.length, working: results.rss.filter(r => r.ok).length },
		proxy: { total: results.proxy.length, working: results.proxy.filter(r => r.ok).length }
	};
	
	return res.status(200).json({
		ok: true,
		summary,
		results,
		timestamp: new Date().toISOString()
	});
};
