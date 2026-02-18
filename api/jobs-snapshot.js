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
const DEFAULT_LIMIT = 180;
const MAX_LIMIT = 400;
const TIMEOUT_MS = 12_000;
const RSS_TIMEOUT_MS = 15_000;

const USER_AGENT = 'Mozilla/5.0 (compatible; JobAggregator/1.0; +https://github.com)';

// Role priority (Remote primary, India secondary)
// Tier 1: analyst/BI/analytics roles (PRIMARY - 2-3 YOE level)
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
	'analytics analyst',
	'financial analyst',
	'marketing analyst',
	'operations analyst'
];
// Tier 2: junior/associate DS then ML (SECONDARY - still relevant)
const ROLE_TIER_2 = [
	'junior data scientist',
	'associate data scientist',
	'data scientist',
	'ml engineer',
	'machine learning engineer'
];
// Tier 3: Data Engineering (LOW PRIORITY - filter out or deprioritize)
const ROLE_TIER_3_EXCLUDE = [
	'data engineer',
	'senior data engineer',
	'big data engineer',
	'cloud data engineer',
	'etl engineer',
	'data infrastructure engineer'
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

/** Human-readable date (e.g. "17 Feb 2025") and relative time (e.g. "2 days ago") for display/filtering. */
function formatDateDisplay(dateInput) {
	const d = parseDateLike(dateInput);
	if (!d || isNaN(d.getTime())) return { dateFormatted: '', postedAgo: '' };
	const now = Date.now();
	const ms = now - d.getTime();
	const sec = Math.floor(ms / 1000);
	const min = Math.floor(sec / 60);
	const hr = Math.floor(min / 60);
	const day = Math.floor(hr / 24);
	const week = Math.floor(day / 7);
	const month = Math.floor(day / 30);
	const year = Math.floor(day / 365);
	let postedAgo = '';
	if (sec < 60) postedAgo = 'just now';
	else if (min < 60) postedAgo = min === 1 ? '1 minute ago' : min + ' minutes ago';
	else if (hr < 24) postedAgo = hr === 1 ? '1 hour ago' : hr + ' hours ago';
	else if (day < 7) postedAgo = day === 1 ? '1 day ago' : day + ' days ago';
	else if (week < 4) postedAgo = week === 1 ? '1 week ago' : week + ' weeks ago';
	else if (month < 12) postedAgo = month === 1 ? '1 month ago' : month + ' months ago';
	else postedAgo = year === 1 ? '1 year ago' : year + ' years ago';
	const dateFormatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
	return { dateFormatted, postedAgo };
}

function normalizeJob(j) {
	const rawDate = j.date || nowIso();
	const { dateFormatted, postedAgo } = formatDateDisplay(rawDate);
	return {
		id: j.id || ('job_' + Math.random().toString(36).slice(2)),
		title: j.title || 'Untitled',
		company: j.company || 'Unknown',
		location: j.location || 'Remote',
		url: j.url || '#',
		description: j.description || '',
		source: j.source || 'other',
		date: rawDate,
		dateFormatted: dateFormatted,
		postedAgo: postedAgo,
		tags: Array.isArray(j.tags) ? j.tags : [],
		// Optional scoring metadata (kept for debugging / future UI)
		_rank: typeof j._rank === 'number' ? j._rank : 0,
		_roleTier: j._roleTier || ''
	};
}

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
		if (!r.ok) return null;
		return await r.json();
	} catch (e) {
		return null;
	} finally {
		clearTimeout(t);
	}
}

// Hosts we're allowed to fetch RSS from directly (same as rss.js allowlist)
const RSS_ALLOWED_HOSTS = new Set([
	'remoteok.io', 'www.remoteok.io', 'remoteok.com', 'www.remoteok.com',
	'weworkremotely.com', 'www.weworkremotely.com',
	'remotive.com', 'www.remotive.com',
	'jobscollider.com', 'www.jobscollider.com',
	'wellfound.com', 'www.wellfound.com',
	'indeed.com', 'www.indeed.com', 'rss.indeed.com'
]);

function stripTag(xml, tag) {
	const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
	const m = String(xml || '').match(re);
	if (!m) return '';
	return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/** Fetch RSS/Atom feed directly and return items (no self-call to /api/rss). */
async function fetchRssDirect(feedUrl, count) {
	try {
		const u = new URL(feedUrl);
		if (!RSS_ALLOWED_HOSTS.has((u.hostname || '').toLowerCase())) return [];
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), RSS_TIMEOUT_MS);
		const r = await fetch(feedUrl, {
			signal: ctrl.signal,
			headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/atom+xml, text/xml, */*' }
		});
		clearTimeout(t);
		if (!r.ok) return [];
		const xml = await r.text();
		const items = [];
		const itemBlocks = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || xml.match(/<entry[^>]*>[\s\S]*?<\/entry>/gi) || [];
		for (let i = 0; i < Math.min(itemBlocks.length, count || 50); i++) {
			const block = itemBlocks[i];
			const title = stripTag(block, 'title');
			let link = stripTag(block, 'link');
			if (!link && block.includes('href=')) {
				const href = block.match(/href=["']([^"']+)["']/i);
				if (href) link = href[1];
			}
			const pubDate = stripTag(block, 'pubDate') || stripTag(block, 'published') || stripTag(block, 'updated') || stripTag(block, 'dc:date');
			if (title && link) items.push({ title, link, pubDate, description: stripTag(block, 'description') || stripTag(block, 'summary') });
		}
		return items;
	} catch (e) {
		return [];
	}
}

/** Fallback: fetch via our /api/rss when baseUrl is set (e.g. same deployment). */
async function fetchRss(baseUrl, feedUrl, count) {
	const u = baseUrl + '/api/rss?url=' + encodeURIComponent(feedUrl) + '&count=' + (count || 50);
	const data = await fetchJson(u, { timeout: RSS_TIMEOUT_MS });
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

function roleTierRank(title, description) {
	const t = String(title || '').toLowerCase();
	const desc = String(description || '').toLowerCase();
	const fullText = t + ' ' + desc;
	
	// Check for exclusion terms (Data Engineering) - penalize heavily
	const excludeHit = includesAnyPhrase(fullText, ROLE_TIER_3_EXCLUDE);
	if (excludeHit) {
		// Only include if ALSO mentions analyst/BI (hybrid roles)
		const hasAnalyst = /(analyst|analytics|bi|business intelligence)/.test(fullText);
		if (!hasAnalyst) {
			return { tier: 'excluded', score: -100, hit: excludeHit }; // Negative score = filter out
		}
		// Hybrid role - keep but lower priority
		return { tier: 'tier3', score: 30, hit: excludeHit };
	}
	
	const hit1 = includesAnyPhrase(t, ROLE_TIER_1);
	if (hit1) return { tier: 'tier1', score: 200, hit: hit1 };
	const hit2 = includesAnyPhrase(t, ROLE_TIER_2);
	if (hit2) return { tier: 'tier2', score: 120, hit: hit2 };
	// Generic analyst-ish hints
	if (/(^|\b)(analyst|analytics|bi|business intelligence)(\b|$)/.test(t)) return { tier: 'tier3', score: 60, hit: 'analytics' };
	return { tier: 'other', score: 0, hit: '' };
}

// Experience level filter (2-3 YOE focus)
function experienceLevelMatch(title, description) {
	const fullText = (String(title || '') + ' ' + String(description || '')).toLowerCase();
	
	// Look for experience requirements
	const expPatterns = [
		/\b(\d+)[\s-]+(?:to|-|–)[\s-]+(\d+)\s*(?:years?|yrs?|y\.o\.e\.)/i,  // "2-3 years"
		/\b(\d+)[\s-]+(?:to|-|–)[\s-]+(\d+)\s*(?:years?|yrs?)\s*(?:of|of\s+experience)/i,
		/\b(\d+)\s*(?:years?|yrs?|y\.o\.e\.)\s*(?:to|-|–)\s*(\d+)/i,
		/\b(\d+)\s*(?:years?|yrs?)\s*(?:to|-|–)\s*(\d+)/i
	];
	
	for (const pattern of expPatterns) {
		const match = fullText.match(pattern);
		if (match) {
			const min = parseInt(match[1], 10);
			const max = parseInt(match[2], 10);
			if (!isNaN(min) && !isNaN(max)) {
				// Check if range overlaps with 2-3 years
				if ((min <= 3 && max >= 2) || (min === 2 && max === 3) || (min <= 2 && max >= 3)) {
					return { match: true, score: 50, range: `${min}-${max}` }; // Bonus for matching range
				}
				// Also accept 1-4, 1-5 (includes 2-3)
				if (min <= 2 && max >= 3) {
					return { match: true, score: 30, range: `${min}-${max}` };
				}
			}
		}
	}
	
	// Check for single number patterns
	const singlePatterns = [
		/\b(2|3)\s*(?:years?|yrs?|y\.o\.e\.)\s*(?:of|of\s+)?experience/i,
		/\b(2|3)\s*(?:years?|yrs?)\s*(?:minimum|min|required)/i
	];
	for (const pattern of singlePatterns) {
		if (pattern.test(fullText)) {
			return { match: true, score: 40 };
		}
	}
	
	// Check for "mid-level", "mid level", "2+", "3+"
	if (/\b(mid[- ]?level|mid[- ]?senior)\b/i.test(fullText)) {
		return { match: true, score: 25 };
	}
	if (/\b(2\+|3\+|2-3|3-5)\s*(?:years?|yrs?)/i.test(fullText)) {
		return { match: true, score: 35 };
	}
	
	// No explicit experience requirement = neutral (don't filter out)
	return { match: true, score: 0 };
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
	const baseUrl = (host && (proto + '://' + host)) || '';

	// Focused keywords - prioritize analyst/BI, exclude pure data engineering
	const keywords = [
		'data analyst', 'analyst', 'business analyst', 'product analyst', 'decision scientist',
		'bi', 'business intelligence', 'analytics', 'analytics engineer',
		'data scientist', 'machine learning', 'ml engineer',
		// Note: 'data engineer' removed from keywords - will be filtered out unless hybrid role
		'data', 'remote'
	];
	const now = Date.now();
	const maxAgeMs = days * 24 * 60 * 60 * 1000;

	let jobs = [];
	
	// Try to load cached headless-scraped jobs from KV (if available)
	let cachedHeadlessJobs = [];
	if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
		try {
			const { kv } = require('@vercel/kv');
			const cached = await kv.get('jobs:scraped:all');
			if (cached && cached.jobs && Array.isArray(cached.jobs)) {
				cachedHeadlessJobs = cached.jobs;
			}
		} catch (e) { /* KV optional */ }
	}

	// 1) RemoteOK JSON API (fast) — API returns array; first element can be metadata
	const remoteOk = await fetchJson('https://remoteok.com/api');
	const remoteOkList = Array.isArray(remoteOk)
		? remoteOk
		: (remoteOk && Array.isArray(remoteOk.jobs) ? remoteOk.jobs : []);
	for (let i = 0; i < remoteOkList.length; i++) {
		const it = remoteOkList[i];
		if (!it || typeof it !== 'object' || !it.position || !it.url) continue;
			const full = (it.position + ' ' + (it.description || '') + ' ' + (Array.isArray(it.tags) ? it.tags.join(' ') : ''));
			if (!containsAny(full, keywords)) continue;
			const role = roleTierRank(it.position || '', it.description || '');
			if (role.score < 0) continue; // Filter out excluded roles (Data Engineering)
			const expMatch = experienceLevelMatch(it.position || '', it.description || '');
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
				_rank: role.score + locScore + expMatch.score,
				_roleTier: role.tier
			}));
	}

	// 2) Remotive public API (fast, but rate limited sometimes)
	const remotive = await fetchJson('https://remotive.com/api/remote-jobs?search=' + encodeURIComponent(q));
	const remotiveJobs = remotive && (remotive.jobs || remotive['remote-jobs'] || remotive.results);
	if (Array.isArray(remotiveJobs)) {
		for (let i = 0; i < Math.min(remotiveJobs.length, 80); i++) {
			const it = remotiveJobs[i];
			if (!it || !it.title || !it.url) continue;
			const full = (it.title + ' ' + (it.description_plain || it.description || '') + ' ' + (Array.isArray(it.tags) ? it.tags.join(' ') : ''));
			if (!containsAny(full, keywords)) continue;
			const role = roleTierRank(it.title || '', it.description_plain || it.description || '');
			if (role.score < 0) continue; // Filter out excluded roles
			const expMatch = experienceLevelMatch(it.title || '', it.description_plain || it.description || '');
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
				_rank: role.score + locScore + expMatch.score,
				_roleTier: role.tier
			}));
		}
	}

	// 3) RSS sources — fetch directly (no self-call) so we always get multiple sources
	const rssFeeds = [
		{ source: 'remotive', url: 'https://remotive.com/feed' },
		{ source: 'remotive', url: 'https://remotive.com/remote-jobs/feed/data' },
		{ source: 'remotive', url: 'https://remotive.com/remote-jobs/feed/ai-ml' },
		{ source: 'weworkremotely', url: 'https://weworkremotely.com/remote-jobs.rss' },
		{ source: 'jobscollider', url: 'https://jobscollider.com/remote-jobs.rss' },
		{ source: 'jobscollider', url: 'https://jobscollider.com/remote-data-jobs.rss' },
		{ source: 'remoteok', url: 'https://remoteok.com/remote-jobs.rss' },
		{ source: 'remoteok', url: 'https://remoteok.io/remote-jobs.rss' },
		{ source: 'wellfound', url: 'https://wellfound.com/jobs.rss?keywords=data-science&remote=true' },
		{ source: 'wellfound', url: 'https://wellfound.com/jobs.rss?keywords=data-analyst&remote=true' },
		{ source: 'wellfound', url: 'https://wellfound.com/jobs.rss?keywords=business-intelligence&remote=true' },
		{ source: 'indeed', url: 'https://rss.indeed.com/rss?q=data+analyst&l=remote&radius=0' },
		{ source: 'indeed', url: 'https://rss.indeed.com/rss?q=data+scientist&l=remote&radius=0' }
	];

	const rssResults = await Promise.allSettled(rssFeeds.map(async (f) => {
		try {
			const items = await fetchRssDirect(f.url, 50);
			return { source: f.source, items, url: f.url };
		} catch (e) {
			return { source: f.source, items: [], error: e.message, url: f.url };
		}
	}));

	const rssErrors = [];
	rssResults.forEach((r) => {
		if (!r || r.status !== 'fulfilled' || !r.value) {
			rssErrors.push({ source: 'unknown', error: r && r.reason ? r.reason.message : 'Failed' });
			return;
		}
		const src = r.value.source;
		const items = r.value.items || [];
		if (r.value.error) {
			rssErrors.push({ source: src, error: r.value.error, url: r.value.url });
		}
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			if (!it || !it.title || !it.link) continue;
			const full = (it.title + ' ' + (it.description || '') + ' ' + (it.content || ''));
			if (!containsAny(full, keywords)) continue;
			const role = roleTierRank(it.title || '', it.description || it.content || '');
			if (role.score < 0) continue; // Filter out excluded roles
			const expMatch = experienceLevelMatch(it.title || '', it.description || it.content || '');
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
				_rank: role.score + locScore + expMatch.score,
				_roleTier: role.tier
			}));
		}
	});

	// 4) WorkingNomads (public exposed API via our own proxy)
	const wn = baseUrl
		? await fetchJson(baseUrl + '/api/workingnomads?q=' + encodeURIComponent(q) + '&count=80')
		: null;
		if (wn && wn.ok && Array.isArray(wn.jobs)) {
		wn.jobs.forEach((it) => {
			if (!it || !it.title || !it.url) return;
			const full = (it.title + ' ' + (it.description || ''));
			if (!containsAny(full, keywords)) return;
			const role = roleTierRank(it.title || '', it.description || '');
			if (role.score < 0) return; // Filter out excluded roles
			const expMatch = experienceLevelMatch(it.title || '', it.description || '');
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
				_rank: role.score + locScore + expMatch.score,
				_roleTier: role.tier
			}));
		});
	}

	// 5) Headless browser (WeWorkRemotely) — only when ENABLE_HEADLESS=1; runs in parallel with short timeout
	const headlessEnabled = String(process.env.ENABLE_HEADLESS || '').trim() === '1';
	if (headlessEnabled && baseUrl) {
		try {
			const headlessPromise = fetchJson(baseUrl + '/api/headless-scrape-weworkremotely', { timeout: 22_000 });
			const headless = await Promise.race([headlessPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 22_000))]);
			if (headless && headless.ok && Array.isArray(headless.jobs)) {
				headless.jobs.forEach((it) => {
					if (!it || !it.title || !it.url) return;
					const full = (it.title + ' ' + (it.description || ''));
					if (!containsAny(full, keywords)) return;
					const role = roleTierRank(it.title || '', it.description || '');
					if (role.score < 0) return; // Filter out excluded roles
					const expMatch = experienceLevelMatch(it.title || '', it.description || '');
					jobs.push(normalizeJob({
						id: 'weworkremotely_headless_' + String(it.url || Math.random()).replace(/[^a-zA-Z0-9]/g, '_'),
						title: it.title,
						company: 'Unknown',
						location: 'Remote',
						url: it.url,
						description: it.description || '',
						source: 'weworkremotely_headless',
						date: nowIso(),
						tags: ['headless'],
						_rank: role.score + 120 + expMatch.score,
						_roleTier: role.tier
					}));
				});
			}
		} catch (e) { /* headless optional */ }
		
		// 6) Multi-site headless scraper (Hirist, Naukri — mainstream India boards)
		try {
			const multiPromise = fetchJson(baseUrl + '/api/headless-scrape-multi?site=all&q=' + encodeURIComponent(q), { timeout: 35_000 });
			const multi = await Promise.race([multiPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 35_000))]);
			if (multi && multi.ok && Array.isArray(multi.jobs)) {
				multi.jobs.forEach((it) => {
					if (!it || !it.title || !it.url) return;
					const full = (it.title + ' ' + (it.company || '') + ' ' + (it.location || '') + ' ' + (it.description || ''));
					if (!containsAny(full, keywords)) return;
					const role = roleTierRank(it.title || '', it.description || '');
					if (role.score < 0) return; // Filter out excluded roles
					const expMatch = experienceLevelMatch(it.title || '', it.description || '');
					const locScore = locationRank(it.location || 'India');
					jobs.push(normalizeJob({
						id: (it.source || 'headless') + '_' + String(it.url || Math.random()).replace(/[^a-zA-Z0-9]/g, '_'),
						title: it.title,
						company: it.company || 'Unknown',
						location: it.location || 'India',
						url: it.url,
						description: it.description || '',
						source: it.source || 'headless_multi',
						date: it.date || nowIso(),
						tags: ['headless'],
						_rank: role.score + locScore + expMatch.score,
						_roleTier: role.tier
					}));
				});
			}
		} catch (e) { /* multi-scraper optional */ }
		
		// 6b) Indeed headless (mainstream global board — no public API)
		try {
			const indeedPromise = fetchJson(baseUrl + '/api/headless-scrape-indeed?q=' + encodeURIComponent(q) + '&l=remote', { timeout: 20_000 });
			const indeed = await Promise.race([indeedPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20_000))]);
			if (indeed && indeed.ok && Array.isArray(indeed.jobs)) {
				indeed.jobs.forEach((it) => {
					if (!it || !it.title || !it.url) return;
					const full = (it.title + ' ' + (it.company || '') + ' ' + (it.location || '') + ' ' + (it.description || ''));
					if (!containsAny(full, keywords)) return;
					const role = roleTierRank(it.title || '', it.description || '');
					if (role.score < 0) return; // Filter out excluded roles
					const expMatch = experienceLevelMatch(it.title || '', it.description || '');
					const locScore = locationRank(it.location || 'Remote');
					jobs.push(normalizeJob({
						id: 'indeed_headless_' + String(it.url || Math.random()).replace(/[^a-zA-Z0-9]/g, '_'),
						title: it.title,
						company: it.company || 'Unknown',
						location: it.location || 'Remote',
						url: it.url,
						description: it.description || '',
						source: 'indeed_headless',
						date: nowIso(),
						tags: ['headless'],
						_rank: role.score + locScore + expMatch.score,
						_roleTier: role.tier
					}));
				});
			}
		} catch (e) { /* Indeed may block/throttle; optional */ }
		
		// 6c) LinkedIn headless (mainstream global board — no public API, may block bots)
		try {
			const linkedinPromise = fetchJson(baseUrl + '/api/headless-scrape-linkedin?q=' + encodeURIComponent(q) + '&location=remote&experience=2,3', { timeout: 25_000 });
			const linkedin = await Promise.race([linkedinPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25_000))]);
			if (linkedin && linkedin.ok && Array.isArray(linkedin.jobs)) {
				linkedin.jobs.forEach((it) => {
					if (!it || !it.title || !it.url) return;
					const full = (it.title + ' ' + (it.company || '') + ' ' + (it.location || '') + ' ' + (it.description || ''));
					if (!containsAny(full, keywords)) return;
					const role = roleTierRank(it.title || '', it.description || '');
					if (role.score < 0) return; // Filter out excluded roles
					const expMatch = experienceLevelMatch(it.title || '', it.description || '');
					const locScore = locationRank(it.location || 'Remote');
					jobs.push(normalizeJob({
						id: 'linkedin_headless_' + String(it.url || Math.random()).replace(/[^a-zA-Z0-9]/g, '_'),
						title: it.title,
						company: it.company || 'Unknown',
						location: it.location || 'Remote',
						url: it.url,
						description: it.description || '',
						source: 'linkedin_headless',
						date: it.date || nowIso(),
						tags: ['headless'],
						_rank: role.score + locScore + expMatch.score,
						_roleTier: role.tier
					}));
				});
			}
		} catch (e) { /* LinkedIn blocks/throttles aggressively; optional */ }
	}
	
	// 7) Add cached headless jobs from KV (if available) — faster than live scraping
	if (cachedHeadlessJobs.length > 0) {
		cachedHeadlessJobs.forEach((it) => {
			if (!it || !it.title || !it.url) return;
			const full = (it.title + ' ' + (it.company || '') + ' ' + (it.location || '') + ' ' + (it.description || ''));
			if (!containsAny(full, keywords)) return;
			const role = roleTierRank(it.title || '', it.description || '');
			if (role.score < 0) return; // Filter out excluded roles
			const expMatch = experienceLevelMatch(it.title || '', it.description || '');
			const locScore = locationRank(it.location || 'India');
			jobs.push(normalizeJob({
				id: (it.source || 'cached') + '_' + String(it.url || Math.random()).replace(/[^a-zA-Z0-9]/g, '_'),
				title: it.title,
				company: it.company || 'Unknown',
				location: it.location || 'India',
				url: it.url,
				description: it.description || '',
				source: it.source || 'cached_headless',
				date: it.date || nowIso(),
				tags: ['cached'],
				_rank: role.score + locScore + expMatch.score,
				_roleTier: role.tier
			}));
		});
	}

	// Filter out excluded roles (Data Engineering) - jobs with negative scores already filtered, but double-check
	jobs = jobs.filter((j) => {
		if (j._rank < 0) return false; // Excluded roles
		return true;
	});

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

	const sources = Array.from(new Set(jobs.map(j => j.source))).sort();
	const sourceCounts = {};
	jobs.forEach((j) => { sourceCounts[j.source] = (sourceCounts[j.source] || 0) + 1; });

	// Collect errors for debugging
	const errors = [];
	if (rssErrors && rssErrors.length > 0) {
		errors.push(...rssErrors.map(e => ({ type: 'rss', source: e.source, error: e.error, url: e.url })));
	}

	return res.status(200).json({
		ok: true,
		query: q,
		days,
		limit,
		count: jobs.length,
		sources,
		sourceCounts,
		jobs,
		...(errors.length > 0 ? { _errors: errors } : {})
	});
};

