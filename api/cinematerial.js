/**
 * CineMaterial poster scraper — builds URL from IMDb ID (from OMDb), fetches page, returns poster image URLs.
 * No API key; scrapes the public list page. Use sparingly and respect the site's terms.
 *
 * Query: i=tt1375666 (imdbID), title=Inception (for slug), type=movie|series
 * Optional: width=300 (hint for image size in response; scraping returns what the page has)
 */

const BASE = 'https://www.cinematerial.com';

function slugify(s) {
	if (typeof s !== 'string') return '';
	return s
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || 'title';
}

function buildPageUrl(imdbId, title, type) {
	const id = String(imdbId || '').replace(/^tt/i, '');
	if (!/^\d+$/.test(id)) return null;
	const slug = slugify(title || 'title');
	const path = type === 'series' ? 'tv' : 'movies';
	return BASE + '/' + path + '/' + slug + '-i' + id;
}

function extractImageUrls(html, baseUrl) {
	const urls = [];
	const srcRegex = /<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi;
	let m;
	while ((m = srcRegex.exec(html)) !== null) {
		let u = m[1].trim();
		if (u.startsWith('//')) u = 'https:' + u;
		else if (u.startsWith('/')) u = BASE + u;
		if (!u.startsWith('http')) continue;
		if (u.includes('cinematerial.com') || /\.(jpe?g|png|webp)(\?|$)/i.test(u)) {
			urls.push(u);
		}
	}
	// Also catch links to poster pages that contain image URLs
	const hrefRegex = /href=["'](\/[^"']*\/p\/[^"']+)["']/gi;
	while ((m = hrefRegex.exec(html)) !== null) {
		const path = m[1].trim();
		if (path.includes('/p/')) urls.push({ posterPage: BASE + path });
	}
	const posterPages = urls.filter(function (x) { return typeof x === 'object' && x.posterPage; });
	const direct = urls.filter(function (x) { return typeof x === 'string'; });
	const seen = new Set();
	const unique = direct.filter(function (u) {
		const k = u.replace(/\?.*$/, '');
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	return { images: unique, posterPages: posterPages.map(function (p) { return p.posterPage; }) };
}

module.exports = async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
	if (req.method === 'OPTIONS') {
		res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
		res.setHeader('Access-Control-Max-Age', '86400');
		return res.status(204).end();
	}
	if (req.method !== 'GET') {
		return res.status(405).json({ error: 'Method not allowed', posters: [] });
	}

	const imdbId = typeof req.query.i === 'string' ? req.query.i.trim() : '';
	const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
	const type = (req.query.type === 'series' || req.query.type === 'movie') ? req.query.type : 'movie';

	if (!/^tt\d+$/.test(imdbId)) {
		return res.status(400).json({
			error: 'Missing or invalid IMDb ID. Use i=tt1375666 (from OMDb).',
			posters: [],
			pageUrl: null
		});
	}

	const pageUrl = buildPageUrl(imdbId, title, type);
	if (!pageUrl) {
		return res.status(400).json({ error: 'Could not build CineMaterial URL.', posters: [], pageUrl: null });
	}

	try {
		const r = await fetch(pageUrl, {
			headers: {
				'User-Agent': 'OMDb-Proxy/1.0 (personal project; +https://github.com)',
				'Accept': 'text/html'
			},
			redirect: 'follow'
		});
		const html = await r.text();
		if (!r.ok) {
			return res.status(200).json({
				error: 'CineMaterial page returned ' + r.status,
				posters: [],
				pageUrl: pageUrl,
				sourceUrl: pageUrl
			});
		}
		const { images, posterPages } = extractImageUrls(html, pageUrl);
		return res.status(200).json({
			posters: images.map(function (url) { return { url: url }; }),
			posterPages: posterPages,
			pageUrl: pageUrl,
			sourceUrl: pageUrl
		});
	} catch (e) {
		return res.status(502).json({
			error: 'Failed to fetch CineMaterial: ' + (e.message || 'network error'),
			posters: [],
			pageUrl: pageUrl,
			sourceUrl: pageUrl
		});
	}
};
