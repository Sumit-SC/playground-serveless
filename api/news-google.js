/**
 * Simple Google News headlines API for Trends page.
 * Fetches the RSS feed for a given region and returns a small JSON payload.
 *
 * GET /api/news-google?region=US|IN&count=10
 *
 * This is intentionally narrower than the generic /api/rss proxy and only
 * talks to news.google.com with a fixed query pattern.
 */

const DEFAULT_COUNT = 10;
const MAX_COUNT = 25;
const TIMEOUT_MS = 10_000;

function buildFeedUrl(region) {
	const r = (region || 'US').toUpperCase() === 'IN' ? 'IN' : 'US';
	if (r === 'IN') {
		return 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en';
	}
	return 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
}

function stripCdata(s) {
	if (!s) return '';
	return String(s).replace(/^<!\[CDATA\[(.*)\]\]>$/s, '$1').trim();
}

function decodeBasicEntities(s) {
	if (!s) return '';
	return String(s)
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function stripTags(html) {
	if (!html) return '';
	return String(html)
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractFirst(text, tag) {
	if (!text) return '';
	const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
	const m = String(text).match(re);
	return m ? m[1] : '';
}

function extractAllBlocks(text, tag) {
	if (!text) return [];
	const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
	const out = [];
	let m;
	while ((m = re.exec(String(text)))) out.push(m[1]);
	return out;
}

function parseRss(xml, count) {
	const channelTitle = decodeBasicEntities(stripCdata(extractFirst(xml, 'title')));
	const items = extractAllBlocks(xml, 'item').slice(0, count).map(function (itemXml) {
		const title = decodeBasicEntities(stripCdata(extractFirst(itemXml, 'title')));
		const link = decodeBasicEntities(stripCdata(extractFirst(itemXml, 'link')));
		const pubDate = decodeBasicEntities(stripCdata(extractFirst(itemXml, 'pubDate')));
		const descRaw = extractFirst(itemXml, 'description');
		const desc = decodeBasicEntities(stripCdata(descRaw));
		return {
			title,
			link,
			pubDate,
			summary: stripTags(desc).slice(0, 260)
		};
	});
	return { title: channelTitle, items };
}

async function fetchWithTimeout(url) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, {
			method: 'GET',
			headers: {
				'User-Agent': 'sumit-personal-site news proxy',
				'Accept': 'application/rss+xml, application/xml, text/xml, */*'
			},
			signal: ctrl.signal
		});
	} finally {
		clearTimeout(t);
	}
}

module.exports = async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');

	if (req.method === 'OPTIONS') return res.status(200).end();

	const region = (req.query && req.query.region) ? String(req.query.region) : 'US';
	let count = DEFAULT_COUNT;
	if (req.query && req.query.count != null) {
		const n = parseInt(String(req.query.count), 10);
		if (!isNaN(n)) count = Math.max(1, Math.min(MAX_COUNT, n));
	}

	const feedUrl = buildFeedUrl(region);

	try {
		const r = await fetchWithTimeout(feedUrl);
		if (!r.ok) {
			return res.status(502).json({ ok: false, error: 'Fetch failed', status: r.status });
		}
		const xml = await r.text();
		const parsed = parseRss(xml, count);
		return res.status(200).json({
			ok: true,
			region: (region || 'US').toUpperCase(),
			feedUrl,
			title: parsed.title || '',
			count: parsed.items.length,
			items: parsed.items
		});
	} catch (e) {
		return res.status(500).json({
			ok: false,
			error: 'Failed to fetch or parse Google News RSS',
			message: e && e.message ? e.message : String(e)
		});
	}
};

