/**
 * CineMaterial poster scraper — builds URL from IMDb ID (from OMDb), fetches page, returns poster image URLs.
 * No API key; scrapes the public list page. Use sparingly and respect the site's terms.
 *
 * Query: i=tt1375666 (imdbID), title=Inception (for slug), type=movie|series
 */

const BASE = 'https://www.cinematerial.com';
const MAX_POSTER_PAGES = 12;
const MAX_POSTERS = 40;

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

function normalizeUrl(u) {
	if (!u || typeof u !== 'string') return null;
	let out = u.trim();
	if (!out) return null;
	if (out.startsWith('//')) out = 'https:' + out;
	else if (out.startsWith('/')) out = BASE + out;
	if (!out.startsWith('http')) return null;
	return out;
}

function isCdnPosterUrl(u) {
	if (!u || typeof u !== 'string') return false;
	return u.indexOf('https://cdn.cinematerial.com/') === 0 && /\/p\//.test(u);
}

function upgradeSize(u) {
	if (!u || typeof u !== 'string') return u;
	// Upgrade thumbnail (e.g. /p/136x/...-sm.jpg -> /p/297x/...-md.jpg)
	if (u.indexOf('https://cdn.cinematerial.com/') === 0 && /\/p\/\d+x\//.test(u)) {
		return u.replace(/\/p\/\d+x\//, '/p/297x/').replace(/-sm(\.[a-z0-9]+)(\?|$)/i, '-md$1$2');
	}
	return u;
}

function uniqLimit(list, limit) {
	const seen = new Set();
	const out = [];
	for (let i = 0; i < list.length; i++) {
		const u = list[i];
		if (!u) continue;
		const k = u.replace(/\?.*$/, '');
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(u);
		if (out.length >= limit) break;
	}
	return out;
}

function extractPosterPages(html) {
	// Poster pages: /movies/.../p/<id> or /tv/.../p/<id>
	const pages = [];
	try {
		const hrefRegex = /href=["'](\/(?:movies|tv)\/[^"']*\/p\/[^"']+)["']/gi;
		let m;
		while ((m = hrefRegex.exec(html)) !== null) {
			const path = m[1].trim();
			if (!path || path.indexOf('/p/') === -1) continue;
			const full = BASE + path;
			pages.push(full);
		}
	} catch (e) {}
	return uniqLimit(pages, MAX_POSTER_PAGES);
}

function extractDirectCdnImages(html) {
	const urls = [];

	// JSON-LD sometimes includes the primary poster
	try {
		const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
		if (ldMatch && ldMatch[1]) {
			let jsonText = ldMatch[1].trim();
			jsonText = jsonText.replace(/^\s*<!--/, '').replace(/-->\s*$/, '');
			const data = JSON.parse(jsonText);
			const img = (data && typeof data.image === 'string') ? data.image.trim() : '';
			const n = normalizeUrl(img);
			if (n && isCdnPosterUrl(n)) urls.push(upgradeSize(n));
		}
	} catch (e) {}

	// Common: <img data-src="https://cdn.cinematerial.com/p/...">
	try {
		const imgRegex = /<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi;
		let m;
		while ((m = imgRegex.exec(html)) !== null) {
			const n = normalizeUrl(m[1]);
			if (n && isCdnPosterUrl(n)) urls.push(upgradeSize(n));
		}
	} catch (e) {}

	return uniqLimit(urls, MAX_POSTERS);
}

function extractCdnFromPosterPage(html) {
	const urls = [];

	// Prefer OpenGraph image
	try {
		const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
		if (og && og[1]) {
			const n = normalizeUrl(og[1]);
			if (n && isCdnPosterUrl(n)) urls.push(upgradeSize(n));
		}
	} catch (e) {}

	// Fallback: scan images on the poster page
	try {
		const imgRegex = /<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi;
		let m;
		while ((m = imgRegex.exec(html)) !== null) {
			const n = normalizeUrl(m[1]);
			if (n && isCdnPosterUrl(n)) urls.push(upgradeSize(n));
		}
	} catch (e) {}

	return uniqLimit(urls, 8);
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

		// 1) Try to extract direct CDN poster URLs from list page.
		let posters = extractDirectCdnImages(html);

		// 2) If list page doesn't embed posters anymore, follow a few /p/... poster pages.
		const posterPages = extractPosterPages(html);
		if ((!posters || posters.length === 0) && posterPages.length) {
			const pageHtmls = await Promise.all(
				posterPages.map(function (u) {
					return fetch(u, {
						headers: {
							'User-Agent': 'OMDb-Proxy/1.0 (personal project; +https://github.com)',
							'Accept': 'text/html'
						},
						redirect: 'follow'
					})
						.then(function (rr) { return rr.ok ? rr.text() : ''; })
						.catch(function () { return ''; });
				})
			);
			let found = [];
			for (let i = 0; i < pageHtmls.length; i++) {
				if (!pageHtmls[i]) continue;
				found = found.concat(extractCdnFromPosterPage(pageHtmls[i]));
				if (found.length >= MAX_POSTERS) break;
			}
			posters = uniqLimit(found, MAX_POSTERS);
		}

		return res.status(200).json({
			posters: (posters || []).map(function (url) { return { url: url }; }),
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
