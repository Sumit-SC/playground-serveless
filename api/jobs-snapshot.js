/**
 * Jobs snapshot aggregator (fast, cached).
 * Goal: 1 request from the Jobs page -> get fresh jobs (last N days) from ~5-10 reliable sources.
 *
 * Usage:
 *   /api/jobs-snapshot?q=data%20science&days=7&limit=120
 *
 * Notes:
 * - Prefers RSS feeds through our /api/rss proxy
 * - Uses a couple of public JSON APIs where available
 * - Optional headless scrapers can be added later (see /api/headless-scrape-*)
 */

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 250;
const TIMEOUT_MS = 10_000;

// Role priority (Remote primary, India secondary)
// Tier 1: analyst/BI/analytics roles (as requested)
const ROLE_TIER_1 = [
	'data analyst',
	'senior data analyst',
	'senior analyst',
	'business analyst',
	'product analyst',
	'decision scientist',
	'bi developer',
	'business intelligence developer',
	'analytics engineer',
	'bi analyst',
	'analytics analyst'
];
// Tier 2: junior/associate DS then ML/DE
const ROLE_TIER_2 = [
	'junior data scientist',
	'associate data scientist',
	'data scientist',
	'ml engineer',
	'machine learning engineer',
	'data engineer'
];

function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

function nowIso() {
	return new Date().toISOString();
}

function parseDateLike(input) {
	if (!input) return null;
	const s = String(input).trim();
	if (!s) return null;
	const d = new Date(s);
	if (!isNaN(d.getTime())) return d;
	const m = s.toLowerCase().match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
	if (m) {
		const n = parseInt(m[1], 10);
		const unit = m[2];
		if (!isNaN(n)) {
			let ms = 0;
			if (unit === 'minute') ms = n * 60 * 1000;
			else if (unit === 'hour') ms = n * 60 * 60 * 1000;
			else if (unit === 'day') ms = n * 24 * 60 * 60 * 1000;
			else if (unit === 'week') ms = n * 7 * 24 * 60 * 60 * 1000;
			else if (unit === 'month') ms = n * 30 * 24 * 60 * 60 * 1000;
			else if (unit === 'year') ms = n * 365 * 24 * 60 * 60 * 1000;
			return new Date(Date.now() - ms);
		}
	}
	return null;
}

function normalizeJob(j) {
	return {
		id: j.id || ('job_' + Math.random().toString(36).slice(2)),
		title: j.title || 'Untitled',
		company: j.company || 'Unknown',
		location: j.location || 'Remote',
		url: j.url || '#',
		description: j.description || '',
		source: j.source || 'other',
		date: j.date || nowIso(),
		tags: Array.isArray(j.tags) ? j.tags : [],
		// Optional scoring metadata (kept for debugging / future UI)
		_rank: typeof j._rank === 'number' ? j._rank : 0,
		_roleTier: j._roleTier || ''
	};
}

async function fetchJson(url) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const r = await fetch(url, { signal: ctrl.signal });
		if (!r.ok) return null;
		return await r.json();
	} catch (e) {
		return null;
	} finally {
		clearTimeout(t);
	}
}

async function fetchRss(baseUrl, feedUrl, count) {
	const u = baseUrl + '/api/rss?url=' + encodeURIComponent(feedUrl) + '&count=' + (count || 50);
	const data = await fetchJson(u);
	if (!data || !data.ok || !Array.isArray(data.items)) return [];
	return data.items;
}

function containsAny(text, keywords) {
	const t = String(text || '').toLowerCase();
	for (let i = 0; i < keywords.length; i++) {
		if (t.includes(keywords[i])) return true;
	}
	return false;
}

function includesAnyPhrase(text, phrases) {
	const t = String(text || '').toLowerCase();
	for (let i = 0; i < phrases.length; i++) {
		const p = phrases[i];
		if (p && t.includes(p)) return p;
	}
	return '';
}

function locationRank(location) {
	const loc = String(location || '').toLowerCase();
	const isRemote = /(^|\b)(remote|work from home|wfh|anywhere|distributed)(\b|$)/.test(loc);

	// Priority 1: Remote – India (country or specific cities)
	const indiaCityRe = /(^|\b)(pune|mumbai|thane|navi mumbai|hyderabad|bangalore|bengaluru|chennai|delhi|delhi-ncr|gurgaon|noida)(\b|$)/;
	const indiaRe = /(^|\b)(india|in)(\b|$)/;

	if (isRemote && (indiaRe.test(loc) || indiaCityRe.test(loc))) {
		return 150; // remote India highest
	}

	// Priority 2: Remote – all countries
	if (isRemote) {
		return 120;
	}

	// Priority 3: India cities (on-site / hybrid in key Indian hubs)
	if (indiaCityRe.test(loc) || indiaRe.test(loc)) {
		return 80;
	}

	return 0;
}

function roleTierRank(title) {
	const t = String(title || '').toLowerCase();
	const hit1 = includesAnyPhrase(t, ROLE_TIER_1);
	if (hit1) return { tier: 'tier1', score: 200, hit: hit1 };
	const hit2 = includesAnyPhrase(t, ROLE_TIER_2);
	if (hit2) return { tier: 'tier2', score: 120, hit: hit2 };
	// Generic analyst-ish hints
	if (/(^|\b)(analyst|analytics|bi|business intelligence)(\b|$)/.test(t)) return { tier: 'tier3', score: 60, hit: 'analytics' };
	return { tier: 'other', score: 0, hit: '' };
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600'); // 15m
	if (req.method === 'OPTIONS') return res.status(200).end();

	// Default query tuned for analyst-heavy results (you can override with ?q=)
	const q = (req.query && req.query.q) ? String(req.query.q).trim() : 'data analyst';
	const days = clamp(parseInt(String((req.query && req.query.days) || DEFAULT_DAYS), 10) || DEFAULT_DAYS, 1, 30);
	const limit = clamp(parseInt(String((req.query && req.query.limit) || DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 10, MAX_LIMIT);

	const proto = (req.headers['x-forwarded-proto'] || 'https');
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	const baseUrl = proto + '://' + host;

	// Broader keywords to keep enough volume; ranking will prioritize the roles.
	const keywords = [
		'data analyst', 'analyst', 'business analyst', 'product analyst', 'decision scientist',
		'bi', 'business intelligence', 'analytics', 'analytics engineer',
		'data scientist', 'machine learning', 'ml engineer', 'data engineer'
	];
	const now = Date.now();
	const maxAgeMs = days * 24 * 60 * 60 * 1000;

	let jobs = [];

	// 1) RemoteOK JSON API (fast)
	const remoteOk = await fetchJson('https://remoteok.com/api');
	if (Array.isArray(remoteOk)) {
		for (let i = 0; i < remoteOk.length; i++) {
			const it = remoteOk[i];
			if (!it || !it.position || !it.url) continue;
			const full = (it.position + ' ' + (it.description || '') + ' ' + (Array.isArray(it.tags) ? it.tags.join(' ') : ''));
			if (!containsAny(full, keywords)) continue;
			const role = roleTierRank(it.position || '');
			const locScore = locationRank(it.location || 'Remote');
			jobs.push(normalizeJob({
				id: 'remoteok_' + it.id,
				title: it.position,
				company: it.company || 'Unknown',
				location: it.location || 'Remote',
				url: (String(it.url).startsWith('http') ? it.url : 'https://remoteok.com' + it.url),
				description: it.description || '',
				source: 'remoteok',
				date: it.date || nowIso(),
				tags: it.tags || [],
				_rank: role.score + locScore,
				_roleTier: role.tier
			}));
		}
	}

	// 2) Remotive public API (fast, but rate limited sometimes)
	const remotive = await fetchJson('https://remotive.com/api/remote-jobs?search=' + encodeURIComponent(q));
	const remotiveJobs = remotive && (remotive.jobs || remotive['remote-jobs'] || remotive.results);
	if (Array.isArray(remotiveJobs)) {
		for (let i = 0; i < remotiveJobs.length && i < 60; i++) {
			const it = remotiveJobs[i];
			if (!it || !it.title || !it.url) continue;
			const full = (it.title + ' ' + (it.description_plain || it.description || '') + ' ' + (Array.isArray(it.tags) ? it.tags.join(' ') : ''));
			if (!containsAny(full, keywords)) continue;
			const role = roleTierRank(it.title || '');
			const locScore = locationRank(it.candidate_required_location || it.location || 'Remote');
			jobs.push(normalizeJob({
				id: 'remotive_' + (it.id || Math.random()).toString().replace(/[^a-zA-Z0-9]/g, '_'),
				title: it.title,
				company: it.company_name || 'Unknown',
				location: it.candidate_required_location || 'Remote',
				url: it.url,
				description: it.description_plain || it.description || '',
				source: 'remotive',
				date: it.publication_date || it.created_at || nowIso(),
				tags: (it.tags || []).concat(it.category ? [it.category] : []),
				_rank: role.score + locScore,
				_roleTier: role.tier
			}));
		}
	}

	// 3) RSS sources (reliable, updated)
	const rssFeeds = [
		{ source: 'remotive', url: 'https://remotive.com/feed' },
		{ source: 'remotive', url: 'https://remotive.com/remote-jobs/feed/data' },
		{ source: 'remotive', url: 'https://remotive.com/remote-jobs/feed/ai-ml' },
		{ source: 'weworkremotely', url: 'https://weworkremotely.com/remote-jobs.rss' },
		{ source: 'jobscollider', url: 'https://jobscollider.com/remote-jobs.rss' },
		{ source: 'jobscollider', url: 'https://jobscollider.com/remote-data-jobs.rss' },
		{ source: 'remoteok', url: 'https://remoteok.io/remote-jobs.rss' },
		{ source: 'wellfound', url: 'https://wellfound.com/jobs.rss?keywords=data-science&remote=true' }
	];

	const rssResults = await Promise.allSettled(rssFeeds.map(async (f) => {
		const items = await fetchRss(baseUrl, f.url, 50);
		return { source: f.source, items };
	}));

	rssResults.forEach((r) => {
		if (!r || r.status !== 'fulfilled' || !r.value) return;
		const src = r.value.source;
		const items = r.value.items || [];
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			if (!it || !it.title || !it.link) continue;
			const full = (it.title + ' ' + (it.description || '') + ' ' + (it.content || ''));
			if (!containsAny(full, keywords)) continue;
			const role = roleTierRank(it.title || '');
			const locScore = locationRank('Remote');
			jobs.push(normalizeJob({
				id: src + '_rss_' + String(it.link || Math.random()).replace(/[^a-zA-Z0-9]/g, '_'),
				title: String(it.title || '').trim(),
				company: 'Unknown',
				location: 'Remote',
				url: it.link,
				description: it.description || '',
				source: src,
				date: it.pubDate || nowIso(),
				tags: ['rss'],
				_rank: role.score + locScore,
				_roleTier: role.tier
			}));
		}
	});

	// 4) WorkingNomads (public exposed API via our own proxy)
	const wn = await fetchJson(baseUrl + '/api/workingnomads?q=' + encodeURIComponent(q) + '&count=80');
	if (wn && wn.ok && Array.isArray(wn.jobs)) {
		wn.jobs.forEach((it) => {
			if (!it || !it.title || !it.url) return;
			const full = (it.title + ' ' + (it.description || ''));
			if (!containsAny(full, keywords)) return;
			const role = roleTierRank(it.title || '');
			const locScore = locationRank(it.location || 'Remote');
			jobs.push(normalizeJob({
				id: 'workingnomads_' + String(it.id || it.url).replace(/[^a-zA-Z0-9]/g, '_'),
				title: it.title,
				company: it.company || 'Unknown',
				location: it.location || 'Remote',
				url: it.url,
				description: it.description || '',
				source: 'workingnomads',
				date: it.date || nowIso(),
				tags: ['api'],
				_rank: role.score + locScore,
				_roleTier: role.tier
			}));
		});
	}

	// Freshness filter (last N days)
	jobs = jobs.filter((j) => {
		const dt = parseDateLike(j.date);
		if (!dt) return false;
		return (now - dt.getTime()) <= maxAgeMs;
	});

	// Deduplicate by URL
	const seen = new Set();
	jobs = jobs.filter((j) => {
		if (!j.url || seen.has(j.url)) return false;
		seen.add(j.url);
		return true;
	});

	// Sort: role/location priority first, then recency
	jobs.sort((a, b) => {
		const ra = typeof a._rank === 'number' ? a._rank : 0;
		const rb = typeof b._rank === 'number' ? b._rank : 0;
		if (rb !== ra) return rb - ra;
		const da = parseDateLike(a.date);
		const db = parseDateLike(b.date);
		const ta = da ? da.getTime() : 0;
		const tb = db ? db.getTime() : 0;
		return tb - ta;
	});

	jobs = jobs.slice(0, limit);

	return res.status(200).json({
		ok: true,
		query: q,
		days,
		count: jobs.length,
		sources: Array.from(new Set(jobs.map(j => j.source))).sort(),
		jobs
	});
};

